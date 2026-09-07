// Minimal sanity coverage for T7's own building blocks — proves the cache/chrome/overflow
// machinery works end to end without Shiki (hand-built `TokenizedCode`, no `highlight.ts`
// import, consistent with NFR2). Full cache-hit-rate coverage against AC7/AC8's exact numeric
// claims is T13's job (`render-cache.test.ts`) once `animations.ts` exists.
import { createCanvas } from "@napi-rs/canvas";
import type { TimelineLayer } from "@claudevid/core";
import { describe, expect, it } from "vitest";
import { layoutCode } from "../src/layout.js";
import type { CodeLayer } from "../src/schema.js";
import {
  chromeKey,
  CodeOverflowError,
  createChromeCache,
  createLineCache,
  isCodeLayer,
  lineKey,
  paintCodeLayer,
  renderCodeFrame,
  type CompiledCodeLayer,
  type Token,
} from "../src/render.js";

function makeIr(sourceLines: string[]): { lines: { tokens: Token[] }[] } {
  return { lines: sourceLines.map((text) => ({ tokens: [{ text, color: "#e1e4e8", fontStyle: 0 }] })) };
}

function makeLayer(overrides: Partial<CodeLayer> = {}): CodeLayer {
  return {
    type: "code",
    code: "placeholder",
    lang: "typescript",
    width: 800,
    height: 400,
    ...overrides,
  } as CodeLayer;
}

function makeEntry(sourceLines: string[], layer: CodeLayer, blocked = false): CompiledCodeLayer {
  const layout = layoutCode(sourceLines, {
    width: layer.width,
    height: layer.height,
    fontSize: layer.fontSize,
    tabSize: layer.tabSize,
    wrap: layer.wrap,
    showLineNumbers: layer.showLineNumbers,
  });
  return { ir: makeIr(sourceLines), layout, blocked };
}

describe("isCodeLayer", () => {
  it("narrows a { type: 'code' } layer, rejects others", () => {
    expect(isCodeLayer({ type: "code" })).toBe(true);
    expect(isCodeLayer({ type: "text" })).toBe(false);
  });
});

describe("CodeOverflowError (spec.md FR7)", () => {
  it("renderCodeFrame throws for a blocked entry before painting anything", () => {
    const layer = makeLayer();
    const entry = makeEntry(["const x = 1;"], layer, true);
    const ctx = createCanvas(layer.width, layer.height).getContext("2d");
    const lineCache = createLineCache();
    const chromeCache = createChromeCache();

    expect(() => renderCodeFrame(entry, layer, lineCache, chromeCache, ctx)).toThrow(CodeOverflowError);
    expect(lineCache.stats().misses).toBe(0);
    expect(chromeCache.stats().misses).toBe(0);
  });
});

describe("per-line + chrome cache (spec.md FR7/FR8, AC7's baseline case)", () => {
  it("a static 15-line block is a cache hit on every subsequent identical frame", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `console.log(${i});`);
    const layer = makeLayer({ title: "demo.ts" });
    const entry = makeEntry(lines, layer);
    const lineCache = createLineCache();
    const chromeCache = createChromeCache();

    for (let frame = 0; frame < 10; frame++) {
      const ctx = createCanvas(layer.width, layer.height).getContext("2d");
      renderCodeFrame(entry, layer, lineCache, chromeCache, ctx, frame);
    }

    // First frame: 15 line misses + 1 chrome miss. Frames 2-10 must be 100% hits (AC7).
    expect(lineCache.stats().misses).toBe(15);
    expect(lineCache.stats().hits).toBe(15 * 9);
    expect(chromeCache.stats().misses).toBe(1);
    expect(chromeCache.stats().hits).toBe(9);
  });

  it("two distinct source lines with identical rendered content share one line cache entry", () => {
    const layer = makeLayer();
    const entry = makeEntry(["}", "}"], layer);
    const lineCache = createLineCache();
    const chromeCache = createChromeCache();
    const ctx = createCanvas(layer.width, layer.height).getContext("2d");

    renderCodeFrame(entry, layer, lineCache, chromeCache, ctx);

    expect(lineCache.stats().misses).toBe(1);
    expect(lineCache.stats().hits).toBe(1);
  });

  it("lineKey/chromeKey differ when theme, dimmed, or showLineNumbers differ", () => {
    const tokens: Token[] = [{ text: "x", color: "#fff", fontStyle: 0 }];
    expect(lineKey(tokens, 20, "github-dark", false, 100)).not.toBe(lineKey(tokens, 20, "github-light", false, 100));
    expect(lineKey(tokens, 20, "github-dark", false, 100)).not.toBe(lineKey(tokens, 20, "github-dark", true, 100));
    expect(chromeKey(800, 400, "github-dark", "a", false)).not.toBe(chromeKey(800, 400, "github-dark", "a", true));
  });
});

describe("paintCodeLayer (PainterFn conformance)", () => {
  it("paints via the (entry, timelineLayer, frame, ctx) shape registerPainter expects", () => {
    const layer = makeLayer();
    const entry = makeEntry(["const x = 1;"], layer);
    const ctx = createCanvas(layer.width, layer.height).getContext("2d");

    expect(() =>
      paintCodeLayer(
        entry,
        {
          layerKey: "scenes/0/layers/0",
          sceneId: "s0",
          type: "code",
          startFrame: 0,
          endFrame: 10,
          x: 0,
          y: 0,
          layer: layer as unknown as TimelineLayer["layer"],
        },
        0,
        ctx,
      ),
    ).not.toThrow();
  });

  it("is a no-op for a non-code TimelineLayer", () => {
    const ctx = createCanvas(10, 10).getContext("2d");
    expect(() =>
      paintCodeLayer(
        {},
        { layerKey: "k", sceneId: "s0", type: "text", startFrame: 0, endFrame: 10, x: 0, y: 0, layer: { type: "text", text: "hi" } as never },
        0,
        ctx,
      ),
    ).not.toThrow();
  });
});
