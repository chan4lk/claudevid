import type { RectLayer } from "@claudevid/core";
import { describe, expect, it } from "vitest";
import { paintRectLayer } from "../src/draw-shapes.js";
import { createRasterCache } from "../src/raster-cache.js";

function makeRectLayer(overrides: Partial<RectLayer> = {}): RectLayer {
  return {
    type: "rect",
    width: 10,
    height: 10,
    ...overrides,
  };
}

describe("paintRectLayer", () => {
  it("produces a canvas of exact width x height with the fill color visibly painted", () => {
    const cache = createRasterCache(1024 * 1024);
    const layer = makeRectLayer({ fill: "#00ff00" });

    const canvas = paintRectLayer(cache, layer);

    expect(canvas.width).toBe(10);
    expect(canvas.height).toBe(10);

    const data = canvas.data();
    const cx = 5;
    const cy = 5;
    const offset = (cy * canvas.width + cx) * 4;
    // Fully opaque fill: premultiplied-alpha readback equals the straight color.
    expect([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]]).toEqual([0, 255, 0, 255]);
  });

  it("produces a canvas without throwing when radius is set (rounded-corner path)", () => {
    const cache = createRasterCache(1024 * 1024);
    const layer = makeRectLayer({ fill: "#ff00ff", radius: 4 });

    expect(() => paintRectLayer(cache, layer)).not.toThrow();
    const canvas = paintRectLayer(cache, layer);
    expect(canvas.width).toBe(10);
    expect(canvas.height).toBe(10);
  });

  it("returns the same cached canvas for two calls with identical rect fields", () => {
    const cache = createRasterCache(1024 * 1024);
    const layerA = makeRectLayer({ fill: "#123456", stroke: "#abcdef", strokeWidth: 2, radius: 3 });
    const layerB = makeRectLayer({ fill: "#123456", stroke: "#abcdef", strokeWidth: 2, radius: 3 });

    const canvasA = paintRectLayer(cache, layerA);
    const canvasB = paintRectLayer(cache, layerB);

    expect(canvasB).toBe(canvasA);
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, bytesUsed: 10 * 10 * 4 });
  });
});
