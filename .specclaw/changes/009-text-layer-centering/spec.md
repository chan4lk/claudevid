# Spec: Text layer centering respects `align`

**Change:** 009-text-layer-centering
**Created:** 2026-09-08
**Status:** 🟡 Draft

## Overview

A `text` layer's `align` field currently only controls how *wrapped, multi-line* text is
justified relative to itself inside its own tightly-fit bitmap (`paintTextLayer`'s internal
`ctx.textAlign` in `packages/renderer-canvas/src/text.ts`). It has no effect on where that
bitmap is placed on the canvas: `packages/renderer-canvas/src/index.ts` always draws a text
bitmap with `layer.x`/`layer.y` as its top-left corner, regardless of `align`. Combined with
`packages/core/src/resolve.ts`'s `resolveAxis`, which resolves `x: "center"` to `width / 2` at
compile time, this means `x: "center"` + `align: "center"` places the text's *left edge* at the
canvas midpoint — not its visual center.

Notably, this diverges from the project's own original prototype (`docs/Qwen_markdown_...md`'s
"Simple text layer" example), which used the canvas API's native `ctx.textAlign = "center"`
together with `x = layer.x === "center" ? spec.width / 2 : layer.x`, producing genuinely centered
text out of the box. The current implementation lost that property when text layout moved to a
separately-measured, tightly-fit bitmap (needed for the raster cache) without carrying the anchor
math forward.

This change makes `align` affect the box's placement anchor, restoring the originally-intended
behavior: `x: "center"` + `align: "center"` visually centers the text, `align: "right"`
right-anchors it, and `align: "left"` (default) is unchanged.

## Requirements

### Functional Requirements

- **FR1:** When a `text` layer's `align` is `"center"`, the rendered bitmap's horizontal center
  is placed at the layer's resolved `x` (i.e. the bitmap's left edge is drawn at
  `x - bitmapWidth / 2`).
- **FR2:** When a `text` layer's `align` is `"right"`, the bitmap's right edge is placed at the
  resolved `x` (left edge drawn at `x - bitmapWidth`).
- **FR3:** When a `text` layer's `align` is `"left"` or omitted (the schema default), behavior is
  byte-identical to today: the bitmap's left edge is drawn at `x` (offset `0`).
- **FR4:** The anchor offset applies identically whether the layer is animated via
  `@claudevid/motion` (the `applyMotionTransform` path) or not (the direct `drawImage` path) —
  a rotated/scaled centered text layer still visually centers before any rotation/scale is
  applied, matching `applyMotionTransform`'s existing box-center pivot convention.
- **FR5:** No change to `resolveAxis`, the `VideoSpec` schema, or `paintTextLayer`'s internal
  multi-line justification logic — this is purely an anchor-offset fix at the point a text
  bitmap is placed on the canvas.
- **FR6:** `rect`, `image`, and any other layer type without an `align` field are unaffected —
  no schema field exists for them to read, so their placement is unchanged.

### Non-Functional Requirements

- **NFR1:** No new dependency, no schema version bump.
- **NFR2:** The fix must not regress the raster-cache behavior (change 010's predecessor,
  `1af6c54`) — `paintTextLayer`'s cache key and returned bitmap are unchanged; only the
  *placement* of that already-cached bitmap changes.

## Acceptance Criteria

- **AC1:** A `text` layer with `align: "center"` and a numeric `x` renders its bitmap centered
  on `x` — the painted pixels' bounding box (per `render.test.ts`'s existing
  `nonBackgroundBBox` helper) is horizontally centered on `x` to within half a pixel's rounding.
- **AC2:** A `text` layer with `align: "center"` and `x: "center"` renders its bitmap centered on
  the canvas's own horizontal midpoint (`width / 2`).
- **AC3:** A `text` layer with `align: "right"` and a numeric `x` renders its bitmap with its
  right edge at `x`.
- **AC4:** A `text` layer with `align: "left"` (or `align` omitted) renders identically to the
  current behavior — its bitmap's left edge is at `x` — proven by an existing or new test that
  would fail if FR3 regressed.
- **AC5:** The above hold both with and without an active `@claudevid/motion` track on the layer
  (i.e. exercising both the `applyMotionTransform` branch and the plain `drawImage` branch in
  `packages/renderer-canvas/src/index.ts`).
- **AC6:** `pnpm -w test` (or the equivalent per-package `vitest run`) passes with no regressions
  in `packages/renderer-canvas` or `packages/core`.

## Edge Cases

- **Wrapped multi-line centered text:** a layer with `maxWidth` set and `align: "center"` wraps
  into lines of differing width (`measureAndWrap`'s `totalWidth` is the widest line). The anchor
  offset uses `totalWidth` (already computed), so the widest line — not each individual line —
  is what's centered on `x`; narrower lines remain centered *within that same bitmap* via
  `paintTextLayer`'s existing internal `ctx.textAlign` handling. This is consistent with how the
  bitmap is a single tightly-fit box.
- **`align: "center"`/`"right"` with `x` unset:** `resolveAxis` already resolves an unset `x` to
  `dimension / 2` (same as `"center"`), so this behaves the same as `x: "center"`.
- **Negative or off-canvas resolved `x`:** unchanged — clipping/off-canvas placement is not a new
  concern introduced by this change; `drawImage` already tolerates a partially or fully
  off-canvas destination.

## Dependencies

None beyond the existing `packages/core` → `packages/renderer-canvas` relationship (`resolveAxis`
output consumed as-is; no change to its contract).

## Notes

Reference implementation for what "correct" centering looks like: a downstream consumer's
`bake-centering.mjs` script (in a sibling repo, not part of this package) measures text with the
same font stack/weights and the same greedy word-wrap rule as
`packages/renderer-canvas/src/text.ts`, then computes `x = round((canvasWidth - measuredWidth) / 2)`
as a pre-render bake step. This change makes that computation a built-in renderer behavior instead
of an external, hand-run script that must be kept in sync with the renderer's own measurement
logic.
