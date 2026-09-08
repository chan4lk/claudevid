import { createCanvas } from "@napi-rs/canvas";
import type { ImageLayer } from "@claudevid/core";
import { describe, expect, it } from "vitest";
import { computeFitRect, paintImageLayer } from "../src/draw-image.js";
import { createRasterCache } from "../src/raster-cache.js";

describe("computeFitRect — fill", () => {
  it("always uses the full box as the dest rect, regardless of aspect ratio mismatch", () => {
    const rect = computeFitRect(100, 50, 40, 40, "fill");
    expect(rect).toEqual({ sx: 0, sy: 0, sw: 100, sh: 50, dx: 0, dy: 0, dw: 40, dh: 40 });
  });

  it("uses the full box even when the image is much taller than the box", () => {
    const rect = computeFitRect(20, 200, 300, 30, "fill");
    expect(rect.dx).toBe(0);
    expect(rect.dy).toBe(0);
    expect(rect.dw).toBe(300);
    expect(rect.dh).toBe(30);
  });
});

describe("computeFitRect — contain", () => {
  it("scales the dest rect to fit entirely within the box and centers it (letterboxed)", () => {
    // 2:1 image into a 1:1 box -> width-constrained, letterboxed top/bottom.
    const rect = computeFitRect(200, 100, 100, 100, "contain");

    expect(rect.dw).toBeLessThanOrEqual(100);
    expect(rect.dh).toBeLessThanOrEqual(100);
    expect(rect.dw).toBe(100);
    expect(rect.dh).toBe(50);

    const bottomMargin = 100 - rect.dh - rect.dy;
    expect(rect.dy).toBeCloseTo(bottomMargin, 10);

    const rightMargin = 100 - rect.dw - rect.dx;
    expect(rect.dx).toBeCloseTo(rightMargin, 10);
  });

  it("produces no letterboxing when the box aspect ratio matches the image", () => {
    const rect = computeFitRect(80, 40, 160, 80, "contain");
    expect(rect.dw).toBe(160);
    expect(rect.dh).toBe(80);
    expect(rect.dx).toBe(0);
    expect(rect.dy).toBe(0);
  });
});

describe("computeFitRect — cover", () => {
  it("fills the whole box and crops a sub-region of the source that never exceeds image dimensions", () => {
    const imgWidth = 200;
    const imgHeight = 100;
    const rect = computeFitRect(imgWidth, imgHeight, 100, 100, "cover");

    expect(rect.dx).toBe(0);
    expect(rect.dy).toBe(0);
    expect(rect.dw).toBe(100);
    expect(rect.dh).toBe(100);

    expect(rect.sx).toBeGreaterThanOrEqual(0);
    expect(rect.sy).toBeGreaterThanOrEqual(0);
    expect(rect.sw).toBeLessThanOrEqual(imgWidth);
    expect(rect.sh).toBeLessThanOrEqual(imgHeight);
    expect(rect.sx + rect.sw).toBeLessThanOrEqual(imgWidth);
    expect(rect.sy + rect.sh).toBeLessThanOrEqual(imgHeight);
  });
});

describe("paintImageLayer — synthetic image round-trip", () => {
  /** A tiny solid-color source image, built in-memory and round-tripped through `loadImage` as a
   * data: URL — no checked-in binary asset needed. Each call makes a *distinct* src (the fill
   * color is baked in), so tests never collide in `decodeCache`/`RasterCache` keyspace. */
  function syntheticSrc(color: string): string {
    const source = createCanvas(4, 4);
    const sourceCtx = source.getContext("2d");
    sourceCtx.fillStyle = color;
    sourceCtx.fillRect(0, 0, 4, 4);
    return `data:image/png;base64,${source.toBuffer("image/png").toString("base64")}`;
  }

  it("decodes a synthetic PNG buffer (as a data URL) and rasterizes it into a box-sized bitmap", async () => {
    const layer: ImageLayer = { type: "image", src: syntheticSrc("#0000ff"), width: 8, height: 8, fit: "fill" };

    const bitmap = await paintImageLayer(createRasterCache(1024 * 1024), layer);

    // The returned bitmap is the layer's box, not the source's natural size — that equivalence is
    // what lets the renderer use `bitmap.width/height` as the motion transform's pivot.
    expect(bitmap.width).toBe(8);
    expect(bitmap.height).toBe(8);

    const data = bitmap.data();
    const offset = (4 * bitmap.width + 4) * 4;
    expect([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]]).toEqual([0, 0, 255, 255]);
  });

  it("falls back to the source's natural size when the layer declares no box", async () => {
    const layer: ImageLayer = { type: "image", src: syntheticSrc("#00ff00") };

    const bitmap = await paintImageLayer(createRasterCache(1024 * 1024), layer);

    expect(bitmap.width).toBe(4);
    expect(bitmap.height).toBe(4);
  });

  it("bakes contain's letterbox offset into the bitmap rather than leaving it to the caller", async () => {
    // 1:1 source into a 2:1 box -> height-constrained, transparent bars left and right.
    const layer: ImageLayer = { type: "image", src: syntheticSrc("#ff0000"), width: 16, height: 8, fit: "contain" };

    const bitmap = await paintImageLayer(createRasterCache(1024 * 1024), layer);
    const data = bitmap.data();
    const pixelAt = (x: number, y: number) => {
      const offset = (y * bitmap.width + x) * 4;
      return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
    };

    expect(pixelAt(8, 4)).toEqual([255, 0, 0, 255]); // centre: the image
    expect(pixelAt(0, 4)[3]).toBe(0); // left bar: transparent letterbox, inside the bitmap
  });

  it("re-rasterizes once per (src, box, fit) and hits the cache thereafter", async () => {
    // The point of the cache: the source->box resample is the real per-frame cost, so repainting
    // the same layer across frames must not repeat it.
    const cache = createRasterCache(1024 * 1024);
    const layer: ImageLayer = { type: "image", src: syntheticSrc("#ff00ff"), width: 8, height: 8, fit: "fill" };

    await paintImageLayer(cache, layer);
    expect(cache.stats()).toMatchObject({ misses: 1, hits: 0 });

    for (let frame = 0; frame < 5; frame++) await paintImageLayer(cache, layer);
    expect(cache.stats()).toMatchObject({ misses: 1, hits: 5 });
  });

  it("keys on the box and fit, so the same source at a different size is a separate entry", async () => {
    const cache = createRasterCache(1024 * 1024);
    const src = syntheticSrc("#ffff00");

    await paintImageLayer(cache, { type: "image", src, width: 8, height: 8, fit: "fill" });
    await paintImageLayer(cache, { type: "image", src, width: 16, height: 16, fit: "fill" });
    await paintImageLayer(cache, { type: "image", src, width: 8, height: 8, fit: "contain" });
    expect(cache.stats()).toMatchObject({ misses: 3, hits: 0 });

    // ...and the first one is still cached, not evicted by the others.
    await paintImageLayer(cache, { type: "image", src, width: 8, height: 8, fit: "fill" });
    expect(cache.stats()).toMatchObject({ misses: 3, hits: 1 });
  });
});
