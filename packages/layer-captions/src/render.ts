// `paintCaptionsLayer` — the karaoke-highlight painter for the `captions` layer (spec.md FR6;
// design.md's Architecture diagram / Key Decision D7). Registered via
// `registerPainter("captions", paintCaptionsLayer)` in `index.ts`, mirroring
// `packages/layer-code/src/index.ts`'s exact two-registration pattern.
//
// Key Decision D7 (design.md): active-word emphasis is a *direct frame-time comparison* inside
// this painter, not a new `packages/motion` track type — `layer.words`' `[start, end)` windows
// are compared against the current frame's timestamp directly; the layer's own enter/exit still
// goes through the existing generic `animation` field like every other layer (unaffected by this
// file). This file therefore has no dependency on `@claudevid/motion` despite the package
// depending on it (per design.md's Architecture section, that dependency exists for a caller
// that wants to build its own captions-adjacent motion, not for this painter to consume).
//
// `schema.ts`'s own header comment on `captionsLayerSchema` documents that a `captions` layer's
// `words[].start`/`end` are **timeline-absolute** seconds by the time they reach this painter —
// the block-relative-to-absolute offset (spec.md's Edge Cases: "applied by exactly one caller")
// has already been applied by whoever assembled the `VideoSpec`'s captions layer from 006's
// scene-window data. This painter therefore compares `frame`-derived time directly against
// `word.start`/`word.end` as given, with no additional offset of its own — it does not subtract
// `timelineLayer.startFrame` the way `packages/layer-code/src/render.ts`'s `paintCodeLayer` does
// for its own (layer-local) reveal/focus/scroll animations, because captions' word timings are
// not layer-local.

import type { SKRSContext2D } from "@napi-rs/canvas";
import type { TimelineLayer } from "@claudevid/core";
import type { WordTiming } from "@claudevid/audio";
import type { CaptionsLayer } from "./schema.js";

// Mirrors `packages/layer-code/src/render.ts`'s own `DEFAULT_FPS` precedent verbatim: `PainterFn`
// (`packages/renderer-canvas/src/painters.ts`) is `(entry, timelineLayer, frame, ctx) => void` —
// no `fps` parameter — and neither `TimelineLayer` nor `Timeline`
// (`packages/core/src/timeline.ts`) carries the compiled `VideoSpec.fps` through to paint time
// (only `compileTimeline`'s own frame-math, at compile time, uses it). Widening `PainterFn`'s
// signature or `TimelineLayer`'s shape to thread a real `fps` through is out of this task's scope
// (both are files this task must not touch). `VideoSpec.fps`'s own Zod default
// (`packages/core/src/schema.ts:58`, `z.number().positive().default(30)`) is the same smallest
// defensible stand-in `layer-code` already adopted for this exact gap.
const DEFAULT_FPS = 30;

// A small, deliberate duplication of `packages/renderer-canvas/src/fonts.ts`'s own
// `SANS_FONT_FAMILY` value — that constant is not part of `renderer-canvas`'s public surface
// (`packages/renderer-canvas/src/index.ts` never re-exports `fonts.ts`), so it is restated here
// rather than reopening a sealed package's internals for one string, following
// `packages/layer-code/src/render.ts`'s own precedent for `MONO_FONT_FAMILY`.
const CAPTIONS_FONT_FAMILY = "Inter, sans-serif";

const BASE_FONT_SIZE_PX = 48;
const ACTIVE_FONT_SCALE = 1.15;
const ACTIVE_WORD_COLOR = "#ffd60a";
const INACTIVE_WORD_COLOR = "#ffffff";
const WORD_GAP_PX = 14;

function fontStringFor(fontSizePx: number): string {
  return `700 ${fontSizePx}px ${CAPTIONS_FONT_FAMILY}`;
}

// --- `TimelineLayer.layer` narrowing (mirrors `packages/layer-code/src/render.ts`'s own
// `isCodeLayer` — see that file's header comment: `core.Layer` is a closed static union with no
// "captions" member; `registerLayer` only extends the *runtime* Zod union, so this is the one
// place `render.ts` crosses that static-type gap). ------------------------------------------------

export function isCaptionsLayer(layer: { type: string }): layer is CaptionsLayer {
  return layer.type === "captions";
}

// --- Active-word lookup (spec.md FR6/AC5; design.md Key Decision D7) ---------------------------

/**
 * Pure "what word is active right now" lookup, extracted so it's testable without a canvas
 * context. Returns the index of the word whose `[start, end)` window contains
 * `currentTimeSeconds`, or `null` if no word is active (before the first word, in a gap between
 * two words, or after the last word). The `start <= t < end` convention means a word's own `end`
 * boundary belongs to whichever word (if any) starts there next — never double-counted, and
 * never active past its own window.
 */
export function findActiveWordIndex(words: WordTiming[], currentTimeSeconds: number): number | null {
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (currentTimeSeconds >= word.start && currentTimeSeconds < word.end) return i;
  }
  return null;
}

// --- `paintCaptionsLayer` ------------------------------------------------------------------------

/**
 * The function `index.ts` registers via `registerPainter("captions", paintCaptionsLayer)`
 * (`packages/renderer-canvas/src/painters.ts`'s `PainterFn` shape: `(entry: unknown,
 * timelineLayer: TimelineLayer, frame: number, ctx: SKRSContext2D) => void`). `entry` is unused —
 * unlike `layer-code`'s `CompiledCodeLayer` (a compile-time tokenized IR), everything this
 * painter needs (`words`) already lives on `timelineLayer.layer` itself, so there is no separate
 * compiled artifact to cast.
 *
 * `renderer-canvas`'s own render loop (`packages/renderer-canvas/src/index.ts`) already
 * `ctx.translate`s to the layer's resolved `(x, y)` before calling a registered painter, so this
 * function draws at the local origin `(0, 0)` — one horizontal line of words, left-to-right, the
 * currently-active word (per `findActiveWordIndex`) drawn larger and in a distinct color
 * ("karaoke highlight", spec.md FR6's one shipped style). This is deliberately simple (a single
 * line, no wrapping) — a correct, simple implementation over an incomplete polished one.
 */
export function paintCaptionsLayer(entry: unknown, timelineLayer: TimelineLayer, frame: number, ctx: SKRSContext2D): void {
  void entry;
  if (!isCaptionsLayer(timelineLayer.layer)) return;
  // `core.Layer` is a closed static union with no "captions" member (see `isCaptionsLayer`'s own
  // doc comment), so control-flow narrowing on the guarded expression collapses to `never` here
  // rather than `CaptionsLayer` (a TS limitation for a type predicate disjoint from every union
  // member) — an explicit cast, not a second runtime check (the `if` above already performed
  // that), is needed to actually use `layer.words` below. `layer-code`'s `isCodeLayer` call site
  // never hits this because it only ever forwards the narrowed variable into another function's
  // explicitly-typed parameter, never accessing a property on it inline in the same scope.
  const layer = timelineLayer.layer as CaptionsLayer;

  const currentTimeSeconds = frame / DEFAULT_FPS;
  const activeIndex = findActiveWordIndex(layer.words, currentTimeSeconds);

  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  let x = 0;
  for (let i = 0; i < layer.words.length; i++) {
    const word = layer.words[i]!;
    const isActive = i === activeIndex;
    const fontSizePx = isActive ? BASE_FONT_SIZE_PX * ACTIVE_FONT_SCALE : BASE_FONT_SIZE_PX;

    ctx.font = fontStringFor(fontSizePx);
    ctx.fillStyle = isActive ? ACTIVE_WORD_COLOR : INACTIVE_WORD_COLOR;
    ctx.fillText(word.word, x, 0);
    x += ctx.measureText(word.word).width + WORD_GAP_PX;
  }

  ctx.restore();
}
