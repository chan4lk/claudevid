// Line-anchored callout positioning (spec.md FR12). `annotationPosition` reads the target
// line's vertical position from `layout.ts`'s own per-line offset table — the exact same
// `LayoutLine.y` values `render.ts` already reads to place line bitmaps — rather than
// re-deriving `line * lineHeightPx` here, which could silently drift from `layout.ts`'s math
// (soft-wrap continuation rows, auto-fit's per-render `fontSize`/`lineHeightPx`, etc. all
// already live there and nowhere else — `layout.ts`'s own header comment names this file
// explicitly as one of the two readers that must never re-derive it).
//
// Both `x` and `y` returned here are relative to the code content box's own top-left corner —
// the same origin `LayoutLine.y` already uses (before `render.ts`'s chrome translation). This
// mirrors `layout.ts`'s own "pure data, no canvas painting" boundary: `annotationPosition`'s
// signature (spec.md FR12) takes only `CodeAnnotation`/`LayoutResult`, no `CodeLayer`/canvas
// box, so it has no `contentTopPx`/`contentLeftPx` to translate by even if it wanted to.
// `render.ts` (T11) adds those chrome constants when it actually paints an annotation, exactly
// as it already does for line bitmaps (`contentTopPx + layoutLine.y`, `contentLeftPx + x`).
//
// `annotation.line` outside `[1, codeLineCount]` is `diagnostics.ts`'s
// `annotationLineOutOfRangeDiagnostic` job (spec.md FR12/FR13) — a compile-time diagnostic that
// blocks painting (`entry.blocked`, see `render.ts`) before `annotationPosition` would ever be
// called for that layer. This function assumes it is only ever invoked with an in-range
// `annotation.line` and throws rather than silently clamping if that assumption is violated —
// consistent with FR12's explicit "not a silently-clamped position" (the same fail-closed
// precedent `diagnostics.ts`'s own header comment documents for this exact field).

import { GUTTER_PADDING_PX, measureLine, type LayoutResult } from "./layout.js";
import type { CodeAnnotation } from "./schema.js";

/** Spec.md FR12's exact return shape: `{ x: number; y: number }`, both relative to the code
 * content box's top-left corner (see module header). */
export interface AnnotationPosition {
  x: number;
  y: number;
}

/**
 * Pixel position for a line-anchored callout (spec.md FR12). `y` is `layout.lines[annotation
 * .line - 1].y` verbatim (AC11: within `1px` of `layout`'s own recorded offset for the target
 * line, "verified against `layout.ts`'s output directly, not re-derived independently").
 *
 * `x` depends on `annotation.side` (`"left"` default, gutter-adjacent — `0`, the content box's
 * own left edge, immediately beside the gutter `render.ts` paints just to its left — or
 * `"right"`, past the longest line: the longest line's own measured width plus
 * `GUTTER_PADDING_PX` — the same gap constant `layout.ts` already uses between the gutter and
 * the first code column, reused here for a visually consistent gap rather than a new constant).
 */
export function annotationPosition(annotation: CodeAnnotation, layout: LayoutResult): AnnotationPosition {
  const line = layout.lines[annotation.line - 1];
  if (!line) {
    throw new RangeError(
      `annotationPosition: line ${annotation.line} is outside layout.lines' range (0 - ${layout.lines.length}); ` +
        `out-of-range annotation lines are diagnostics.ts's annotationLineOutOfRangeDiagnostic job ` +
        `(spec.md FR12/FR13) and should block painting before annotationPosition is ever called`,
    );
  }

  const side = annotation.side ?? "left";
  const x =
    side === "right" ? measureLine(layout.longestLineCharCount, layout.fontSize) + GUTTER_PADDING_PX : 0;

  return { x, y: line.y };
}
