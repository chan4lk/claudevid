// Dedicated cache-hit-rate coverage for spec.md AC7 and AC8 (T13) — the "does the per-line
// cache actually behave the way NFR3 claims" tests. Both drive `renderCodeFrame` directly with
// their *own* isolated `createLineCache()`/`createChromeCache()` instances (never the module's
// lazy `defaultLineCache()`/`defaultChromeCache()` singleton — see render.ts's own comment on
// why direct callers own their cache instance's lifetime) so each test's counters start at zero
// and are never polluted by another test file's calls.
//
// Hand-built `TokenizedCode` (no `highlight.ts`/Shiki import), matching render.test.ts's (T7)
// own `makeIr`/`makeLayer`/`makeEntry` pattern — this file duplicates that small helper trio
// locally rather than importing them from a sibling test file (test files are not a shared
// module surface in this repo).
import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { layoutCode } from "../src/layout.js";
import type { CodeLayer } from "../src/schema.js";
import { createChromeCache, createLineCache, renderCodeFrame, type CompiledCodeLayer, type Token } from "../src/render.js";

function makeIr(sourceLines: string[]): { lines: { tokens: Token[] }[] } {
  return { lines: sourceLines.map((text) => ({ tokens: [{ text, color: "#e1e4e8", fontStyle: 0 }] })) };
}

function makeLayer(overrides: Partial<CodeLayer> = {}): CodeLayer {
  return {
    type: "code",
    code: "placeholder",
    lang: "typescript",
    width: 900,
    height: 600,
    ...overrides,
  } as CodeLayer;
}

function makeEntry(sourceLines: string[], layer: CodeLayer): CompiledCodeLayer {
  const layout = layoutCode(sourceLines, {
    width: layer.width,
    height: layer.height,
    fontSize: layer.fontSize,
    tabSize: layer.tabSize,
    wrap: layer.wrap,
    showLineNumbers: layer.showLineNumbers,
  });
  return { ir: makeIr(sourceLines), layout, blocked: false };
}

describe("render cache — AC7: static 15-line block, 10 identical frames", () => {
  it("the per-line cache's misses counter does not increase across frames 2-10", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `console.log("line ${i}");`);
    const layer = makeLayer({ title: "static.ts" });
    const entry = makeEntry(lines, layer);
    const lineCache = createLineCache();
    const chromeCache = createChromeCache();

    // Frame 1: every line is a first-time miss (15 misses), nothing to hit yet.
    const frame1Ctx = createCanvas(layer.width, layer.height).getContext("2d");
    renderCodeFrame(entry, layer, lineCache, chromeCache, frame1Ctx, 0);
    expect(lineCache.stats().misses).toBe(15);
    expect(lineCache.stats().hits).toBe(0);

    const missesAfterFrame1 = lineCache.stats().misses;

    // Frames 2-10 (frameLocal 1..9): identical content, identical cache keys — AC7's literal
    // claim is that `misses` does not increase at all across these nine frames.
    for (let frameLocal = 1; frameLocal < 10; frameLocal++) {
      const ctx = createCanvas(layer.width, layer.height).getContext("2d");
      renderCodeFrame(entry, layer, lineCache, chromeCache, ctx, frameLocal);
      expect(lineCache.stats().misses).toBe(missesAfterFrame1);
    }

    // 100% hit rate on the 9 repeat frames: 15 lines * 9 frames = 135 pure hits.
    expect(lineCache.stats().misses).toBe(15);
    expect(lineCache.stats().hits).toBe(15 * 9);
    expect(chromeCache.stats().misses).toBe(1);
    expect(chromeCache.stats().hits).toBe(9);
  });
});

describe("render cache — AC8: typewriter reveal cache-hit-rate claim (NFR3)", () => {
  // 15 equal-length (20-char) lines so each line's typewriter completion lands on a clean,
  // predictable frame boundary — `rate: 30` chars/sec at `render.ts`'s hardcoded `DEFAULT_FPS`
  // (30) is exactly 1 revealed char per frame local, so line `i` finishes revealing at
  // `frameLocal === (i + 1) * LINE_LEN`.
  const LINE_LEN = 20;
  const LINE_COUNT = 15;
  const COMPLETE_AT = LINE_LEN * LINE_COUNT; // 300

  function makeTypewriterEntry() {
    const lines = Array.from({ length: LINE_COUNT }, (_, i) => `const line${i} = ${i};`.padEnd(LINE_LEN, " "));
    const layer = makeLayer({
      reveal: { mode: "typewriter", unit: "char", rate: 30 },
    });
    const entry = makeEntry(lines, layer);
    return { lines, layer, entry };
  }

  it("summed misses stay bounded and the actively-typing line never touches the cache", () => {
    const { layer, entry } = makeTypewriterEntry();
    const lineCache = createLineCache();
    const chromeCache = createChromeCache();

    // Render every frame of the reveal plus a settled tail (AC8: "rendered across every frame
    // of its reveal").
    const TOTAL_FRAMES = COMPLETE_AT + 20;
    for (let frameLocal = 0; frameLocal < TOTAL_FRAMES; frameLocal++) {
      const ctx = createCanvas(layer.width, layer.height).getContext("2d");
      renderCodeFrame(entry, layer, lineCache, chromeCache, ctx, frameLocal);
    }

    const { hits, misses } = lineCache.stats();

    // AC8's literal bound: at most one new miss per frame for the actively-typing line, plus
    // each line's own first-reveal miss.
    expect(misses).toBeLessThanOrEqual(TOTAL_FRAMES + LINE_COUNT);

    // The actively-typing line is painted directly (never through `lineCache.getOrRender` —
    // see render.ts's `isPartial` branch), so in practice each of the 15 lines causes exactly
    // one miss, the frame it first becomes fully revealed — never more.
    expect(misses).toBe(LINE_COUNT);

    // AC8's headline NFR3 ratio, over the whole run.
    expect(hits / (hits + misses)).toBeGreaterThanOrEqual(14 / 15);
  });

  it("the cache hit rate over the reveal's steady-state frames meets the (N-1)/N claim", () => {
    const { layer, entry } = makeTypewriterEntry();
    const lineCache = createLineCache();
    const chromeCache = createChromeCache();

    // A steady-state window well inside the reveal (past the first line's completion, before
    // the last line's) — excludes the startup transient where too few lines have ever been
    // cached yet for a hit-rate ratio to be meaningful.
    const WINDOW_START = LINE_LEN * 4; // 80: 4 lines already fully cached
    const WINDOW_END = LINE_LEN * 13; // 260: still mid-reveal

    let statsAtWindowStart: { hits: number; misses: number } | null = null;
    let statsAtWindowEnd: { hits: number; misses: number } | null = null;

    for (let frameLocal = 0; frameLocal <= WINDOW_END; frameLocal++) {
      const ctx = createCanvas(layer.width, layer.height).getContext("2d");
      renderCodeFrame(entry, layer, lineCache, chromeCache, ctx, frameLocal);
      if (frameLocal === WINDOW_START) statsAtWindowStart = { ...lineCache.stats() };
      if (frameLocal === WINDOW_END) statsAtWindowEnd = { ...lineCache.stats() };
    }

    expect(statsAtWindowStart).not.toBeNull();
    expect(statsAtWindowEnd).not.toBeNull();
    const deltaHits = statsAtWindowEnd!.hits - statsAtWindowStart!.hits;
    const deltaMisses = statsAtWindowEnd!.misses - statsAtWindowStart!.misses;

    // Only the ~9 lines that finish revealing within this window (frames 100, 120, ..., 260)
    // ever cause a miss here; every other frame in the window is a pure run of hits against
    // the lines already fully revealed — the (N-1)/N steady-state claim, measured directly
    // against the cache's own counters, no image comparison.
    expect(deltaHits / (deltaHits + deltaMisses)).toBeGreaterThanOrEqual((LINE_COUNT - 1) / LINE_COUNT);
  });
});
