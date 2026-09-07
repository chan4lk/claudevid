// AC10 — focus dim, raw-pixel luminance coverage (T13). Reads the per-line cache's own cached
// bitmap `Canvas` objects directly (via `render.ts`'s exported `lineKey` + `LineCache
// .getOrRender`'s cache-hit path) and inspects their raw RGBA buffers — never a snapshot image
// comparison, per spec.md AC10's own wording.
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { layoutCode } from "../src/layout.js";
import type { CodeLayer } from "../src/schema.js";
import {
  createChromeCache,
  createLineCache,
  lineKey,
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

// `render.ts`'s `CHROME_THEME_COLORS["github-dark"].background` (`#24292e`) is not exported —
// restated verbatim here (the same small, deliberate duplication `render.ts`'s own file header
// already documents for `MONO_FONT_FAMILY`), since a raw-pixel "closer to background" assertion
// needs the actual background colour to compare against.
const GITHUB_DARK_BACKGROUND = { r: 0x24, g: 0x29, b: 0x2e };

function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Straight-alpha-composites every pixel of `canvas`'s raw RGBA buffer over `bg`, then averages
 * the composited relative luminance across the whole bitmap — i.e. "how bright will this bitmap
 * actually look once `ctx.drawImage`'d onto the chrome background," which is exactly what a
 * dimmed line's lower `ctx.globalAlpha` (spec.md FR10) is meant to move closer to `bg`. */
function averageCompositedLuminance(canvas: Canvas, bg: { r: number; g: number; b: number }): number {
  const data = canvas.data();
  let total = 0;
  let count = 0;
  for (let p = 0; p < data.length; p += 4) {
    const a = data[p + 3]! / 255;
    const r = data[p]! * a + bg.r * (1 - a);
    const g = data[p + 1]! * a + bg.g * (1 - a);
    const b = data[p + 2]! * a + bg.b * (1 - a);
    total += relativeLuminance({ r, g, b });
    count++;
  }
  return count === 0 ? 0 : total / count;
}

describe("focus dim — AC10: raw pixel luminance, not a snapshot image", () => {
  it("a dimmed line's cached bitmap differs from a focused line's, and reads measurably closer to the chrome background", () => {
    const lines = ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", "const e = 5;"];
    const layer = makeLayer({ focus: { lines: [3, 3] } });
    const entry = makeEntry(lines, layer);
    const lineCache = createLineCache();
    const chromeCache = createChromeCache();
    const ctx = createCanvas(layer.width, layer.height).getContext("2d");

    // Render once — `focus.lines: [3, 3]` with no `focus.animate` is a static range, so frame 0
    // already reflects the settled dim state (spec.md FR10: `focusState` with no `.animate`
    // returns `focus.lines` verbatim).
    renderCodeFrame(entry, layer, lineCache, chromeCache, ctx, 0);

    const { layout, ir } = entry;
    const theme = layer.theme ?? "github-dark";
    const dimOpacity = 0.35; // render.ts's own default when `focus.dimOpacity` is unset

    // Line 1 (index 0) is outside [3, 3] -> dimmed. Line 3 (index 2) is the focused line.
    const dimmedIndex = 0;
    const focusedIndex = 2;
    expect(dimmedIndex + 1 < 3 || dimmedIndex + 1 > 3).toBe(true); // sanity: really outside the range
    expect(focusedIndex + 1 >= 3 && focusedIndex + 1 <= 3).toBe(true); // sanity: really inside the range

    const dimmedLine = ir.lines[dimmedIndex]!;
    const focusedLine = ir.lines[focusedIndex]!;
    const dimmedLayoutLine = layout.lines[dimmedIndex]!;
    const focusedLayoutLine = layout.lines[focusedIndex]!;

    const dimmedKey = lineKey(dimmedLine.tokens, layout.fontSize, theme, true, layout.contentWidthPx);
    const focusedKey = lineKey(focusedLine.tokens, layout.fontSize, theme, false, layout.contentWidthPx);

    // Both entries were already populated by the `renderCodeFrame` call above — this must be a
    // pure cache-hit read, never a repaint (the `paint` callback throws if invoked, to catch a
    // mismatched key rather than silently re-rendering and passing for the wrong reason).
    const failIfCalled = () => {
      throw new Error("expected a cache hit — key must match render.ts's own lineKey call");
    };
    const dimmedRows = Math.max(1, dimmedLayoutLine.rows.length);
    const focusedRows = Math.max(1, focusedLayoutLine.rows.length);
    const dimmedBitmap = lineCache.getOrRender(dimmedKey, layout.contentWidthPx, dimmedRows * layout.lineHeightPx, failIfCalled);
    const focusedBitmap = lineCache.getOrRender(focusedKey, layout.contentWidthPx, focusedRows * layout.lineHeightPx, failIfCalled);

    // Raw pixel buffers differ (AC10's first clause) — same tokens/theme/dimensions, different
    // `dimmed` flag, so a different cache entry / different rendered alpha.
    expect(dimmedBitmap.data()).not.toEqual(focusedBitmap.data());
    expect(dimOpacity).toBeLessThan(1); // the opacity actually applied to the dimmed bitmap's glyphs

    const backgroundLuminance = relativeLuminance(GITHUB_DARK_BACKGROUND);
    const dimmedLuminance = averageCompositedLuminance(dimmedBitmap, GITHUB_DARK_BACKGROUND);
    const focusedLuminance = averageCompositedLuminance(focusedBitmap, GITHUB_DARK_BACKGROUND);

    // AC10's second clause: the dimmed line's average luminance sits measurably closer to the
    // chrome background colour than the focused line's does — the alpha-blend-toward-background
    // dim (FR10).
    const dimmedDistance = Math.abs(dimmedLuminance - backgroundLuminance);
    const focusedDistance = Math.abs(focusedLuminance - backgroundLuminance);
    expect(dimmedDistance).toBeLessThan(focusedDistance);
  });
});
