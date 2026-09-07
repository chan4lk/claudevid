// Minimal sanity coverage for T7's own building blocks — proves the cache/chrome/overflow
// machinery works end to end without Shiki (hand-built `TokenizedCode`, no `highlight.ts`
// import, consistent with NFR2). Full cache-hit-rate coverage against AC7/AC8's exact numeric
// claims is T13's job (`render-cache.test.ts`) once `animations.ts` exists.
import { createCanvas } from "@napi-rs/canvas";
import type { TimelineLayer } from "@claudevid/core";
import { describe, expect, it } from "vitest";
import { layoutCode, measureLine } from "../src/layout.js";
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

// Regression: render.ts must expand tabs identically to layout.ts (spec.md FR5 / Edge Cases —
// "a single shared expansion function, never duplicated logic that could disagree") before it
// paints anything. Before this fix, `paintLine`/`flattenTokens` painted each token's *raw*
// (unexpanded) text, so a glyph after a `\t` landed at `rawCharIndex * advance` instead of the
// tab-expanded `expandedCharIndex * advance` that `layout.ts`'s own `layoutLine.rows`/
// `LayoutLine.charCount` are built from — desyncing glyph x-position (and the typewriter caret)
// for any line containing a tab.
describe("tab expansion — render.ts agrees with layout.ts on char position (spec.md FR5, Edge Cases)", () => {
  it("paints the glyph after a tab at the tab-expanded x position, not the raw-character x position", () => {
    const tabSize = 4;
    const fontSize = 20;
    const line = "x\ty"; // expandTabs(line, 4) === "x    y" — 'y' is expanded char index 5
    const layer = makeLayer({ tabSize, fontSize, width: 900, height: 400 });
    const layout = layoutCode([line], { width: layer.width, height: layer.height, fontSize, tabSize });
    const ir = makeIr([line]);
    const entry: CompiledCodeLayer = { ir, layout, blocked: false };

    const lineCache = createLineCache();
    const chromeCache = createChromeCache();
    const ctx = createCanvas(layer.width, layer.height).getContext("2d");
    renderCodeFrame(entry, layer, lineCache, chromeCache, ctx, 0);

    // Read the exact bitmap `renderCodeFrame` just cached for this line, via the same (raw-token)
    // `lineKey` render.ts itself computes — a pure cache-hit read (the `paint` callback throws if
    // invoked, so a key mismatch fails loudly instead of silently re-rendering).
    const layoutLine = layout.lines[0]!;
    const key = lineKey(ir.lines[0]!.tokens, layout.fontSize, layer.theme ?? "github-dark", false, layout.contentWidthPx);
    const failIfCalled = () => {
      throw new Error("expected a cache hit — key must match render.ts's own lineKey call");
    };
    const rows = Math.max(1, layoutLine.rows.length);
    const bitmap = lineCache.getOrRender(key, layout.contentWidthPx, rows * layout.lineHeightPx, failIfCalled);

    const advance = measureLine(1, fontSize);
    const data = bitmap.data();
    const bitmapWidth = bitmap.width;
    const bitmapHeight = bitmap.height;

    function hasPaintInColumnRange(xStart: number, xEnd: number): boolean {
      const x0 = Math.max(0, Math.floor(xStart));
      const x1 = Math.min(bitmapWidth, Math.ceil(xEnd));
      for (let y = 0; y < bitmapHeight; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = (y * bitmapWidth + x) * 4;
          if ((data[idx + 3] ?? 0) > 0) return true;
        }
      }
      return false;
    }

    // Correct (tab-expanded) position: "x" (1 char) + 4 expansion spaces -> 'y' at char index 5.
    const expandedYCharIndex = "x".length + tabSize;
    expect(hasPaintInColumnRange(expandedYCharIndex * advance, (expandedYCharIndex + 1) * advance)).toBe(true);

    // The bug this regresses: painting raw (unexpanded) tokens put 'y' at raw char index 2
    // ("x", "\t", "y") instead of the tab-expanded index 5 — that column must now be empty.
    const buggyRawYCharIndex = 2;
    expect(hasPaintInColumnRange(buggyRawYCharIndex * advance, (buggyRawYCharIndex + 1) * advance)).toBe(false);
  });
});
