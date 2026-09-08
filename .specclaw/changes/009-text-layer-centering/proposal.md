# Proposal: Text layer centering respects `align`

**Created:** 2026-09-08
**Status:** 🟡 Draft

## Problem

_What problem are we solving? Why does it matter?_

A `text` layer's `x`/`y` are always treated as the top-left corner of its rendered bitmap,
regardless of `align`. `packages/core/src/resolve.ts`'s `resolveAxis` resolves `x: "center"` to
`dimension / 2` at compile time (`packages/core/src/timeline.ts`), and
`packages/renderer-canvas/src/index.ts`'s text case then always calls
`ctx.drawImage(bitmap, layer.x, layer.y)` — it never consults `layer.align` to offset by the
bitmap's measured width. `align` only affects how *wrapped, multi-line* text lines are justified
relative to each other inside their own tightly-fit bitmap (via `paintTextLayer`'s internal
`ctx.textAlign` in `packages/renderer-canvas/src/text.ts`) — it has no effect on where that
bitmap is placed relative to `x`.

The practical consequence: `x: "center"` + `align: "center"` puts the text's *left edge* on the
horizontal midpoint, not its visual center — the text reads visibly off-center, with no error or
diagnostic to flag it. `align: "right"` has the same problem anchored at the right edge.

This is a real downstream pain point, not a hypothetical one. A production use of claudevid (a
LinkedIn video series built entirely on the published package) had to write and run a standalone
Node script (`bake-centering.mjs`) after every text edit, before every render — one that
reimplements the renderer's own font measurement (same font stack/weights, same
wrap-only-on-`maxWidth` greedy word-wrap rule as `packages/renderer-canvas/src/text.ts`) purely to
compute the numeric `x` that produces true visual centering. Their own notes: *"Centring must be
baked... the renderer treats `x` as the bitmap's top-left, so `x: "center"` puts the text's left
edge on the centre line."* That workaround script is a useful reference for what "correct"
centering looks like, and it currently has to be re-run by hand on every centered-text spec —
exactly the kind of thing the renderer should just do correctly.

No existing test locks in the current top-left-only behavior for a centered/right-aligned text
layer, and nothing documents it as an intentional design choice — this reads as an unintentional
gap rather than a deliberate v1 limitation.

## Proposed Solution

_What are we building? High-level approach._

Make `align` affect a text layer's placement anchor at paint time, not just intra-box line
justification:

- `align: "left"` (default): unchanged — `x` is the bitmap's left edge, as today.
- `align: "center"`: the bitmap's horizontal center lands at `x`.
- `align: "right"`: the bitmap's right edge lands at `x`.

The bitmap's measured `totalWidth` (already computed by `paintTextLayer`/`measureAndWrap`) is the
only new input needed — the fix is an anchor offset applied where `drawImage` places the bitmap
(`packages/renderer-canvas/src/index.ts`'s text case, and the equivalent motion-transform branch
that also draws a text bitmap), not a change to `paintTextLayer`'s internal line-justification
logic, `resolveAxis`, or the schema. `y`/vertical placement is out of scope — the reported problem
and the workaround are both purely horizontal.

This turns "bake centering by hand with a separate script that must be kept in sync with the
renderer" into "the renderer already does the right thing" — the natural reading of `x: "center"`
+ `align: "center"` on a text layer.

## Scope

### In Scope
- `packages/renderer-canvas`: text layer placement honors `align` (`"left"` unchanged,
  `"center"`/`"right"` offset by the measured bitmap width) for both the plain-draw and
  motion-transform paths.
- Unit/integration test(s) pinning the new behavior: a centered (and right-aligned) text layer's
  effective on-canvas bounds are anchored at `x` per the rule above, for both a numeric `x` and an
  `x: "center"` spec value.
- A short note (in the affected source or a relevant README) stating the anchor semantics
  explicitly, so this isn't undocumented again.

### Out of Scope
- Vertical (`y`) placement / `align`-equivalent for the vertical axis.
- `rect`/`image` layers, or any layer type without an `align` field — unaffected, no schema change.
- A general theme/light-dark system (a separate, unrelated gap noted by the same downstream user,
  not addressed here).
- Retiring or changing the downstream `bake-centering.mjs` script itself (lives in a separate
  repo, out of this package's control) — it will simply become unnecessary for callers on the
  fixed version.

## Impact

- **Files affected:** 2-4 (estimated) — `packages/renderer-canvas/src/index.ts`, possibly
  `packages/renderer-canvas/src/text.ts`, plus new/updated test file(s).
- **Complexity:** small
- **Risk:** low — no existing test pins the current top-left-only behavior for
  center/right-aligned text, and `align: "left"` (the default, and the only alignment used by
  most existing specs/examples) is explicitly unchanged.

## Open Questions

- Should the motion-transform branch's pivot point (used for rotate/scale) also shift to the new
  anchor, or should the pivot stay box-relative while only the static placement offset changes?
  Needs a decision during design given `applyMotionTransform`'s existing box-center pivot
  convention (see `packages/renderer-canvas/src/index.ts`'s comment on box-center pivoting).
- Confirm no published example/skill asset (`.claude/skills/video-generator/examples/*.json`)
  relies on the current top-left-only behavior for a centered/right-aligned text layer; a quick
  grep during planning should settle this.

## Dependency Bypass

## Item Split

## Resumes Split

---

**To proceed:** Review this proposal and approve to begin planning.
