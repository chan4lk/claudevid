// Per-line cache, chrome cache, `paintCodeLayer`, `CodeOverflowError`, `isCodeLayer` guard
// (spec.md FR7/FR8/FR9; design.md's "Per-line cache key scheme" + "paintCodeLayer" sections,
// Key Decision D1). This is the render path: it turns an already-compiled `CompiledCodeLayer`
// (tokenized IR + layout, produced compile-time by `highlight.ts`/`layout.ts`/`diagnostics.ts`)
// into pixels, with two caches so a typewriter animation never invalidates a whole block's
// cache every frame — the proposal's headline efficiency claim (NFR3).
//
// NFR2: no file under `render.ts`/`animations.ts`/`diff.ts`/`annotate.ts` may import `shiki` or
// `highlight.ts` (grep-enforced by a later task's test). `Token`/`TokenizedCode` are therefore
// restated locally below — the same small, deliberate duplication `layout.ts` already uses for
// `MONO_FONT_FAMILY` (`packages/renderer-canvas/src/fonts.ts:10`) rather than reopening a
// sibling module's internals for a plain-data shape. Both copies stay structurally identical to
// `highlight.ts`'s own `Token`/`TokenizedCode` (FR4's plain-object IR), so a real
// `CompiledCodeLayer` assembled from `compileCodeLayers`'s output satisfies this file's types
// without any conversion step.
//
// Key Decision D1: this file's line/chrome caches are their own instances, created via a
// package-private factory mirroring `packages/renderer-canvas/src/raster-cache.ts`'s exact
// algorithm (content-hash-keyed `Map`, insertion-order-as-LRU-recency, evict-oldest-while-over-
// budget) — grounded in that file's pattern, not imported from it: `renderer-canvas`'s own
// public surface (`packages/renderer-canvas/src/index.ts`) does not re-export
// `createRasterCache`/`RasterCache` (only its own internal render loop uses them), so a second,
// separately-budgeted instance is constructed locally rather than by widening a sibling
// package's already-shipped export surface for this one call site.
//
// T11: `reveal`/`focus`/`diff`/`scroll`/`annotations` are now fully wired — `renderCodeFrame`
// drives `animations.ts`'s pure `typewriterState`/`focusState`/`scrollOffsetPx` (and
// `lineStaggerDelays` for `reveal.mode === "line-stagger"`) from `frameLocal`, tints diff
// backgrounds via `diff.ts`'s `diffLines`, and draws annotations via `annotate.ts`'s
// `annotationPosition` — see the per-frame state block and per-line loop inside
// `renderCodeFrame` below.

import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import type { TimelineLayer } from "@claudevid/core";
import { focusState, lineStaggerDelays, scrollOffsetPx, typewriterState } from "./animations.js";
import { annotationPosition } from "./annotate.js";
import { diffLines } from "./diff.js";
import type { CodeAnnotation, CodeDiff, CodeLayer } from "./schema.js";
import {
  CHROME_BORDER_PX,
  CHROME_PADDING_PX,
  CHROME_TITLE_BAR_PX,
  GUTTER_PADDING_PX,
  SOFT_WRAP_CONTINUATION_INDENT_CHARS,
  measureLine,
  type LayoutLine,
  type LayoutResult,
} from "./layout.js";

// Restated verbatim from `packages/renderer-canvas/src/fonts.ts:10` — see file header note.
const MONO_FONT_FAMILY = "JetBrains Mono, monospace";

// `PainterFn` (`packages/renderer-canvas/src/painters.ts`) is `(entry, timelineLayer, frame,
// ctx) => void` — no `fps` parameter — and neither `TimelineLayer` nor `Timeline`
// (`packages/core/src/timeline.ts`) carries the compiled `VideoSpec.fps` through to paint time
// (only `compileTimeline`'s own frame-math, at compile time, uses it). `animations.ts`'s
// frame-in/state-out functions (spec.md FR10) all take `fps` as an explicit parameter, so a real
// value is needed here regardless. Widening `PainterFn`'s signature or `TimelineLayer`'s shape to
// thread a real `fps` through is out of this task's scope (both are files T11 must not touch —
// `renderer-canvas` and `@claudevid/core` respectively). `VideoSpec.fps`'s own Zod default
// (`packages/core/src/schema.ts:58`, `z.number().positive().default(30)`) is the smallest
// defensible stand-in: every animation this file drives is frame-rate-relative
// (`elapsedSeconds = frameLocal / fps`), so a spec authored at a non-30 fps sees its reveal/
// focus/scroll/diff timing scaled by the assumed/actual fps ratio — a real, documented
// limitation, not a silent bug, until a future change threads the compiled spec's real fps
// through the painter registry.
const DEFAULT_FPS = 30;

// --- Local IR types (NFR2: never import highlight.ts) -----------------------------------------

/** Structurally identical to `highlight.ts`'s own `Token` (FR4's plain-object IR). */
export interface Token {
  text: string;
  color: string;
  fontStyle: number;
}

export interface TokenizedCodeLine {
  tokens: Token[];
}

/** Structurally identical to `highlight.ts`'s own `TokenizedCode`. */
export interface TokenizedCode {
  lines: TokenizedCodeLine[];
}

/** The render-ready compiled entry a caller hands `renderCodeFrame`/`paintCodeLayer`: tokenized
 * IR (`highlight.ts`) + layout (`layout.ts`) + the compile-time fit verdict
 * (`diagnostics.ts`'s `checkLayoutDiagnostics`). Assembling this from `compileCodeLayers`'s
 * plain `Map<layerKey, TokenizedCode>` output is the calling pipeline's job, not this file's. */
export interface CompiledCodeLayer {
  ir: TokenizedCode;
  layout: LayoutResult;
  blocked: boolean;
}

// --- Errors (spec.md FR7 — the second, render-time guardrail) ---------------------------------

/** Thrown by `renderCodeFrame`/`paintCodeLayer` for any `blocked: true` compiled entry, before
 * any painting occurs — a caller that renders without checking `compileCodeLayers`'s own
 * `diagnostics` array still cannot produce an overflowing frame silently (spec.md FR7). */
export class CodeOverflowError extends Error {
  constructor(message = "cannot render an overflowing code block — see compile-time diagnostics") {
    super(message);
    this.name = "CodeOverflowError";
  }
}

// --- `TimelineLayer.layer` narrowing (design.md's "no core.Layer type change" section) --------

/** `core.Layer` is a closed static union with no "code" member — `registerLayer` only extends
 * the *runtime* Zod union. This is the one place `render.ts` crosses that static-type gap,
 * documented rather than "fixed" by editing a sealed package's public type. */
export function isCodeLayer(layer: { type: string }): layer is CodeLayer {
  return layer.type === "code";
}

// --- Bitmap cache (Key Decision D1) ------------------------------------------------------------

export interface BitmapCache {
  getOrRender(key: string, width: number, height: number, paint: (ctx: SKRSContext2D) => void): Canvas;
  stats(): { hits: number; misses: number; bytesUsed: number };
  dispose(): void;
}

/** Per-line raster cache (spec.md FR8). */
export type LineCache = BitmapCache;
/** Single-entry-per-distinct-chrome-config cache (spec.md FR8). */
export type ChromeCache = BitmapCache;

// Sized independently from `renderer-canvas`'s own 512MB shared cache (Key Decision D1's
// rationale: a busy code walkthrough can contain more distinct line bitmaps than every other
// layer type combined — giving lines their own budget means a code-heavy scene can't silently
// evict a frequently-reused `text` title bitmap it has nothing to do with).
export const DEFAULT_LINE_CACHE_LIMIT_BYTES = 64 * 1024 * 1024;
/** Chrome bitmaps are one-per-distinct-`(width,height,theme,title,showLineNumbers)` — a small,
 * separate budget is enough headroom for many distinct code-block configs in one scene. */
export const DEFAULT_CHROME_CACHE_LIMIT_BYTES = 16 * 1024 * 1024;

/** Mirrors `packages/renderer-canvas/src/raster-cache.ts`'s `createRasterCache` algorithm
 * exactly (content-hash `Map` key, insertion-order-as-LRU-recency, `bytes = width*height*4`
 * accounting, evict-oldest-while-over-budget) as a package-private factory — see file header
 * note on why this is a local pattern-reuse rather than an import. */
function createBitmapCache(limitBytes: number): BitmapCache {
  const entries = new Map<string, { canvas: Canvas; bytes: number }>(); // insertion order = LRU recency
  let bytesUsed = 0;
  let hits = 0;
  let misses = 0;

  return {
    getOrRender(key, width, height, paint) {
      const existing = entries.get(key);
      if (existing) {
        hits++;
        entries.delete(key);
        entries.set(key, existing); // bump recency
        return existing.canvas;
      }
      misses++;
      const canvas = createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
      paint(canvas.getContext("2d"));
      const bytes = canvas.width * canvas.height * 4;
      entries.set(key, { canvas, bytes });
      bytesUsed += bytes;
      while (bytesUsed > limitBytes && entries.size > 1) {
        const oldest = entries.entries().next().value;
        if (!oldest) break;
        const [oldestKey, oldestEntry] = oldest;
        entries.delete(oldestKey);
        bytesUsed -= oldestEntry.bytes;
      }
      return canvas;
    },
    stats: () => ({ hits, misses, bytesUsed }),
    dispose() {
      entries.clear();
      bytesUsed = 0;
    },
  };
}

/** Package-private line cache factory (Key Decision D1) — a fresh instance per call, never a
 * shared/global one implicitly; callers (tests, a future render pipeline) own the instance's
 * lifetime. `paintCodeLayer`'s own default instance (below) is just one caller of this. */
export function createLineCache(limitBytes: number = DEFAULT_LINE_CACHE_LIMIT_BYTES): LineCache {
  return createBitmapCache(limitBytes);
}

/** Package-private chrome cache factory (spec.md FR8). */
export function createChromeCache(limitBytes: number = DEFAULT_CHROME_CACHE_LIMIT_BYTES): ChromeCache {
  return createBitmapCache(limitBytes);
}

// --- Cache key schemes (design.md "Per-line cache key scheme") --------------------------------

/** Content-hash-keyed on `(tokens, fontSize, theme, dimmed, lineWidthPx)` — **not** on line
 * index or layer key, so two lines with identical tokens/state (even across different layers or
 * positions) share one cache entry (spec.md FR8). Deliberately the literal formula design.md
 * specifies, not a re-invented one. */
export function lineKey(tokens: Token[], fontSize: number, theme: string, dimmed: boolean, lineWidthPx: number): string {
  return [
    theme,
    fontSize,
    dimmed,
    Math.round(lineWidthPx),
    tokens.map((t) => `${t.text} ${t.color} ${t.fontStyle}`).join(""),
  ].join("|");
}

/** One entry per distinct chrome configuration (spec.md FR8's literal key). */
export function chromeKey(width: number, height: number, theme: string, title: string | undefined, showLineNumbers: boolean): string {
  return [width, height, theme, title ?? "", showLineNumbers].join("|");
}

// --- Chrome painting (spec.md FR8: rounded background/border/title bar/traffic-lights) --------

interface ChromeColors {
  background: string;
  border: string;
  titleBarBackground: string;
  titleBarText: string;
  gutterText: string;
}

// Chrome UI presentation colours (distinct from `themes.ts`'s Shiki *token* palette — that
// module's `THEME_PALETTES` is compile-time-only content for the contrast auditor, spec.md
// FR15, and is not exported for render-time use). A small, deliberate duplication of only the
// handful of UI-chrome hues each bundled theme implies, not a restatement of Shiki's full theme
// data.
const CHROME_THEME_COLORS: Record<string, ChromeColors> = {
  "github-dark": {
    background: "#24292e",
    border: "#444d56",
    titleBarBackground: "#2f363d",
    titleBarText: "#c8ccd1",
    gutterText: "#6a737d",
  },
  "github-light": {
    background: "#ffffff",
    border: "#d1d5da",
    titleBarBackground: "#f6f8fa",
    titleBarText: "#586069",
    gutterText: "#959da5",
  },
  "high-contrast": {
    background: "#0a0c10",
    border: "#f0f3f6",
    titleBarBackground: "#161b22",
    titleBarText: "#f0f3f6",
    gutterText: "#bdc4cc",
  },
};

function chromeColorsFor(theme: string): ChromeColors {
  return CHROME_THEME_COLORS[theme] ?? CHROME_THEME_COLORS["github-dark"]!;
}

const CHROME_RADIUS_PX = 10;
const TRAFFIC_LIGHT_COLORS = ["#ff5f56", "#ffbd2e", "#27c93f"];
const TRAFFIC_LIGHT_RADIUS_PX = 6;
const TRAFFIC_LIGHT_GAP_PX = 20;

/** Rounded background/border/title-bar/traffic-lights, pre-rendered once per distinct
 * `(width,height,theme,title,showLineNumbers)` config and blitted every frame — never
 * re-rasterized for a border/shadow (spec.md FR8, `002`'s "shadows/blurs are never per-frame
 * operations" rule). */
function paintChrome(layer: CodeLayer, theme: string): (ctx: SKRSContext2D) => void {
  return (ctx) => {
    const colors = chromeColorsFor(theme);
    const width = layer.width;
    const height = layer.height;

    ctx.beginPath();
    ctx.roundRect(0, 0, width, height, CHROME_RADIUS_PX);
    ctx.fillStyle = colors.background;
    ctx.fill();
    if (CHROME_BORDER_PX > 0) {
      ctx.lineWidth = CHROME_BORDER_PX;
      ctx.strokeStyle = colors.border;
      ctx.stroke();
    }

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(0, 0, width, CHROME_TITLE_BAR_PX, [CHROME_RADIUS_PX, CHROME_RADIUS_PX, 0, 0]);
    ctx.clip();
    ctx.fillStyle = colors.titleBarBackground;
    ctx.fillRect(0, 0, width, CHROME_TITLE_BAR_PX);
    ctx.restore();

    const dotY = CHROME_TITLE_BAR_PX / 2;
    for (const [i, color] of TRAFFIC_LIGHT_COLORS.entries()) {
      ctx.beginPath();
      ctx.arc(CHROME_PADDING_PX + TRAFFIC_LIGHT_RADIUS_PX + i * TRAFFIC_LIGHT_GAP_PX, dotY, TRAFFIC_LIGHT_RADIUS_PX, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }

    if (layer.title) {
      ctx.font = `600 13px ${MONO_FONT_FAMILY}`;
      ctx.fillStyle = colors.titleBarText;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(layer.title, width / 2, dotY);
    }
  };
}

// --- Line painting (spec.md FR9: no ligatures — one character per `fillText` call) ------------

interface Glyph {
  ch: string;
  color: string;
  fontStyle: number;
}

const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

function fontStringFor(fontSize: number, fontStyle: number): string {
  const italic = fontStyle & FONT_STYLE_ITALIC ? "italic " : "";
  const weight = fontStyle & FONT_STYLE_BOLD ? "700" : "400";
  return `${italic}${weight} ${fontSize}px ${MONO_FONT_FAMILY}`;
}

function flattenTokens(tokens: Token[]): Glyph[] {
  const glyphs: Glyph[] = [];
  for (const t of tokens) {
    for (const ch of t.text) glyphs.push({ ch, color: t.color, fontStyle: t.fontStyle });
  }
  return glyphs;
}

/** Splits one source line's flat glyph stream into visual rows using `layoutLine.rows`' own
 * per-row character counts (`layout.ts`'s wrap split — the one source of truth, spec.md
 * FR5/FR12; never re-derives the wrap boundaries itself), inserting
 * `SOFT_WRAP_CONTINUATION_INDENT_CHARS` synthetic space glyphs at the start of every
 * continuation row (invisible either way — a space glyph paints nothing). */
function glyphRows(tokens: Token[], layoutLine: LayoutLine): Glyph[][] {
  const glyphs = flattenTokens(tokens);
  if (layoutLine.rows.length <= 1) return [glyphs];

  const indentGlyph: Glyph = { ch: " ", color: "", fontStyle: 0 };
  const rows: Glyph[][] = [];
  let cursor = 0;
  layoutLine.rows.forEach((row, i) => {
    if (i === 0) {
      rows.push(glyphs.slice(0, row.length));
      cursor = row.length;
    } else {
      const contentLen = Math.max(0, row.length - SOFT_WRAP_CONTINUATION_INDENT_CHARS);
      const indent = Array.from({ length: SOFT_WRAP_CONTINUATION_INDENT_CHARS }, () => indentGlyph);
      rows.push([...indent, ...glyphs.slice(cursor, cursor + contentLen)]);
      cursor += contentLen;
    }
  });
  return rows;
}

/** Paints one already-tokenized source line's glyph rows onto its own small bitmap, one
 * character at a time at its own measured advance width (spec.md FR9 — no `fillText` call ever
 * spans multiple characters, so no shaping engine gets the chance to substitute a ligature
 * glyph; this is also what keeps typewriter/annotation char-index-to-pixel-x exact, FR5). Row
 * splitting/flattening is deferred to inside the returned closure so a cache hit never pays for
 * it (only invoked by `BitmapCache.getOrRender` on a miss). */
function paintLine(tokens: Token[], layoutLine: LayoutLine, fontSize: number, lineHeightPx: number, opacity: number): (ctx: SKRSContext2D) => void {
  return (ctx) => {
    const rows = glyphRows(tokens, layoutLine);
    const advance = measureLine(1, fontSize);
    ctx.textBaseline = "top";
    ctx.globalAlpha = opacity;
    rows.forEach((glyphs, rowIndex) => {
      let x = 0;
      const y = rowIndex * lineHeightPx;
      for (const g of glyphs) {
        if (g.ch !== " " && g.ch !== "\t" && g.ch !== "") {
          ctx.font = fontStringFor(fontSize, g.fontStyle);
          ctx.fillStyle = g.color || "#ffffff";
          ctx.fillText(g.ch, x, y);
          if (g.fontStyle & FONT_STYLE_UNDERLINE) {
            ctx.fillRect(x, y + fontSize * 1.1, advance, Math.max(1, fontSize * 0.06));
          }
        }
        x += advance;
      }
    });
    ctx.globalAlpha = 1;
  };
}

/** Truncates a token run to its first `charCount` characters, splitting the last token that
 * straddles the cut (never a whole-token drop mid-token) — used only for typewriter's single
 * in-flight line (spec.md FR8/FR10), never for a cached line. */
function truncateTokens(tokens: Token[], charCount: number): Token[] {
  if (charCount <= 0) return [];
  const result: Token[] = [];
  let remaining = charCount;
  for (const t of tokens) {
    if (remaining <= 0) break;
    if (t.text.length <= remaining) {
      result.push(t);
      remaining -= t.text.length;
    } else {
      result.push({ ...t, text: t.text.slice(0, remaining) });
      remaining = 0;
    }
  }
  return result;
}

/** Locates the visual row + in-row column a source-line char index (`typewriterState`'s
 * `partialLineChars`, counted against the tab-expanded, pre-wrap line — `layout.ts`'s
 * `LayoutResult.lineCharCounts`) falls into, mirroring `glyphRows`' own row-cursor walk above
 * (never re-deriving `layoutLine.rows`' split, only replaying its per-row lengths) — the
 * typewriter caret's pixel position for a `wrap: "soft"` line that has already wrapped. */
function caretPosition(layoutLine: LayoutLine, fontSize: number, charIndex: number): { x: number; row: number } {
  if (layoutLine.rows.length <= 1) return { x: measureLine(charIndex, fontSize), row: 0 };
  let cursor = 0;
  for (let r = 0; r < layoutLine.rows.length; r++) {
    const rowLen = layoutLine.rows[r]!.length;
    const contentLen = r === 0 ? rowLen : Math.max(0, rowLen - SOFT_WRAP_CONTINUATION_INDENT_CHARS);
    const isLastRow = r === layoutLine.rows.length - 1;
    if (charIndex <= cursor + contentLen || isLastRow) {
      const col = r === 0 ? charIndex - cursor : SOFT_WRAP_CONTINUATION_INDENT_CHARS + (charIndex - cursor);
      return { x: measureLine(Math.max(0, col), fontSize), row: r };
    }
    cursor += contentLen;
  }
  return { x: measureLine(charIndex, fontSize), row: 0 };
}

// --- Diff background tint (spec.md FR11) -------------------------------------------------------

// "a fixed green/red at low alpha" (spec.md FR11's documented default) — the fade-in itself
// (`diffFadeAlpha` below) further scales this via `ctx.globalAlpha`, so the settled, fully-
// revealed tint is this colour's own (already-low) alpha, not a value that ramps up to opaque.
const DEFAULT_ADDED_BG = "rgba(46, 160, 67, 0.18)";
// Reserved for a future render path that can show a removed line as its own row. `ir.lines`/
// `layout.lines` (`highlight.ts`/`layout.ts`, both outside T11's file list) are built purely from
// `layer.code` — diff's **after** state (spec.md FR1) — so a `"removed"` diff entry (one that
// only ever existed in `diff.before`) has no layout row to tint against in this render path. Kept
// here, unused, so the constant exists the moment a later change adds that row.
const DEFAULT_REMOVED_BG = "rgba(248, 81, 73, 0.18)";
void DEFAULT_REMOVED_BG;

/** `elapsed / duration` fade-in, clamped to `[0, 1]`, starting at `diff.revealDelay` seconds
 * (spec.md FR11: "fade in over `diff.duration` seconds starting at `diff.revealDelay`"). A small,
 * deliberate duplication of `animations.ts`'s own unexported `progressFor` shape (linear, no
 * easing — `diffSchema` has no `easing` field, unlike `focus.animate`/`scroll`) rather than
 * widening that file's exports for a three-line pure formula this file cannot otherwise reach
 * (T11 must not modify `animations.ts`). */
function diffFadeAlpha(diff: CodeDiff, frameLocal: number, fps: number): number {
  const delay = diff.revealDelay ?? 0;
  const duration = diff.duration ?? 0;
  const elapsed = frameLocal / fps - delay;
  if (duration <= 0) return elapsed >= 0 ? 1 : 0;
  return Math.min(1, Math.max(0, elapsed / duration));
}

/** Maps `diff.ts`'s `diffLines(diff.before, code)` output onto `ir.lines`' own index space:
 * `"removed"` entries are filtered out (they consume `before`'s cursor only, never `after`'s —
 * see `diff.ts`'s own backtracking doc comment), so what remains, in order, is exactly one entry
 * per `code.split("\n")` line — the same order/count as `ir.lines`/`layout.lines`. Returns `true`
 * at index `i` when line `i` is `"added"` (spec.md Edge Cases: `diff.before === code` naturally
 * yields every entry `"unchanged"`, i.e. every flag `false`, "no special-cased early-return
 * needed"). */
function addedLineFlags(diff: CodeDiff, code: string): boolean[] {
  return diffLines(diff.before, code)
    .filter((entry) => entry.kind !== "removed")
    .map((entry) => entry.kind === "added");
}

// --- Annotations (spec.md FR12; drawn directly, never cached — small count per block) ----------

/** A small colour-bar-plus-label marker at `annotationPosition`'s `(x, y)` (translated by the
 * caller into the content box's chrome-relative + scroll-adjusted coordinates, the same
 * `contentLeftPx`/`contentTopPx`/`scrollOffsetPx` translation every line bitmap already gets).
 * Uncached by design (spec.md FR8: "small count, never cached" note) — a plain direct paint. */
function paintAnnotationMarker(
  ctx: SKRSContext2D,
  annotation: CodeAnnotation,
  x: number,
  y: number,
  lineHeightPx: number,
  fontSize: number,
  colors: ChromeColors,
): void {
  const color = annotation.color ?? "#f0b429";
  const markerWidthPx = 4;
  const labelFontSize = Math.max(11, Math.round(fontSize * 0.65));

  ctx.save();
  ctx.fillStyle = color;
  ctx.fillRect(x, y, markerWidthPx, lineHeightPx);

  ctx.font = `600 ${labelFontSize}px ${MONO_FONT_FAMILY}`;
  ctx.fillStyle = colors.titleBarText;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  // Same "marker bar, then label to its right" layout for both `side`s — `annotationPosition`
  // (`annotate.ts`) already placed `x` on the declared side (gutter-adjacent for `"left"`, past
  // the longest line for `"right"`); this function just paints at whatever `x` it is handed.
  ctx.fillText(annotation.text, x + markerWidthPx + GUTTER_PADDING_PX / 2, y + lineHeightPx / 2);
  ctx.restore();
}

function drawLineNumber(ctx: SKRSContext2D, lineNumber: number, y: number, gutterWidthPx: number, fontSize: number, color: string): void {
  ctx.save();
  ctx.font = `400 ${fontSize}px ${MONO_FONT_FAMILY}`;
  ctx.fillStyle = color;
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(String(lineNumber), CHROME_BORDER_PX + CHROME_PADDING_PX + gutterWidthPx - GUTTER_PADDING_PX, y);
  ctx.restore();
}

// --- `paintCodeLayer` (spec.md FR7/FR8/FR9; design.md's `paintCodeLayer` section) --------------

/** The composited-frame entry point: blit chrome, tint diff backgrounds, blit each revealed
 * line's cached bitmap at its layout-derived `y` offset (or paint the one in-flight typewriter
 * line directly, uncached), draw line numbers + annotations directly (small, uncached — spec.md
 * FR8's "never cached" note), draw the caret if enabled. Throws `CodeOverflowError` first if
 * `entry.blocked` (FR7).
 *
 * T11: `frameLocal` (with `DEFAULT_FPS`, see that constant's own doc comment on why a real `fps`
 * isn't available here) drives `animations.ts`'s pure `typewriterState`/`lineStaggerDelays`/
 * `focusState`/`scrollOffsetPx` every call — this function re-derives per-frame state each time
 * rather than caching it itself, matching every other pure-function-per-frame call site in this
 * codebase (e.g. `003`'s `compileMotion` resolvers). */
export function renderCodeFrame(
  entry: CompiledCodeLayer,
  layer: CodeLayer,
  lineCache: LineCache,
  chromeCache: ChromeCache,
  ctx: SKRSContext2D,
  frameLocal = 0,
): void {
  if (entry.blocked) throw new CodeOverflowError();

  const theme = layer.theme ?? "github-dark";
  const showLineNumbers = layer.showLineNumbers ?? false;
  const { layout, ir } = entry;
  const fps = DEFAULT_FPS;

  const cKey = chromeKey(layer.width, layer.height, theme, layer.title, showLineNumbers);
  const chrome = chromeCache.getOrRender(cKey, layer.width, layer.height, paintChrome(layer, theme));
  ctx.drawImage(chrome, 0, 0);

  // --- Per-frame animation state (spec.md FR10, animations.ts) ---------------------------------
  // `revealedCount`/`staggerVisible`/`partialLine*` together decide which of `ir.lines` paint
  // this frame at all (and, for the one typewriter in-flight line, how much of it) — the reveal
  // state that D2 says "decides which cache entries get painted", not a `globalAlpha` bracket.
  let revealedCount = ir.lines.length;
  let staggerVisible: boolean[] | null = null;
  let partialLineIndex = -1;
  let partialLineChars = 0;
  let caretOn = false;

  if (layer.reveal?.mode === "typewriter") {
    const state = typewriterState(layer.reveal, frameLocal, fps, layout.lineCharCounts);
    revealedCount = state.revealedLines;
    caretOn = state.caretOn;
    if (state.partialLineChars > 0 && state.revealedLines < ir.lines.length) {
      partialLineIndex = state.revealedLines;
      partialLineChars = state.partialLineChars;
    }
  } else if (layer.reveal?.mode === "line-stagger") {
    const delaysSec = lineStaggerDelays(ir.lines.length, layer.reveal.each, layer.reveal.from);
    const elapsedSeconds = frameLocal / fps;
    staggerVisible = delaysSec.map((delay) => elapsedSeconds >= delay);
  }

  const focus = layer.focus ? focusState(layer.focus, frameLocal, fps) : null;
  const dimOpacity = focus?.dimOpacity ?? 0.35;
  const scrollPx = layer.scroll ? scrollOffsetPx(layer.scroll, frameLocal, fps, layout.lineHeightPx) : 0;
  const addedFlags = layer.diff ? addedLineFlags(layer.diff, layer.code) : null;
  const diffAlpha = layer.diff ? diffFadeAlpha(layer.diff, frameLocal, fps) : 0;
  // --- end per-frame animation state ------------------------------------------------------------

  const contentTopPx = CHROME_TITLE_BAR_PX + CHROME_BORDER_PX + CHROME_PADDING_PX;
  const contentLeftPx = CHROME_BORDER_PX + CHROME_PADDING_PX + layout.gutterWidthPx;
  const colors = chromeColorsFor(theme);

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    CHROME_BORDER_PX,
    contentTopPx,
    layer.width - 2 * CHROME_BORDER_PX,
    Math.max(0, layer.height - contentTopPx - CHROME_BORDER_PX - CHROME_PADDING_PX),
  );
  ctx.clip();

  for (let i = 0; i < ir.lines.length; i++) {
    const isPartial = i === partialLineIndex;
    const isRevealed = staggerVisible ? (staggerVisible[i] ?? false) : i < revealedCount;
    if (!isRevealed && !isPartial) continue;

    const line = ir.lines[i];
    const layoutLine = layout.lines[i];
    if (!line || !layoutLine) continue;

    const rowCount = Math.max(1, layoutLine.rows.length);
    const y = contentTopPx + layoutLine.y - scrollPx;

    // Diff background tint (spec.md FR11) — a separate, uncached rect painted *underneath* the
    // line's own bitmap, never folded into `lineKey` (Key Decision D6's `ctx.globalAlpha`
    // pattern extended: baking a continuously-animated fade-in alpha into the per-line cache key
    // would produce a near-unbounded number of near-duplicate bitmaps, defeating FR8's cache).
    if (addedFlags?.[i] && diffAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = diffAlpha;
      ctx.fillStyle = layer.diff?.addedBg ?? DEFAULT_ADDED_BG;
      ctx.fillRect(CHROME_BORDER_PX, y, layer.width - 2 * CHROME_BORDER_PX, rowCount * layout.lineHeightPx);
      ctx.restore();
    }

    if (isPartial) {
      // Typewriter's in-flight line: painted directly onto `ctx`, never through `lineCache`
      // (spec.md FR8's "the one thing that is never cached, by design").
      const truncated = truncateTokens(line.tokens, partialLineChars);
      ctx.save();
      ctx.translate(contentLeftPx, y);
      paintLine(truncated, layoutLine, layout.fontSize, layout.lineHeightPx, 1)(ctx);
      ctx.restore();

      if (showLineNumbers) drawLineNumber(ctx, i + 1, y, layout.gutterWidthPx, layout.fontSize, colors.gutterText);

      if (caretOn) {
        const caret = caretPosition(layoutLine, layout.fontSize, partialLineChars);
        const caretWidthPx = Math.max(1, layout.fontSize * 0.08);
        ctx.fillStyle = colors.titleBarText;
        ctx.fillRect(contentLeftPx + caret.x, y + caret.row * layout.lineHeightPx, caretWidthPx, layout.fontSize);
      }
      continue;
    }

    const dimmed = focus ? i + 1 < focus.range[0] || i + 1 > focus.range[1] : false;
    const key = lineKey(line.tokens, layout.fontSize, theme, dimmed, layout.contentWidthPx);
    const bitmap = lineCache.getOrRender(
      key,
      layout.contentWidthPx,
      rowCount * layout.lineHeightPx,
      paintLine(line.tokens, layoutLine, layout.fontSize, layout.lineHeightPx, dimmed ? dimOpacity : 1),
    );
    ctx.drawImage(bitmap, contentLeftPx, y);

    if (showLineNumbers) {
      drawLineNumber(ctx, i + 1, y, layout.gutterWidthPx, layout.fontSize, colors.gutterText);
    }
  }

  // Annotations (spec.md FR12) — drawn directly, uncached, inside the same clip region as the
  // lines above (their `x` can land past the longest line for `side: "right"`, still within the
  // clip's box-minus-border width). `annotate.ts`'s `annotationPosition` throws for an
  // out-of-range `annotation.line` (its own doc comment: that should already be a compile-time
  // `diagnostics.ts` diagnostic blocking this call entirely) — a defensive bounds check here
  // means a caller that renders past a diagnostic it should have stopped on still doesn't crash
  // the paint loop over one bad annotation.
  for (const annotation of layer.annotations ?? []) {
    if (annotation.line < 1 || annotation.line > layout.lines.length) continue;
    if (frameLocal / fps < (annotation.delay ?? 0)) continue;
    const pos = annotationPosition(annotation, layout);
    paintAnnotationMarker(
      ctx,
      annotation,
      contentLeftPx + pos.x,
      contentTopPx + pos.y - scrollPx,
      layout.lineHeightPx,
      layout.fontSize,
      colors,
    );
  }

  ctx.restore();
}

// Lazily-created default cache pair for `paintCodeLayer`'s own `PainterFn`-shaped call site
// (below) — the registry (`registerPainter`) hands it a plain function reference with no room
// for constructor injection, so this is the one process-wide instance the real render pipeline
// uses. Direct callers of `renderCodeFrame` (tests, or a future integration layer that wants
// isolation) construct and pass their own `createLineCache()`/`createChromeCache()` instead.
let defaultLineCacheInstance: LineCache | undefined;
let defaultChromeCacheInstance: ChromeCache | undefined;

function defaultLineCache(): LineCache {
  if (!defaultLineCacheInstance) defaultLineCacheInstance = createLineCache();
  return defaultLineCacheInstance;
}

function defaultChromeCache(): ChromeCache {
  if (!defaultChromeCacheInstance) defaultChromeCacheInstance = createChromeCache();
  return defaultChromeCacheInstance;
}

/**
 * The function `index.ts` registers via `registerPainter("code", paintCodeLayer)` (T11's own
 * side effect, run at module load)
 * (`packages/renderer-canvas/src/painters.ts`'s `PainterFn` shape:
 * `(entry: unknown, timelineLayer: TimelineLayer, frame: number, ctx: SKRSContext2D) => void`)
 * — already conformant here so that registration is a pure wiring step with no signature
 * change needed. `entry` is cast to `CompiledCodeLayer`: per `painters.ts`'s own contract, a
 * registered painter's closure is responsible for casting `entry`/`timelineLayer.layer` on its
 * own side, since `renderer-canvas` has no knowledge of this package's compiled-layer shape.
 * Assembling the real `CompiledCodeLayer` `entry` this receives at each call site (from
 * `compileCodeLayers`'s output) is the render pipeline's job, not this file's.
 */
export function paintCodeLayer(entry: unknown, timelineLayer: TimelineLayer, frame: number, ctx: SKRSContext2D): void {
  if (!isCodeLayer(timelineLayer.layer)) return;
  const layer = timelineLayer.layer;
  const compiled = entry as CompiledCodeLayer;
  const frameLocal = frame - timelineLayer.startFrame;
  renderCodeFrame(compiled, layer, defaultLineCache(), defaultChromeCache(), ctx, frameLocal);
}
