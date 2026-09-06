import { createCanvas } from "@napi-rs/canvas";
import type { ImageLayer } from "@claudevid/core";
import { describe, expect, it } from "vitest";
import { computeFitRect, paintImageLayer } from "../src/draw-image.js";

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
  it("decodes a synthetic PNG buffer (as a data URL) and draws it into the target context", async () => {
    // Build a tiny solid-color source image entirely in-memory, then round-trip it
    // through loadImage as a data: URL — no checked-in binary asset needed.
    const source = createCanvas(4, 4);
    const sourceCtx = source.getContext("2d");
    sourceCtx.fillStyle = "#0000ff";
    sourceCtx.fillRect(0, 0, 4, 4);
    const pngBuffer = source.toBuffer("image/png");
    const dataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;

    const layer: ImageLayer = {
      type: "image",
      src: dataUrl,
      width: 8,
      height: 8,
      fit: "fill",
    };

    const target = createCanvas(8, 8);
    const targetCtx = target.getContext("2d");

    await expect(paintImageLayer(targetCtx, layer, 0, 0)).resolves.toBeUndefined();

    const data = target.data();
    // Center pixel of the scaled-up fill should be the source's solid blue.
    const offset = (4 * target.width + 4) * 4;
    expect([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]]).toEqual([0, 0, 255, 255]);
  });
});
