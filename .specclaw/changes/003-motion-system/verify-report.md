# Verification Report: 003-motion-system

**Verified:** 2026-09-07
**Model:** claude-sonnet-5
**Verdict:** PASS

Re-verification pass. The prior verify (see git history) found one real gap: spec.md FR12
("that degradation is itself a diagnostic (FR9-style), not a silent shrink") and design.md's
Key Decision D3 ("`compileMotion`... re-derives the same clamp check by comparing each
`sceneWindows[i].transitionInFrames` against the scene's own `scene.transition?.duration`...
and reports it there") were never implemented — `compileMotion` never read `sceneWindows`/
`transitionInFrames` at all. That gap is now closed by commit `285aa26` ("003: implement the
transition-overlap clamp diagnostic committed in design.md D3"). This report re-confirms the
fix and re-runs the full verification against all 12 ACs.

## Fix verification (Issue #1 from the prior pass)

- `packages/motion/src/compile.ts:161-178` — a `spec.scenes.forEach` pass at the end of
  `compileMotion`, gated on `scene.transition?.kind === "cross-fade"`, reads
  `timeline.sceneWindows[i]` and compares `framesFor(scene.transition.duration ?? 0, spec.fps)`
  against `window.transitionInFrames`, pushing a `Diagnostic` with message `"requested
  cross-fade duration (${requestedFrames}f) exceeds the available overlap and was clamped to
  ${window.transitionInFrames}f"` when the requested duration exceeds the clamped one — exactly
  the field pair (`sceneWindows[i].transitionInFrames` vs. `scene.transition?.duration`) design.md
  D3 named.
- Two new tests in `packages/motion/test/compile.test.ts`:
  - `"emits a diagnostic when a requested cross-fade duration was clamped, not a silent shrink
    (design.md D3)"` (lines 98-109) — builds a real `compileTimeline` output (1s scene → 0.2s
    scene requesting a 10s/300-frame cross-fade against only ~5 available frames) and asserts
    `diagnostics.some(d => d.message.includes("clamped"))` is `true`.
  - `"emits no clamp diagnostic when the requested cross-fade duration fits"` (lines 111-122) —
    a 3s+3s scene pair with a 0.5s cross-fade (well inside the available overlap) asserts the
    same predicate is `false`, confirming the diagnostic doesn't false-fire on the common case.
  - Both tests run against a real `compileTimeline()` output, matching the evidentiary bar the
    rest of the suite already holds (AC6's own test uses the same pattern).
- Test run confirms both new tests pass: `packages/motion test: ✓ test/compile.test.ts (10
  tests)` (up from 8 in the prior pass).

## Acceptance Criteria (re-confirmed)

- ✅ **AC1:** `fade-up` at frame 0 → opacity≈0/y≈48; at end → opacity 1/y 0 — `packages/motion/src/presets.ts` defaults (`distance ?? 48`, `duration ?? 0.4`), asserted in `packages/motion/test/presets.test.ts:21-30`. Unchanged since prior pass.
- ✅ **AC2:** `evaluate` purity — `packages/motion/test/track.test.ts:42-45` asserts deep-equal output for identical inputs. Unchanged.
- ✅ **AC3:** `bakeSpring({stiffness:170,damping:26,mass:1},30)` settles ~1, clamps past end — `packages/motion/test/easing.test.ts:29-34`, `packages/motion/test/track.test.ts:47-49`. Unchanged.
- ✅ **AC4:** Pathologically low damping → `settled:false` at the `fps*5` cap, surfaced as a `compileMotion` diagnostic (not silent truncation) via `UnsettledSpringError` — `packages/motion/src/compile.ts:50-56`, `packages/motion/test/compile.test.ts` (`_compileTracksForLayerForTests` hook). Unchanged.
- ✅ **AC5:** `stagger({each:0.06,from:"random"})` determinism via FNV-1a hash, no `Math.random` — `packages/motion/src/stagger.ts`, `packages/motion/test/stagger.test.ts:18-21`. Unchanged.
- ✅ **AC6:** Track `delay+duration` exceeding the layer's active interval, checked against a real `compileTimeline` output — `packages/motion/src/compile.ts:87-93`, `packages/motion/test/compile.test.ts:23-33`. Unchanged.
- ✅ **AC7:** Overlapping cross-fade semantics (3s+3s scenes, 0.5s cross-fade ⇒ 5.5s not 6.5s) — **re-confirmed with extra scrutiny since this touches the same code path as the fix.** `packages/core/src/timeline.ts` computes `overlapFrames = min(transitionFrames, prevSceneFrameCount, sceneFrameCount)` and subtracts it from `startFrame`; `packages/core/test/timeline.test.ts:153-165` (`"a cross-fade overlaps scene durations: 3s + 3s with a 0.5s cross-fade totals 5.5s, not 6.5s"`) asserts `timeline.frameCount === Math.round(5.5 * 30)`. This is `@claudevid/core`'s own clamp logic and is untouched by the `compileMotion` fix (the fix only adds a read-only diagnostic pass in the motion package downstream of it) — confirmed by reading both files: `compileMotion`'s new code never writes to `timeline` or `spec`, it only reads `timeline.sceneWindows[i].transitionInFrames` to compare against the requested duration. No regression introduced.
- ✅ **AC8:** Motion resolver opacity visibly applied via raw-pixel comparison — `packages/renderer-canvas/src/index.ts`, `packages/renderer-canvas/test/render.test.ts:234-257`. Unchanged.
- ✅ **AC9:** Hold-frame bypass when resolver output differs frame-to-frame — `packages/renderer-canvas/src/index.ts`, `packages/renderer-canvas/test/render.test.ts:260-280`. Unchanged.
- ✅ **AC10:** `exportCatalogue()` returns only `{name, channels}` for the 9 shipped presets — `packages/motion/src/presets.ts`, `packages/motion/test/catalogue.test.ts:5-19`. Unchanged.
- ✅ **AC11:** `tools/motion-preview` no-clobber + frame cap at 24 — `tools/motion-preview/src/args.ts`, `tools/motion-preview/test/args.test.ts:16-20,38-46`. Unchanged.
- ✅ **AC12:** Build/test/lint all green workspace-wide, no regression — re-run independently this session (see below): `pnpm -r run build` (all 5 scoped projects succeed), `pnpm -r run test` (113/113 passing, up from 111 — the 2 new `compile.test.ts` cases), `pnpm -r run lint` (`tsc --noEmit` clean everywhere).

No unhandled edge cases newly introduced by the fix. The two previously-noted untested-but-correct edge cases (empty-children group with stagger; zero-duration cross-fade degrading to cut) remain untested but correct — unchanged from the prior pass, not blocking.

## Test Results

Independently re-run in this session:
```
pnpm -r run build  → all 4 scoped packages + tools/motion-preview: ESM+DTS build succeeds, no errors

pnpm -r run test
packages/core:            7 files, 34 tests passed
packages/motion:           6 files, 38 tests passed   (was 36 — +2 from the D3 fix)
packages/renderer-canvas:  7 files, 33 tests passed    (perf.test.ts p95 well under the 35ms ceiling this run)
tools/motion-preview:      1 file,   8 tests passed
TOTAL: 113/113 passing

pnpm -r run lint   → tsc --noEmit clean in all 4 scoped projects
```

## Issues Found

No issues found. The prior pass's single tracked issue (FR12/D3's transition-overlap-clamp
diagnostic not implemented) is resolved: `packages/motion/src/compile.ts` now emits the
diagnostic exactly as design.md D3 specified, backed by two passing regression tests in
`packages/motion/test/compile.test.ts`.

## Summary

**Passed:** 12/12 criteria
**Failed:** 0/12 criteria
**Verdict:** PASS
