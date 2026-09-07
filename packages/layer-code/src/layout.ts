// Monospace fast-path measurement, tab expansion, soft-wrap, auto-fit, and the per-line `y`
// offset table (spec.md FR5/FR6/FR12). This module is pure layout math: it takes plain source
// text (line arrays of strings) and font-size numbers in, and plain data out — no Shiki tokens,
// no canvas painting, only `@napi-rs/canvas`'s `measureText` used purely for font metrics (the
// same narrow use `packages/renderer-canvas/src/text.ts` makes of a throwaway 1x1
// `measureCanvas`, spec.md FR5's grounding).
//
// Two things downstream code must treat as the single source of truth from here, per design.md:
//   - `expandTabs` — `render.ts` (T7) must call this exact function for paint-time char
//     positioning, never re-derive tab expansion itself (spec.md FR5 / Edge Cases: "a single
//     shared expansion function, never duplicated logic that could disagree").
//   - `LayoutResult.lines[i].y` — `annotate.ts` (T10) and `render.ts` (T7) both read a line's
//     vertical position from here; neither re-derives `i * lineHeightPx` independently
//     (design.md's `annotationPosition` grounding, spec.md FR12).
//
// Chrome sizing constants (`CHROME_*`, `GUTTER_PADDING_PX`) are defined here — not in `render.ts`
// — for the same reason: `computeAvailableLines`'s vertical-fit math and `render.ts`'s eventual
// chrome painting must agree on the same numbers, or a block that compiles as "fits" could still
// visually overflow the chrome `render.ts` actually paints. `render.ts` (T7) must import and
// reuse these constants verbatim rather than restate them.

import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";

// `packages/renderer-canvas/src/fonts.ts:10` defines `MONO_FONT_FAMILY` but
// `packages/renderer-canvas/src/index.ts` does not re-export it (only `.` is exported per that
// package's `package.json`, and this change's scope does not touch `renderer-canvas` beyond the
// already-landed `painters.ts`/`index.ts` dispatch change, design.md's File Changes Map). Restated
// here verbatim, mirroring `schema.ts`'s own precedent for `baseLayerShape` ("a small, deliberate
// duplication rather than a core export-surface change") rather than reopening a sibling
// package's export surface for one string constant.
const MONO_FONT_FAMILY = "JetBrains Mono, monospace";

// --- Chrome sizing constants ---------------------------------------------------------------
// No exact pixel values are specified anywhere in spec.md/design.md (design.md defers them to
// "a fixed constant from render.ts's chrome spec" — but render.ts does not exist yet, T7). These
// are the values established here; `render.ts` (T7) must import and paint against these same
// constants, never restate them, so `computeAvailableLines`'s fit computation and the chrome
// `render.ts` actually paints can never disagree (the exact bug design.md's Risks section warns
// against for the two-guardrail sequencing).
export const CHROME_TITLE_BAR_PX = 40;
export const CHROME_BORDER_PX = 2;
export const CHROME_PADDING_PX = 16;
/** Title bar + top/bottom border + top/bottom padding (spec.md FR6's `chromeVerticalPx`). */
export const CHROME_VERTICAL_PX = CHROME_TITLE_BAR_PX + 2 * CHROME_BORDER_PX + 2 * CHROME_PADDING_PX;
/** Left/right border + left/right padding (spec.md FR6's width-fit guardrail). */
export const CHROME_HORIZONTAL_PX = 2 * CHROME_BORDER_PX + 2 * CHROME_PADDING_PX;
/** Gap between the line-number gutter's digits and the first code column. */
export const GUTTER_PADDING_PX = 12;

/** Auto-fit's hard floor (spec.md FR6). */
export const AUTO_FIT_FLOOR_PX = 12;

/** No exact value is specified for `wrap: "soft"`'s continuation indent (spec.md FR6 only says
 * "wraps with a continuation indent"); 2 columns is a documented, reasonable default matching
 * common editor soft-wrap conventions (e.g. VS Code's default wrapped-line indent). */
export const SOFT_WRAP_CONTINUATION_INDENT_CHARS = 2;

/** Code line-height as a multiple of `fontSize` — matches typical code-editor line spacing
 * (tighter than `text.ts`'s prose default of `1.2`, code benefits from slightly more). */
export const LINE_HEIGHT_RATIO = 1.5;

// --- Tab expansion (FR5 / Edge Cases: one shared function, never duplicated) ----------------

/** Expands every `\t` in `line` to exactly `tabSize` literal space characters. `render.ts` (T7)
 * must call this identical function at paint time — never a re-derived tab-stop calculation —
 * so a `measureLine`-computed char index and the pixel-x `render.ts` paints at always agree
 * (spec.md FR5's typewriter-caret-exactness requirement, Edge Cases). */
export function expandTabs(line: string, tabSize: number): string {
  return tabSize > 0 ? line.replace(/\t/g, " ".repeat(tabSize)) : line.replace(/\t/g, "");
}

// --- Monospace fast-path measurement (FR5 / AC4) --------------------------------------------

// Only used to call `ctx.font`/`measureText` before any real canvas exists — mirrors
// `text.ts:14-15`'s throwaway 1x1 `measureCanvas` pattern exactly.
const measureCanvas = createCanvas(1, 1);
const measureCtx: SKRSContext2D = measureCanvas.getContext("2d");

// Per-fontSize advance-width cache (FR5: "calls [measureText] at most once per distinct
// fontSize value used across a render"). Module-level (not per-call), so this is process-wide:
// whichever of `compileCodeLayers` (compile time) or `paintCodeLayer` (render time) asks for a
// given `fontSize` first pays the one `measureText` call; every later call (from either side,
// since both import this same module) is a cache hit — the same value both sides see, so a
// compile-time fit decision and a render-time glyph position are always computed from the exact
// same advance width, never two independently-measured numbers that could drift apart.
const advanceWidthCache = new Map<number, number>();

function advanceWidthPx(fontSizePx: number): number {
  const cached = advanceWidthCache.get(fontSizePx);
  if (cached !== undefined) return cached;
  measureCtx.font = `${fontSizePx}px ${MONO_FONT_FAMILY}`;
  // Monospace: every glyph shares one advance width, so any single reference character's
  // measured width IS the font's advance width at this size — no need to special-case which
  // character gets measured.
  const width = measureCtx.measureText("0").width;
  advanceWidthCache.set(fontSizePx, width);
  return width;
}

/** Test-only introspection — proves `measureLine` never calls `measureText` per token, only
 * once per distinct `fontSizePx` (FR5). */
export function _advanceWidthCacheSizeForTests(): number {
  return advanceWidthCache.size;
}

/**
 * `charCount * advanceWidthPx(fontSizePx)` — the fast path (spec.md FR5). `advanceWidthPx` is
 * cached per `fontSizePx` (see `advanceWidthCache` above), so this is exactly linear in
 * `charCount` for a fixed `fontSizePx` by construction (AC4: within `0.01px` of
 * `charCount * measureLine(1, fontSizePx)`), and never issues a `measureText` call per token —
 * tab characters must already be expanded (via `expandTabs`) before calling this.
 */
export function measureLine(charCount: number, fontSizePx: number): number {
  return charCount * advanceWidthPx(fontSizePx);
}

// --- Vertical fit (FR6 / AC5) ----------------------------------------------------------------

/**
 * `floor((height - chromeVerticalPx) / lineHeightPx)` (spec.md FR6). `showLineNumbers` is
 * accepted for signature symmetry with this module's other fit-computation entry points and
 * because a caller reasoning about "how many lines fit" naturally has it on hand — it does not
 * currently change the result, since line numbers occupy horizontal gutter space
 * (`gutterWidthPx`, computed separately inside `layoutCode`), not vertical chrome height.
 * Clamped to `>= 0` (a `height` too small even for the title bar has no room for any code line,
 * not a negative one).
 */
export function computeAvailableLines(height: number, fontSize: number, showLineNumbers: boolean): number {
  void showLineNumbers;
  const lineHeightPx = fontSize * LINE_HEIGHT_RATIO;
  return Math.max(0, Math.floor((height - CHROME_VERTICAL_PX) / lineHeightPx));
}

function gutterWidthPxFor(fontSize: number, lineCount: number, showLineNumbers: boolean): number {
  if (!showLineNumbers) return 0;
  const digits = String(Math.max(1, lineCount)).length;
  return measureLine(digits, fontSize) + GUTTER_PADDING_PX;
}

// --- Soft wrap (FR6 / Edge Cases) -------------------------------------------------------------

/** Splits one already tab-expanded source line into visual rows of at most `availableChars`
 * columns each, indenting every continuation row by `SOFT_WRAP_CONTINUATION_INDENT_CHARS`
 * spaces (so a continuation row's own content budget is `availableChars - indentChars`). A
 * monospace char-count split (not a per-substring `measureText` call), consistent with FR5's
 * fast path. */
function wrapExpandedLine(expandedLine: string, availableChars: number): string[] {
  if (availableChars <= 0 || expandedLine.length <= availableChars) return [expandedLine];

  const rows: string[] = [];
  let rest = expandedLine;
  let first = true;
  const continuationBudget = Math.max(1, availableChars - SOFT_WRAP_CONTINUATION_INDENT_CHARS);
  const continuationPrefix = " ".repeat(SOFT_WRAP_CONTINUATION_INDENT_CHARS);

  while (rest.length > 0) {
    const budget = first ? availableChars : continuationBudget;
    if (rest.length <= budget) {
      rows.push(first ? rest : continuationPrefix + rest);
      break;
    }
    const chunk = rest.slice(0, budget);
    rows.push(first ? chunk : continuationPrefix + chunk);
    rest = rest.slice(budget);
    first = false;
  }
  return rows;
}

// --- Full layout (measure + wrap + fit-to-width + per-line y offsets) ------------------------

export interface LayoutOptions {
  /** Declared font size (spec.md FR1 default `20`). */
  fontSize?: number;
  /** Spaces per tab (spec.md FR1 default `2`). */
  tabSize?: number;
  /** Spec.md FR1 default `"none"`. */
  wrap?: "none" | "soft";
  /** Chrome box width in px (required on the layer). */
  width: number;
  /** Chrome box height in px (required on the layer). */
  height: number;
  /** Spec.md FR1 default `false`. */
  showLineNumbers?: boolean;
}

export interface LayoutLine {
  /** Tab-expanded char count of the full source line (pre-wrap). What
   * `LayoutResult.lineCharCounts` is built from, in source-line order. */
  charCount: number;
  /** Tab-expanded, wrap-split visual rows for this source line. Length `1` unless `wrap:
   * "soft"` split it into continuation rows. */
  rows: string[];
  /** Pixel y-offset (top) of this source line's first visual row — the one source of truth
   * for this line's vertical position (spec.md FR12): `annotate.ts` and `render.ts` both read
   * this value directly, neither re-derives `index * lineHeightPx` independently. */
  y: number;
}

export interface LayoutResult {
  /** One entry per source line (same order/index as the tokenizer's `ir.lines`). */
  lines: LayoutLine[];
  /** `lines.map(l => l.charCount)` — what `animations.ts`'s `typewriterState(reveal,
   * frameLocal, fps, lineLengths)` (spec.md FR10) consumes directly. */
  lineCharCounts: number[];
  /** Font size actually used after FR6's auto-fit retry — may be less than the requested
   * `fontSize` (down to `AUTO_FIT_FLOOR_PX`). Equals the requested size when `wrap: "soft"`
   * (soft wrap never triggers the retry loop). */
  fontSize: number;
  lineHeightPx: number;
  /** `0` when `showLineNumbers` is false. */
  gutterWidthPx: number;
  /** Width available for code content: `width - CHROME_HORIZONTAL_PX - gutterWidthPx`. Used
   * verbatim as the per-line raster cache key's `lineWidthPx` component (design.md's `lineKey`
   * scheme) so a cache key and the box a line is actually painted into always agree. */
  contentWidthPx: number;
  /** `computeAvailableLines(height, fontSize, showLineNumbers)` at the fitted `fontSize` —
   * spec.md FR6/AC5's `availableLines`. `diagnostics.ts` (T5) compares this against
   * `totalRows` (and `maxLines`) to decide whether to emit the line-overflow diagnostic; that
   * comparison is T5's job, not this module's. */
  availableLines: number;
  /** Total visual rows across every line after wrap expansion — spec.md FR6's "effective line
   * count". Equals `lines.length` when `wrap: "none"` or nothing needed wrapping. */
  totalRows: number;
  /** Whether the `wrap: "none"` width-fit retry (down to `AUTO_FIT_FLOOR_PX`) found a size that
   * fits. Always `true` when `wrap: "soft"` (an over-width line wraps instead of failing to
   * fit). `diagnostics.ts` (T5) uses `false` to emit the line-too-long-to-fit diagnostic. */
  widthFits: boolean;
  /** Char count of the longest tab-expanded source line — `diagnostics.ts` (T5) names this in
   * the line-too-long-to-fit message (spec.md FR6/FR13). */
  longestLineCharCount: number;
}

/**
 * Measures, tab-expands, wraps (if `wrap: "soft"`), and auto-fits (if `wrap: "none"`, spec.md
 * FR6) `sourceLines`, returning the single `LayoutResult` every later stage of this package
 * reads line positions and fit facts from. Pure: no Shiki tokens, no diagnostics construction
 * (that's `diagnostics.ts`, T5, reading this result's `widthFits`/`totalRows`/`availableLines`),
 * no canvas painting (that's `render.ts`, T7).
 */
export function layoutCode(sourceLines: string[], options: LayoutOptions): LayoutResult {
  const declaredFontSize = options.fontSize ?? 20;
  const tabSize = options.tabSize ?? 2;
  const wrap = options.wrap ?? "none";
  const showLineNumbers = options.showLineNumbers ?? false;
  const { width, height } = options;

  const expandedLines = sourceLines.map((line) => expandTabs(line, tabSize));
  const longestLineCharCount = expandedLines.reduce((max, line) => Math.max(max, line.length), 0);

  // --- Auto-fit (wrap: "none" only, spec.md FR6) ---
  let fontSize = declaredFontSize;
  let widthFits = true;
  if (wrap === "none") {
    widthFits = false;
    for (let candidate = declaredFontSize; candidate >= AUTO_FIT_FLOOR_PX; candidate -= 1) {
      const gutter = gutterWidthPxFor(candidate, expandedLines.length, showLineNumbers);
      const availablePx = width - CHROME_HORIZONTAL_PX - gutter;
      if (measureLine(longestLineCharCount, candidate) <= availablePx) {
        fontSize = candidate;
        widthFits = true;
        break;
      }
    }
    if (!widthFits) fontSize = AUTO_FIT_FLOOR_PX; // stays at the floor, per FR6, even though it doesn't fit
  }

  const lineHeightPx = fontSize * LINE_HEIGHT_RATIO;
  const gutterWidthPx = gutterWidthPxFor(fontSize, expandedLines.length, showLineNumbers);
  const contentWidthPx = width - CHROME_HORIZONTAL_PX - gutterWidthPx;
  const availableChars = Math.max(0, Math.floor(contentWidthPx / advanceWidthPx(fontSize)));

  const lines: LayoutLine[] = [];
  let rowCursor = 0;
  for (const expandedLine of expandedLines) {
    const rows = wrap === "soft" ? wrapExpandedLine(expandedLine, availableChars) : [expandedLine];
    lines.push({ charCount: expandedLine.length, rows, y: rowCursor * lineHeightPx });
    rowCursor += rows.length;
  }

  return {
    lines,
    lineCharCounts: lines.map((l) => l.charCount),
    fontSize,
    lineHeightPx,
    gutterWidthPx,
    contentWidthPx,
    availableLines: computeAvailableLines(height, fontSize, showLineNumbers),
    totalRows: rowCursor,
    widthFits,
    longestLineCharCount,
  };
}
