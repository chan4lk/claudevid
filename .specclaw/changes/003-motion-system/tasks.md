# Tasks: Motion System v1 — Free-Channel Animation, Presets, Stagger, Cut/Cross-Fade Transitions

**Change:** 003-motion-system
**Created:** 2026-09-07
**Total Tasks:** 14

## Summary

14 tasks across 4 waves. Wave 1 lands the small, additive `@claudevid/core` co-changes
(schema fields + `Timeline.transitionAt`) that everything else depends on. Wave 2 builds
`@claudevid/motion`'s pure evaluation core (no rendering). Wave 3 wires motion into
`@claudevid/renderer-canvas` and adds the manual preview tool. Wave 4 is the full-workspace
regression check.

## Tasks

### Wave 1 — Core schema + timeline extensions

- [ ] `T1` — Add `PropertyBag` type and `Animation.stagger`/`Scene.transition` fields to core
  - Files: `packages/core/src/property-bag.ts` (create), `packages/core/src/layers.ts`,
    `packages/core/src/schema.ts`, `packages/core/src/types.ts`, `packages/core/src/index.ts`
  - Estimate: small
  - Kind: impl
  - Notes: `Animation.stagger?: { each: number; from?: "first"|"center"|"last"|"random" }`
    (zod: `each` positive number). `Scene.transition?: { kind: "cut"|"cross-fade"; duration?:
    number }` (zod: default `kind: "cut"`, `duration` non-negative). Export `PropertyBag` from
    `index.ts`. No change to any existing field or export (design.md FR13).

- [ ] `T2` — `compileTimeline` scene-overlap arithmetic + `Timeline.transitionAt`
  - Files: `packages/core/src/timeline.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T1
  - Notes: Per design.md's "Core changes" section — `SceneWindow` gains `transitionInFrames`;
    each transitioned scene's `startFrame` shifts earlier by
    `min(requestedOverlapFrames, prevSceneFrameCount - 1, sceneFrameCount - 1)`. `activeAt`
    must NOT change behavior (Key Decision D6) — add `transitionAt(frame)` as a new method
    only. Overlap semantics are additive; `duration: 0` or `kind: "cut"` must reproduce
    byte-identical `frameCount`/`sceneWindows` to today's output (regression safety).

- [ ] `T3` — Core regression tests for T1/T2
  - Files: `packages/core/test/timeline.test.ts` (extend)
  - Estimate: small
  - Kind: test
  - Depends: T2
  - Notes: AC7 (5.5s not 6.5s overlap math), a `kind: "cut"`/no-`transition` case proving
    byte-identical output to pre-change behavior, `transitionAt` returning `null` outside any
    overlap window and a correct `{outgoing, incoming, t}` inside one, and the `min`-guard
    degrading a too-long transition duration without producing a negative-length scene.

### Wave 2 — `@claudevid/motion` package (pure, no rendering)

- [ ] `T4` — Package scaffolding + `properties.ts` (`Channel` union, cost table)
  - Files: `packages/motion/package.json`, `tsup.config.ts`, `vitest.config.ts`,
    `tsconfig.json`, `src/properties.ts`, `src/index.ts` (stub)
  - Estimate: small
  - Kind: config
  - Depends: T1
  - Notes: Mirror `packages/renderer-canvas`'s package.json/tsup/vitest config shape. Only
    dependency: `@claudevid/core` (workspace). `Channel = "opacity"|"x"|"y"|"scaleX"|"scaleY"|
    "rotation"` per spec.md FR1 — no invalidating channels in v1.

- [ ] `T5` — `easing.ts`: `resolveEasing`, `spring`, `bakeSpring`
  - Files: `packages/motion/src/easing.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T4
  - Notes: `resolveEasing` must delegate to `@claudevid/core`'s exported easing functions for
    every non-spring name (no duplicated math — design.md FR5). `bakeSpring` schema-bounds
    stiffness `(0,1000]`/damping `(0,100]`/mass `(0.01,100]` (throws on violation), integrates
    at `1/fps`, settle threshold `|1-value|<0.001 && |velocity|<0.001` for 3 consecutive
    samples, hard cap `fps*5` samples, returns `{ frames: number[]; settled: boolean }`.

- [ ] `T6` — `track.ts`: `Track`/`ResolvedTrack` types + `evaluate`
  - Files: `packages/motion/src/track.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T5
  - Notes: `evaluate(tracks: ResolvedTrack[], frame: number, trackStartFrame: number):
    PropertyBag` per design.md's `track.ts` section — frame-indexed, no seconds anywhere in
    this function. `ResolvedTrack` carries `delayFrames`/`durationFrames` (or `bakedFrames`
    for springs) already converted — no fps parameter here either.

- [ ] `T7` — `presets.ts`: registry + 9 shipped presets + `exportCatalogue`
  - Files: `packages/motion/src/presets.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T6
  - Notes: `fade`, `fade-up`, `fade-down`, `slide-left`, `slide-right`, `slide-up`,
    `slide-down`, `scale-fade`, `pop` — parameterised functions per spec.md FR6, not literal
    arrays. `definePreset` throws (dev-time only, not user-facing) on a same-`property`-twice
    registration. `exportCatalogue()` returns only `{name, channels}` (spec.md FR7) — no other
    field.

- [ ] `T8` — `stagger.ts`: deterministic ordering
  - Files: `packages/motion/src/stagger.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T4
  - Notes: `orderIndices(childKeys, from)` per design.md — `"random"` uses a pure 32-bit
    FNV-1a hash of each `layerKey`, stable-sorted; no `Math.random`/`Date.now` anywhere in this
    file (NFR2).

- [ ] `T9` — `compile.ts` + `resolver.ts`: `compileMotion`, `createResolver`
  - Files: `packages/motion/src/compile.ts`, `packages/motion/src/resolver.ts`,
    `packages/motion/src/index.ts` (finalize exports)
  - Estimate: large
  - Kind: impl
  - Depends: T7, T8
  - Notes: Walks `timeline.layers`, resolves `animation.enter`/`exit` against the registry,
    applies stagger for `GroupLayer` children (spec.md FR10/FR11 — group's own entry produces
    no track, group `x`/`y` never read), bakes springs via `spec.fps`, and emits the two
    diagnostics from spec.md FR9/FR4 (timing-clamp, unsettled-spring) using core's
    `Diagnostic` shape. A preset name not found in the registry is also a diagnostic (spec.md
    Edge Cases), not a silent no-op. `createResolver` closes over each layer's `startFrame`.

- [ ] `T10` — Motion package test suite
  - Files: `packages/motion/test/track.test.ts`, `easing.test.ts`, `presets.test.ts`,
    `stagger.test.ts`, `compile.test.ts`, `catalogue.test.ts`
  - Estimate: large
  - Kind: test
  - Depends: T9
  - Notes: Covers AC1-AC6, AC10. **Zero imports of `@napi-rs/canvas`, `@claudevid/
    renderer-canvas`, or any font anywhere in this test directory** (spec.md NFR1 — this is a
    hard constraint, not a suggestion; verify with a grep before marking this task done).
    `compile.test.ts`'s clamp/diagnostic tests must run against a real `compileTimeline(...)`
    output (spec.md AC6), not a hand-built fake `Timeline`.

### Wave 3 — Renderer integration + preview tool

- [ ] `T11` — `renderer-canvas`: motion resolver, transform bracket, transition two-pass, hold-frame bypass
  - Files: `packages/renderer-canvas/src/index.ts`
  - Estimate: large
  - Kind: impl
  - Depends: T2, T6 (needs `PropertyBag` from core and the resolver shape motion produces)
  - Notes: Per design.md's "Renderer changes" section. `renderFrame`'s existing call
    signature must keep working with no `opts.motion` and no `transitionAt` on the `Timeline`
    passed in (defensive `timeline.transitionAt?.(frame)`) — NFR3. The transform bracket wraps
    all three painter dispatch cases (`text`, `rect`, `image`), using each bitmap's own
    `width`/`height` (or the image layer's declared box) as the center-origin reference (design
    D4). Hold-frame fast path adds exactly one new condition (`!anyMotion`) per design.md.

- [ ] `T12` — Renderer integration tests for T11
  - Files: `packages/renderer-canvas/test/render.test.ts` (extend)
  - Estimate: medium
  - Kind: test
  - Depends: T11
  - Notes: AC8 (opacity visibly applied, raw-pixel assertion, not a snapshot image), AC9
    (hold-frame bypass when an active layer's resolved `PropertyBag` differs between two
    otherwise-identical frames), and one cross-fade test asserting a rendered frame inside a
    transition's overlap window blends both scenes' backgrounds (not just one, per design D5).

- [ ] `T13` — `tools/motion-preview` CLI
  - Files: `tools/motion-preview/package.json`, `src/cli.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T9, T11
  - Notes: `--out` required (no default/derived path), refuses to overwrite without
    `--force`, `--frames`/`N` capped at 24 (reject above, per spec.md FR17/AC11). Not added to
    the workspace's `pnpm -r run test` fast tier — its own tests (if any) cover only the
    CLI-argument checks (no-clobber, N-cap), not rendering.

### Wave 4 — Full-workspace regression

- [ ] `T14` — Workspace-wide build/test/lint pass
  - Files: none (verification task)
  - Estimate: small
  - Kind: test
  - Depends: T3, T10, T12, T13
  - Notes: `pnpm -r run build`, `pnpm -r run test`, `pnpm -r run lint` all green from a clean
    checkout (AC12) — confirms 001/002's existing suites are unaffected (NFR3) and every new
    AC in spec.md is covered by a task above; reconcile before marking this change built.

---

## Legend

- `[ ]` Pending
- `[~]` In Progress
- `[x]` Complete
- `[!]` Failed
