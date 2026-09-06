import { createCanvas } from "@napi-rs/canvas";
import type { TextLayer } from "@claudevid/core";
import { describe, expect, it } from "vitest";
import { createRasterCache } from "../src/raster-cache.js";
import { measureAndWrap, paintTextLayer } from "../src/text.js";

function makeTextLayer(overrides: Partial<TextLayer> = {}): TextLayer {
  return {
    type: "text",
    text: "hello world",
    ...overrides,
  };
}

function ctx() {
  return createCanvas(1, 1).getContext("2d");
}

describe("measureAndWrap", () => {
  it("returns exactly one line containing the full text when no maxWidth is set", () => {
    const layer = makeTextLayer({ text: "a single unwrapped line of text" });
    const result = measureAndWrap(ctx(), layer);
    expect(result.lines).toEqual(["a single unwrapped line of text"]);
  });

  it("wraps a multi-word string into more than one line under a narrow maxWidth (AC8)", () => {
    const layer = makeTextLayer({
      text: "hello world foo bar baz qux",
      fontSize: 64,
      maxWidth: 50,
    });
    const result = measureAndWrap(ctx(), layer);

    expect(result.lines.length).toBeGreaterThan(1);

    // Word-wrap can't split mid-word, so a line with a single word may legitimately
    // exceed maxWidth. Only multi-word lines are held to the maxWidth bound.
    const c = ctx();
    c.font = `600 64px ${"Inter, sans-serif"}`;
    for (const line of result.lines) {
      const words = line.split(/\s+/).filter(Boolean);
      if (words.length > 1) {
        expect(c.measureText(line).width).toBeLessThanOrEqual(50);
      }
    }
  });
});

describe("paintTextLayer", () => {
  it("returns a canvas whose dimensions are >= 1x1 and match the layout's rounded totals", () => {
    const cache = createRasterCache(1024 * 1024);
    const layer = makeTextLayer({ text: "sizing check" });

    const canvas = paintTextLayer(cache, layer, "layer-1");
    const layout = measureAndWrap(ctx(), layer);

    expect(canvas.width).toBeGreaterThanOrEqual(1);
    expect(canvas.height).toBeGreaterThanOrEqual(1);
    expect(canvas.width).toBe(Math.ceil(layout.totalWidth));
    expect(canvas.height).toBe(Math.ceil(layout.totalHeight));
  });

  it("returns the same cached canvas for two layers that differ only in an irrelevant field (AC4)", () => {
    const cache = createRasterCache(1024 * 1024);
    const layerA = makeTextLayer({ text: "dedup me", x: 10, start: 0 });
    const layerB = makeTextLayer({ text: "dedup me", x: 999, start: 5 });

    const canvasA = paintTextLayer(cache, layerA, "layer-a");
    const canvasB = paintTextLayer(cache, layerB, "layer-b");

    expect(canvasB).toBe(canvasA);
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, bytesUsed: canvasA.width * canvasA.height * 4 });
  });
});
