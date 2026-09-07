// Pure `(frameLocal, fps, config) => state` animation primitives for the `code` layer's
// `reveal`/`focus`/`scroll` behaviors (spec.md FR10; design.md Key Decision D2). Deliberately
// independent of `@claudevid/motion`'s `Track`/`evaluate`/`Channel`/`PropertyBag` machinery — D2
// explains why: code's reveal/focus/scroll state decides *which cache entries get painted*, not
// a `ctx.transform`/`globalAlpha` bracket around an already-rendered bitmap, so it doesn't fit
// `motion`'s six-free-channel cost-class contract. Only two of `motion`'s exports are reused
// directly, because they generalize cleanly and this module must never re-implement them
// (spec.md FR10 / Dependencies): `orderIndices` (`packages/motion/src/stagger.ts`, the FNV-1a
// deterministic stagger ordering) and `resolveEasing` (`packages/motion/src/easing.ts`).
//
// Every function here: plain numbers/arrays/config objects in, plain data out — no canvas, no
// Shiki, no `Track`/`Channel`/`PropertyBag` type anywhere (NFR2's grep-based import check
// enforces the no-Shiki half; this file also never imports `highlight.ts`). No `Math.random`,
// no wall-clock read — same frame-purity/determinism guarantee `motion`'s `NFR2` already
// established (spec.md `NFR4`).

import { orderIndices, resolveEasing, type StaggerSpec } from "@claudevid/motion";
import type { CodeFocus, CodeReveal, CodeScroll } from "./schema.js";

// --- Shared helpers ----------------------------------------------------------------------------

function clamp01(t: number): number {
  if (Number.isNaN(t)) return 0;
  return Math.min(1, Math.max(0, t));
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** `elapsed / duration`, clamped to `[0, 1]`. `duration <= 0` is treated as "already complete"
 * (`t = 1`) rather than dividing by zero — schema-valid `focus.animate.duration`/`scroll
 * .duration` are always `z.number().positive()`, but this is a pure function with no schema
 * gate of its own, so it stays well-defined for any numeric input. */
function progressFor(elapsedSeconds: number, duration: number): number {
  if (duration <= 0) return elapsedSeconds >= 0 ? 1 : 0;
  return clamp01(elapsedSeconds / duration);
}

// --- `typewriterState` (spec.md FR10, `reveal.mode === "typewriter"`) --------------------------

/** The narrowed member of `CodeReveal`'s discriminated union this function actually consumes —
 * `typewriterState` is only ever called when `layer.reveal?.mode === "typewriter"` (design.md's
 * `paintCodeLayer` section), so the caller has already narrowed; this alias keeps that contract
 * visible in the signature instead of accepting the full `CodeReveal` union and re-deriving the
 * same `mode` check internally. */
export type TypewriterReveal = Extract<CodeReveal, { mode: "typewriter" }>;

/** Default reveal rate per `reveal.unit`, in units/sec (spec.md FR10). */
const DEFAULT_TYPEWRITER_RATE: Record<NonNullable<TypewriterReveal["unit"]>, number> = {
  char: 30,
  token: 8,
  line: 2,
};

export interface TypewriterState {
  /** Count of fully-revealed source lines (0-based count, i.e. lines `[0, revealedLines)` are
   * fully shown). */
  revealedLines: number;
  /** Chars revealed into the line at index `revealedLines` (the one in-flight, never-cached
   * line, spec.md FR8). `0` once `revealedLines` covers every line. */
  partialLineChars: number;
  /** Whether the caret should be drawn this frame — `false` before `reveal.startDelay` has
   * elapsed, before revealing starts, or if `reveal.caret === false`. */
  caretOn: boolean;
}

/**
 * Pure frame-in/state-out typewriter reveal (spec.md FR10). `lineLengths` is the per-line reveal
 * unit count in `reveal.unit`'s own units — `layout.ts`'s `LayoutResult.lineCharCounts` for
 * `unit: "char"` (the default), or the caller's own per-line token/line count for `unit:
 * "token"`/`"line"` (this function is generic over what one "unit" is; it just consumes counts).
 * For `unit: "line"`, `lineLengths.length` (not the individual counts) is what bounds
 * `revealedLines` — each line is revealed atomically, at `rate` lines/sec.
 */
export function typewriterState(
  reveal: TypewriterReveal,
  frameLocal: number,
  fps: number,
  lineLengths: number[],
): TypewriterState {
  const unit = reveal.unit ?? "char";
  const rate = reveal.rate ?? DEFAULT_TYPEWRITER_RATE[unit];
  const startDelay = reveal.startDelay ?? 0;
  const caretEnabled = reveal.caret ?? true;

  const elapsedSeconds = frameLocal / fps;
  const started = elapsedSeconds >= startDelay;
  const revealingElapsed = Math.max(0, elapsedSeconds - startDelay);

  // Fixed 2 Hz blink, pure function of `frameLocal`/`fps` — no timers (spec.md FR10).
  const blinkOn = Math.floor(frameLocal / (fps / 4)) % 2 === 0;
  const caretOn = caretEnabled && started && blinkOn;

  if (unit === "line") {
    const revealedLines = Math.min(lineLengths.length, Math.max(0, Math.floor(revealingElapsed * rate)));
    return { revealedLines, partialLineChars: 0, caretOn };
  }

  // "char" / "token": walk lines in order, consuming revealed units cumulatively until the
  // in-flight line is found.
  let remaining = Math.max(0, Math.floor(revealingElapsed * rate));
  let revealedLines = 0;
  let partialLineChars = 0;
  for (const len of lineLengths) {
    if (remaining >= len) {
      remaining -= len;
      revealedLines++;
    } else {
      partialLineChars = remaining;
      remaining = 0;
      break;
    }
  }
  if (revealedLines >= lineLengths.length) partialLineChars = 0;

  return { revealedLines: Math.min(revealedLines, lineLengths.length), partialLineChars, caretOn };
}

// --- `lineStaggerDelays` (spec.md FR10, `reveal.mode === "line-stagger"`) ----------------------

/**
 * Per-line reveal delays (seconds) for `reveal.mode === "line-stagger"` (spec.md FR10).
 * Delegates the stagger ordering to `@claudevid/motion`'s exported `orderIndices` — never
 * reimplements the FNV-1a hashing or ordering logic (`packages/motion/src/stagger.ts`). Since
 * `orderIndices` orders by a child's own string key (only load-bearing for `from: "random"`'s
 * hash), and this function only has a count of children (not each line's own identity), each
 * line's positional index (as a string) stands in for its key — `orderIndices`'s `"first"`/
 * `"last"`/`"center"` orderings are purely positional anyway, and `"random"`'s hash-of-index is
 * still deterministic across calls with the same `childCount` (`NFR4`), matching `003`'s exact
 * determinism guarantee reused here rather than re-derived.
 */
export function lineStaggerDelays(childCount: number, each: number, from: StaggerSpec["from"] = "first"): number[] {
  const childKeys = Array.from({ length: childCount }, (_, i) => String(i));
  const ranks = orderIndices(childKeys, from);
  return ranks.map((rank) => rank * each);
}

// --- `focusState` (spec.md FR10) ----------------------------------------------------------------

export interface FocusState {
  /** Currently-focused line range, `[startLine, endLine]`, 1-indexed inclusive — may be
   * fractional mid-animation (the animated band sweeps smoothly across line boundaries rather
   * than snapping, so `render.ts`'s per-line `i + 1 < range[0] || i + 1 > range[1]` dim check
   * transitions one line at a time as the band passes through it). */
  range: [number, number];
  /** Opacity applied to dimmed (out-of-range) lines. */
  dimOpacity: number;
}

/**
 * Pure frame-in/state-out focus-band state (spec.md FR10). Static `focus.lines` when there is no
 * `focus.animate`; otherwise each range endpoint independently lerps from `focus.animate.from`
 * to `focus.lines` over `focus.animate.duration` seconds (after `focus.animate.delay`), eased by
 * `resolveEasing(focus.animate.easing ?? "linear")` — imported directly from `@claudevid/motion`,
 * never re-implemented (design.md's Grounding note).
 */
export function focusState(focus: CodeFocus, frameLocal: number, fps: number): FocusState {
  const dimOpacity = focus.dimOpacity ?? 0.35;

  if (!focus.animate) {
    return { range: [focus.lines[0], focus.lines[1]], dimOpacity };
  }

  const { from, duration, delay = 0, easing } = focus.animate;
  const elapsedSeconds = frameLocal / fps - delay;
  const t = progressFor(elapsedSeconds, duration);
  const progress = resolveEasing(easing ?? "linear")(t);

  return {
    range: [lerp(from[0], focus.lines[0], progress), lerp(from[1], focus.lines[1], progress)],
    dimOpacity,
  };
}

// --- `scrollOffsetPx` (spec.md FR10) -------------------------------------------------------------

/**
 * Pure frame-in/pixel-out vertical scroll offset for `reveal.mode` `scroll`'s config (spec.md
 * FR10). Lerps `(scroll.fromLine ?? 1)` to `scroll.toLine` (both 1-indexed) over `scroll
 * .duration` seconds (after `scroll.delay`), eased by `resolveEasing(scroll.easing ?? "linear")`
 * — the same `@claudevid/motion` reuse `focusState` makes. The result is `(currentLine - 1) *
 * lineHeightPx`, so `fromLine: 1` (the default) starts at a `0` offset — line 1's own layout `y`
 * position (`layout.ts`'s `LayoutLine.y`, spec.md FR12's single source of truth).
 */
export function scrollOffsetPx(scroll: CodeScroll, frameLocal: number, fps: number, lineHeightPx: number): number {
  const fromLine = scroll.fromLine ?? 1;
  const { toLine, duration, delay = 0, easing } = scroll;

  const elapsedSeconds = frameLocal / fps - delay;
  const t = progressFor(elapsedSeconds, duration);
  const progress = resolveEasing(easing ?? "linear")(t);
  const currentLine = lerp(fromLine, toLine, progress);

  return (currentLine - 1) * lineHeightPx;
}
