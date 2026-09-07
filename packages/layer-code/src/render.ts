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
// Scope (T7): paints a fully-revealed, non-focused, non-diffed, non-scrolled static block
// correctly. `reveal`/`focus`/`diff`/`scroll`/`annotations` wiring is a later task's job
// (`animations.ts`/`diff.ts`/`annotate.ts` don't exist yet) — the extension point is marked
// below in `renderCodeFrame` so that later task can wire in real animation state without
// restructuring anything here.

import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import type { TimelineLayer } from "@claudevid/core";
import type { CodeLayer } from "./schema.js";
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

/** The composited-frame entry point: blit chrome, blit each revealed line's cached bitmap at
 * its layout-derived `y` offset, draw line numbers directly (small, uncached — same treatment
 * design.md gives annotations). Throws `CodeOverflowError` first if `entry.blocked` (FR7).
 *
 * Scope (T7): every line is treated as fully revealed, non-dimmed, non-scrolled — `frameLocal`
 * and `layer.reveal`/`layer.focus`/`layer.diff`/`layer.scroll`/`layer.annotations` are already
 * threaded through as the extension point a later task (wiring `animations.ts`/`diff.ts`/
 * `annotate.ts`) replaces the three `const`s below with real per-frame state, without needing
 * to restructure the cache/paint loop itself. */
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

  const cKey = chromeKey(layer.width, layer.height, theme, layer.title, showLineNumbers);
  const chrome = chromeCache.getOrRender(cKey, layer.width, layer.height, paintChrome(layer, theme));
  ctx.drawImage(chrome, 0, 0);

  // --- Extension point for a later task (animations.ts/diff.ts/annotate.ts wiring) ---
  void frameLocal;
  void layer.reveal;
  void layer.diff;
  void layer.scroll;
  const revealedLineCount = ir.lines.length; // later: typewriterState(...).revealedLines
  const dimmedRange: readonly [number, number] | null = null; // later: focusState(...).range
  const scrollOffsetPx = 0; // later: scrollOffsetPx(...)
  // --- end extension point ---

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

  for (let i = 0; i < revealedLineCount; i++) {
    const line = ir.lines[i];
    const layoutLine = layout.lines[i];
    if (!line || !layoutLine) continue;

    const dimmed = dimmedRange ? i + 1 < dimmedRange[0] || i + 1 > dimmedRange[1] : false;
    const rowCount = Math.max(1, layoutLine.rows.length);
    const key = lineKey(line.tokens, layout.fontSize, theme, dimmed, layout.contentWidthPx);
    const bitmap = lineCache.getOrRender(
      key,
      layout.contentWidthPx,
      rowCount * layout.lineHeightPx,
      paintLine(line.tokens, layoutLine, layout.fontSize, layout.lineHeightPx, dimmed ? (layer.focus?.dimOpacity ?? 0.35) : 1),
    );
    const y = contentTopPx + layoutLine.y - scrollOffsetPx;
    ctx.drawImage(bitmap, contentLeftPx, y);

    if (showLineNumbers) {
      drawLineNumber(ctx, i + 1, y, layout.gutterWidthPx, layout.fontSize, colors.gutterText);
    }
  }

  ctx.restore();

  // Annotations (spec.md FR12) are `annotate.ts`'s job (not built yet) — intentionally not
  // drawn here; `layer.annotations`' out-of-range validation is already `diagnostics.ts`'s
  // concern, independent of this file's rendering.
  void layer.annotations;
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
 * The function a later task registers via `registerPainter("code", paintCodeLayer)`
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
