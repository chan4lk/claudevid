# Tasks: Text layer centering respects `align`

**Change:** 009-text-layer-centering
**Created:** 2026-09-08
**Total Tasks:** 2

## Summary

One small, self-contained fix in `packages/renderer-canvas/src/index.ts` (add an `alignOffsetX`
helper and apply it in the `text` paint case), plus the regression tests that prove it. Two
tasks, sequential — the tests can't be written meaningfully before the anchor-offset logic they
assert against exists.

## Tasks

### Wave 1 — Implement the anchor fix

- [x] `T1` — Add `alignOffsetX` and anchor the text paint case on it
  - Files: `packages/renderer-canvas/src/index.ts`, `packages/renderer-canvas/src/text.ts` (doc comment only)
  - Estimate: small
  - Kind: impl
  - Notes: Per design.md's Technical Approach — add the unexported `alignOffsetX(align, width)`
    helper; in the `case "text":` block, compute
    `anchoredX = layer.x - alignOffsetX((layer.layer as TextLayer).align, bitmap.width)` and pass
    `anchoredX` (not `layer.x`) to both `applyMotionTransform` and the plain `ctx.drawImage`
    call. `align: "left"`/undefined must produce offset `0` (byte-identical to today, FR3). Add
    the one-line cross-reference doc comment near `paintTextLayer` in `text.ts` (per design.md's
    File Changes Map) clarifying that `align` there only governs intra-bitmap line
    justification, not box placement — that's `index.ts`'s `alignOffsetX`.

### Wave 2 — Regression tests

- [x] `T2` — Add `align`-anchor test cases to `render.test.ts`
  - Files: `packages/renderer-canvas/test/render.test.ts`
  - Estimate: small
  - Kind: test
  - Depends: T1
  - Notes: Follow the existing integration-test convention in this file (real
    `parseSpec`/`compileTimeline` output, never a hand-built `Timeline` fixture; reuse the
    existing `nonBackgroundBBox` helper). Cover, per spec.md's AC1-AC5:
    - `align: "center"` + numeric `x` → painted bounding box horizontally centered on `x`.
    - `align: "center"` + `x: "center"` → painted bounding box centered on `width / 2`.
    - `align: "right"` + numeric `x` → painted bounding box's right edge at `x`.
    - `align: "left"` / omitted → unchanged left-edge-at-`x` behavior (guards FR3 against
      regression — this is the case the existing `textSpec()`-based test in this file already
      exercises implicitly; add an explicit assertion or reuse that test's existing box check).
    - Repeat at least the `align: "center"` case with an active motion track (a layer with an
      `animation` that produces a non-empty `PropertyBag`, per this file's existing motion-test
      patterns elsewhere in the package) to cover AC5's "motion path" requirement.
    Run `pnpm --filter @claudevid/renderer-canvas test` (or the workspace-root equivalent) and
    confirm no other test in the package regresses.

---

## Legend

- `[ ]` Pending
- `[~]` In Progress
- `[x]` Complete
- `[!]` Failed
