# Spec: Motion System v1 — Free-Channel Animation, Presets, Stagger, Cut/Cross-Fade Transitions

**Change:** 003-motion-system
**Created:** 2026-09-07
**Status:** 🟡 Draft

## Overview

`@claudevid/motion` is a pure, declarative `time → property-bag` evaluation engine. It draws
nothing — it takes the resolved `Layer`/`Scene` data from `@claudevid/core`'s compiled
`Timeline` and, for a given frame, returns per-layer resolved values that
`@claudevid/renderer-canvas` composites.

**Scope of this version, cut hard from the original proposal (see "Scope cuts" below):**
only the six **free** channels (`opacity`, `x`, `y`, `scaleX`, `scaleY`, `rotation`) animate.
Colour, `fontSize`, `letterSpacing`, and text-reveal channels — the ones that invalidate
`renderer-canvas`'s raster cache — are **out of scope for this change** and land in a
follow-up once a cost-diagnostic mechanism exists to guard them. This is not a missing
feature so much as the whole point: v1 proves the track/evaluate/preset/stagger/transition
machinery on the channels that are cheap by construction, before opening the door to the
channels that can quietly cost 50× more per frame.

### Problem, sourced

The original requirement doc (`docs/Qwen_markdown_20260906_vsjxybyq8.md:297-350,510-548,601-650`)
specifies a flat `AnimationPreset` string-literal union, a single `getEnterOpacity(layer,
localTime)` helper that linearly interpolates opacity only, and Zod enums duplicating that
union in two more places. **None of this was ever implemented.** The actual, current
`Animation` interface (`packages/core/src/layers.ts:5-11`) is already just
`{ enter?: string; exit?: string; duration?: number; delay?: number; easing?: string }` — a
bare string name with no resolver — and `packages/renderer-canvas/src/index.ts` never reads
the `animation` field at all (confirmed by grep — zero matches). So there is no enum to
retire and no renderer branches to strip: **the "two sources of truth" risk the proposal
warned about does not exist in this repository**, because nothing consumes `animation` yet.
This spec is what implements it, once, in the registry shape below.

Quantified do-nothing cost, from this repo rather than an industry claim: 0 of the layer
types shipped in 001/002 render any motion today — `animation.enter`/`exit` are schema-valid
but semantically inert. Every scene in this library currently either pops in on frame 1 or
needs a bespoke `if` a future change would have to add. That is the ceiling this change
removes.

No human-review step exists between spec generation and video output in this repo (no
proposal, design, or config document establishes one) — diagnostics in this system must
therefore be machine-actionable (fail the run), not advisory log lines nobody reads.

## Requirements

### Functional Requirements

- **FR1 — Animatable channels (v1 set).** Exactly six numeric channels animate:
  `opacity` (0..1, default 1), `x`, `y` (px, additive offset on top of the layer's own
  resolved `Coordinate`), `scaleX`, `scaleY` (default 1), `rotation` (degrees, default 0,
  about the layer's own rendered-bitmap center). All are "free" in 002's terms: `opacity` via
  `ctx.globalAlpha`, the rest via a `ctx.translate/rotate/scale` bracket around the existing
  `ctx.drawImage` call — no raster-cache invalidation, no re-layout.
- **FR2 — `Track` and `evaluate`.** A `Track` is `{ property: Channel; from: number; to:
  number; duration: number; delay?: number; easing?: EasingRef }` (seconds for
  `duration`/`delay`). No `keyframes`, no `repeat`, no `direction` in v1 — see "Scope cuts."
  `duration` is **required** (no ambiguity about what it defaults to). `easing` defaults to
  `"linear"` when omitted. Two tracks in the same list targeting the same `property` is a
  build-time invariant violation (checked by a unit test over the shipped registry, not a
  runtime schema rule, since `Track` lists are motion-authored code, not spec-authored data).
- **FR3 — Frame-indexed evaluation.** `evaluate(tracks: Track[], frame: number, trackStartFrame:
  number): PropertyBag` is a pure function of **integer frame numbers**, matching
  `Timeline`'s existing frame authority (`packages/core/src/timeline.ts` — "the only timing
  authority in the system"). It is not seconds-based. See Key Decision D1 for why this
  doesn't reintroduce the fps-coupling risk flagged in `GOALS.md`.
- **FR4 — Spring easing.** `spring({ stiffness, damping, mass, velocity? })` is baked to a
  fixed-length array of per-frame progress values (0..1) by `bakeSpring(spec, fps):
  number[]`, exported from `packages/motion/src/easing.ts`. Baking happens inside
  `compileMotion` (FR8), the one place `fps` (from `VideoSpec.fps`) is in scope. Evaluating a
  baked spring past the end of its array clamps to the last (settled) value — same
  overflow-clamps-don't-diagnose precedent already used by `packages/core/src/timeline.ts:71`
  for layer intervals.
  - `stiffness ∈ (0, 1000]`, `damping ∈ (0, 100]`, `mass ∈ (0.01, 100]` — out-of-range values
    are a hard rejection (FR9), never silently clamped into range.
  - Bake stops (and the array is used as final) once `|value - 1| < 0.001` and
    `|velocity| < 0.001` for 3 consecutive frames, or at a **hard cap of `fps * 5` frames**,
    whichever comes first. Hitting the cap without settling is a diagnostic (FR9), never a
    silent truncation.
- **FR5 — Non-spring easing reuses core.** `resolveEasing(name: string): EasingFn` in
  `packages/motion/src/easing.ts` looks up `linear`/`easeIn*`/`easeOut*`/`easeInOut*`
  (quad/cubic/expo/back) directly from `@claudevid/core`'s existing exports
  (`packages/core/src/easing.ts`) — motion does not re-implement or duplicate any of them.
  `cubic-bezier(x1,y1,x2,y2)` and `steps(n, jump)` string forms parse to core's
  `cubicBezier`/`steps` calls. Motion's own `easing.ts` adds exactly one new primitive:
  `spring`.
- **FR6 — Presets are data.** `packages/motion/src/presets.ts` exports a registry:
  `name → (params) => Track[]` (parameterised templates, not arrays with magic numbers baked
  in — e.g. `slide("left", { distance = 64 })`, not a fixed `48`). Shipped v1 catalogue:
  `fade`, `fade-up`, `fade-down`, `slide-left`, `slide-right`, `slide-up`, `slide-down`,
  `scale-fade`, `pop`. That's it — see "Scope cuts" for the deferred families and why.
  Shipped preset definitions are treated as immutable once released: a visual change to an
  existing name ships as a new name (e.g. `fade-up-v2`), not an in-place edit. This is a
  contributor convention enforced by code review, not a runtime version field — there is no
  multi-consumer/multi-version deployment in this repo yet to justify one (YAGNI).
- **FR7 — Preset catalogue export is structurally safe.** `exportCatalogue(): { name: string;
  channels: Channel[] }[]` returns only the preset name and the list of channels it touches —
  no free-form prose field exists anywhere in the registry's data shape, so there is nothing
  for a future change 007 to inject into a director prompt beyond a fixed, first-party,
  code-reviewed list. There is no `registerPreset()` public API in v1 (no external/user-
  registered presets), so there is no path for untrusted content to reach the catalogue at
  all — the BLOCK finding this addresses is closed by construction, not by a runtime filter.
- **FR8 — `compileMotion`, the named baker/compiler.** `compileMotion(spec: VideoSpec,
  timeline: Timeline): { compiled: CompiledMotion; diagnostics: Diagnostic[] }` in
  `packages/motion/src/compile.ts` is the one place that: resolves each layer's
  `animation.enter`/`exit` preset name against the registry, applies group stagger (FR11),
  bakes any spring easing (FR4) using `spec.fps`, clamps/validates each resulting track
  against its layer's active interval (FR9), and returns a `Map<layerKey, Track[]>` plus any
  diagnostics. It runs once, after `compileTimeline` and before the render loop — analogous
  to `compileTimeline` itself, and it does **not** change `compileTimeline`'s signature or
  make `@claudevid/core` depend on motion (core stays motion-agnostic; the caller/orchestrator
  imports both).
- **FR9 — Timing-clamp diagnostic, fail-closed.** If a resolved track's `delay + duration`
  (in frames) exceeds the layer's active interval (`endFrame - startFrame` from `Timeline`),
  `compileMotion` returns a non-empty `diagnostics` array (reusing `@claudevid/core`'s
  existing `Diagnostic { path, message, suggestion }` shape from `packages/core/src/
  diagnostics.ts`) instead of silently truncating the animation. A non-empty `diagnostics`
  array **must** be treated as a hard failure by any caller running non-interactively — this
  mirrors the disposition `parseSpec`'s `ParseResult` already established (`ok: false` +
  diagnostics = stop), not a new precedent.
- **FR10 — Stagger.** `stagger({ each: number; from?: "first" | "center" | "last" | "random"
  })` (seconds for `each`). Applied via a `GroupLayer`'s own `animation.stagger` field (FR13):
  `compileMotion` resolves the group's `animation.enter`/`exit` preset **once**, then clones
  the resulting tracks for each child with `delay += each * orderIndex`, where `orderIndex` is
  each child's position in the order named by `from`. `from: "random"` is deterministic: order
  children by a pure string hash of their `layerKey` (`packages/motion/src/stagger.ts` —
  FNV-1a over the key, no `Math.random`, no wall-clock seed), so the same spec always produces
  the same cascade and two workers rendering adjacent chunks (change 005, future) never
  disagree at a chunk boundary.
- **FR11 — Group semantics, stated explicitly.** A `GroupLayer`'s own `x`/`y` remain purely
  organisational and are **not** applied as an offset to children — confirmed during 002
  (`packages/core/src/timeline.ts`'s `flattenLayers` resolves every child's coordinates
  independently against the spec's absolute width/height and never reads the parent's
  position). A group exists in this system to scope a `stagger`/preset declaration over its
  children and, in a later change, a `shared-element` match boundary — nothing else. If a
  `GroupLayer` declares `animation.enter`/`exit` **without** `stagger`, every child receives
  the same resolved tracks with no per-child delay offset (lockstep, not cascade). This is
  the answer `GOALS.md` asked 003 to state explicitly.
- **FR12 — Scene transitions: `cut` and `cross-fade` only, overlapping.** `Scene` gains an
  optional `transition?: { kind: "cut" | "cross-fade"; duration?: number }` field (default
  `{ kind: "cut", duration: 0 }`), describing the transition **into** this scene from the
  previous one. `push`, `wipe`, `dip-to-colour`, and `shared-element` are explicitly deferred
  (see "Scope cuts") — this field is a closed, two-member set, not an open registry, and is
  co-owned with `@claudevid/renderer-canvas` (a `cross-fade` render is a two-pass paint the
  renderer performs; see design.md). Committed semantics: **overlapping** — a `0.5s`
  cross-fade between two `3s` scenes yields a `5.5s` total, not `6.5s`. `compileTimeline`
  (`@claudevid/core`) is extended (not `@claudevid/motion`) to shift each transitioned scene's
  `startFrame` earlier by `min(transitionFrames, prevSceneFrameCount, sceneFrameCount)` — the
  `min` guard means a transition longer than either adjacent scene degrades to the largest
  overlap that still leaves both scenes with at least 1 frame of solo time, and that
  degradation is itself a diagnostic (FR9-style), not a silent shrink.
- **FR13 — Schema surface, exactly two new core fields.** `@claudevid/core` gains: (a)
  `Scene.transition?: { kind: "cut" | "cross-fade"; duration?: number }` (FR12), and (b)
  `Animation.stagger?: { each: number; from?: "first" | "center" | "last" | "random" }`
  (FR10). Both are optional, inert-unless-interpreted fields owned by core (same pattern as
  the already-inert `Animation.easing: string`), not a schema fragment "contributed" by
  motion. `@claudevid/motion` depends on `@claudevid/core`; `@claudevid/core` gains zero new
  dependency and does not import `@claudevid/motion`. `PropertyBag` (FR14) is likewise
  defined in `@claudevid/core` as a plain data type (no logic), the neutral point both
  `@claudevid/motion` (producer) and `@claudevid/renderer-canvas` (consumer) already depend
  on — this is the answer to "which package's `package.json` gains which dependency": neither
  gains a new one; the shared type lives in the package both already import.
- **FR14 — `PropertyBag`, defined concretely.** `{ opacity?: number; x?: number; y?: number;
  scaleX?: number; scaleY?: number; rotation?: number }` — six raw scalars, no pre-composed
  matrix. `renderer-canvas` composes the transform itself (`ctx.translate` to the layer's own
  rendered-bitmap center, `ctx.rotate`, `ctx.scale`, translate back, then the existing
  `ctx.drawImage`) — motion never touches a canvas. The rotation/scale origin is always the
  layer's own rendered bitmap center; there is no per-layer origin override in v1 (no preset
  needs one — deferred alongside the invalidating channels).
- **FR15 — Renderer integration is additive.** `@claudevid/renderer-canvas`'s `renderFrame`
  gains an optional parameter for a motion resolver: `{ resolve(layerKey: string, frame:
  number): PropertyBag | undefined }`. When present, each active layer's paint call is
  wrapped in the transform bracket from FR14 and `ctx.globalAlpha` is set from
  `PropertyBag.opacity ?? 1`. Existing call sites that omit this parameter are unaffected —
  no signature break for 001/002's existing tests.
- **FR16 — Hold-frame reuse no longer lies for animated layers.** `renderFrame`'s existing
  `keySignature` fast path (`packages/renderer-canvas/src/index.ts`) is bypassed whenever any
  currently-active layer has a non-empty resolver result for the current frame — this is the
  fix `packages/core/src/timeline.ts`'s and 002's own spec.md's forward-compatibility note
  (FR11/Notes, `.specclaw/changes/002-canvas-render-engine/spec.md:180-184`) asked this change
  to make: "bypass hold-frame detection for animated layers," the option that spec explicitly
  named as acceptable.
- **FR17 — `motion-preview` contact-sheet tool.** `tools/motion-preview` is a manually-run CLI
  (not part of the automated/CI test tier) that renders `N` evenly-spaced frames of a scene to
  one PNG grid, using the real `@claudevid/renderer-canvas` + `@claudevid/motion` +
  `@claudevid/core`. Output path is a **required** CLI argument (never derived from spec
  content); the tool refuses to overwrite an existing file unless `--force` is passed. `N` is
  capped at 24 and rejected above that.

### Non-Functional Requirements

- **NFR1 — Motion's own automated test suite is 100% numeric.** No test in
  `packages/motion/test/` imports `@napi-rs/canvas`, `@claudevid/renderer-canvas`, or any
  font. Golden tests assert `evaluate()`/`bakeSpring()`/`compileMotion()` output values
  directly. This is a hard requirement, not a preference — it is what keeps the suite
  deterministic across machines (no font-rasterization drift) and out of the renderer's
  build-time dependency graph.
- **NFR2 — Purity.** `evaluate` and `compileMotion` (given the same `spec`/`timeline`) always
  return the same result — no `Math.random`, no `Date.now`, no I/O.
- **NFR3 — No regression to 001/002's existing public APIs or tests.** `compileTimeline`'s and
  `renderFrame`'s existing call signatures (arguments used by existing callers) continue to
  work unchanged; the additions in FR12/FR13/FR15 are optional parameters/fields only.
- **NFR4 — Bounded compile-time work.** Spring baking is capped (FR4); stagger's `each *
  orderIndex` delay accumulation over a group is bounded by the group's own child count
  (already capped at reasonable sizes by `MAX_GROUP_NESTING_DEPTH` and ordinary spec size, no
  new limit needed).

## Acceptance Criteria

- **AC1:** A `text` layer with `animation.enter: "fade-up"` and no `duration` override:
  `compileMotion` produces a track list whose resolved `PropertyBag` at frame 0 has
  `opacity` near `0` and `y` offset near `48` (the preset's default distance), and at the
  preset's end frame has `opacity` at `1` and `y` offset at `0`.
- **AC2:** `evaluate` is a pure function: calling it twice with identical `(tracks, frame,
  trackStartFrame)` returns deep-equal `PropertyBag`s (NFR2).
- **AC3:** `bakeSpring({ stiffness: 170, damping: 26, mass: 1 }, 30)` returns a finite-length
  `number[]` whose last value is within `0.001` of `1`, and evaluating past the array's end
  clamps to that last value (FR4).
- **AC4:** `bakeSpring` with a pathologically low `damping` that would not settle within `fps *
  5` frames returns a diagnostic from `compileMotion` (not a silently-truncated array) when
  that spring is used in a track (FR4/FR9).
- **AC5:** `stagger({ each: 0.06, from: "random" })` applied to the same group twice (same
  spec) produces the identical per-child delay ordering both times (FR10/NFR2) — the
  determinism claim, tested directly (no renderer involved).
- **AC6:** A track whose `delay + duration` exceeds its layer's active interval produces a
  non-empty `diagnostics` array from `compileMotion` (FR9) — verified against a real
  `compileTimeline` output, not a hand-built `Timeline`.
- **AC7:** `compileTimeline` (core) with a scene `transition: { kind: "cross-fade", duration:
  0.5 }` following a 3s scene produces a total `frameCount` matching `5.5s` at the spec's fps,
  not `6.5s` (FR12) — the overlapping-semantics commitment, as a regression test against
  `@claudevid/core`.
- **AC8:** `renderFrame` with a motion resolver present and an active layer whose resolver
  returns `{ opacity: 0.5 }`: the painted output for that layer differs from the same layer
  painted with no resolver (i.e. `opacity` is visibly applied), verified via a raw-pixel
  assertion, not a snapshot image.
- **AC9:** Two consecutive frames with an identical `activeAt` layer-key set, where at least
  one active layer has a resolver-produced `PropertyBag` that differs between the two frames:
  `renderFrame` does **not** take the hold-frame fast path (`RenderStats` records a fresh
  paint, not a hold-frame reuse) — the FR16 fix, regression-tested against 002's existing
  hold-frame mechanism.
- **AC10:** `exportCatalogue()` returns only `{ name, channels }` entries for the nine shipped
  v1 presets — no field on any entry is a free-form string beyond the preset's own name
  (FR7), asserted structurally (`Object.keys` per entry).
- **AC11:** `tools/motion-preview` run twice at the same `--out` path without `--force`
  fails on the second run rather than overwriting (FR17); run with `N` above 24 is rejected.
- **AC12:** `pnpm --filter @claudevid/motion build` and `... test` both succeed from a clean
  checkout, and `pnpm -r run test` (the whole workspace) still passes — i.e. this change does
  not regress 001's or 002's existing suites (NFR3).

## Edge Cases

- A layer with `animation.enter` set to a name **not** in the registry — `compileMotion`
  treats this as a diagnostic (FR9-style hard failure), not a silent no-op, so a typo'd
  preset name is caught before render rather than producing an unanimated layer with no
  explanation.
- `stagger` set on a non-`group` layer's `animation` — schema-legal (FR13's field is generic
  on `Animation`) but semantically a no-op; `compileMotion` emits a diagnostic rather than
  silently ignoring it, since a spec author (or Claude) setting it there almost certainly
  meant something.
- A group with zero children and `stagger` set — resolves to an empty track map for that
  group, no error (nothing to stagger, nothing wrong).
- Two consecutive scenes both declaring a `transition.duration` that, combined with a third
  adjacent scene, would need more overlap than any single scene has frames for — each
  transition's overlap is computed independently against its own two neighbours (FR12's
  `min` guard is pairwise), so this cannot cascade into a negative-duration scene.
- A `cross-fade` `duration` of `0` — degrades to identical behavior as `kind: "cut"` (no
  special-cased zero-duration branch needed; the overlap-frame math naturally produces a
  zero-length overlap window).

## Dependencies

- **Depends on:** 001-videospec-core (`Timeline`, `compileTimeline`, `layerKey`, core's
  `easing.ts` primitives, `Diagnostic` type) — extended per FR12/FR13, not replaced. 002-
  canvas-render-engine (`renderFrame`, the raster-cache painters, `RenderStats`) — extended
  per FR15/FR16, not replaced.
- **Depended on by:** 004 (code-block layer — will want its own `Channel`/`Track` additions
  for typewriter-style reveal once the invalidating-channel follow-up lands), 007 (CLI/Claude
  skill — consumes `exportCatalogue()` for the director prompt).

## Notes

### Scope cuts from the original proposal, and why

- **Colour, `fontSize`, `letterSpacing`, text-reveal channels — deferred.** These are the
  "invalidating" channels in the proposal's cost table; animating them safely needs a cost-
  diagnostic mechanism this change does not build (see next bullet). Shipping the free
  channels first, cleanly, is the actual "grows automatically" story the proposal argued for
  presets — applied here to channels too.
- **Cost-class diagnostics ("animate `scale` instead of `fontSize`") — deferred.** With no
  invalidating channel shipped in v1, there is nothing yet for this diagnostic to guard. The
  two diagnostics this change *does* ship (FR9: timing clamp, FR4: unsettled spring) are
  narrower, fully specified, and fail-closed — the disposition ambiguity the proposal's
  BLOCK/WARN findings raised is resolved for both by explicitly reusing `parseSpec`'s existing
  `ok: false` convention.
- **Raw keyframe track authoring / `allowRawTracks` — deferred entirely, not gated.** V1 ships
  presets only; there is no spec-facing `Track`-authoring surface at all, so there is no
  escape-hatch flag to place a holder on. When invalidating channels land, `allowRawTracks`
  (if still wanted) needs an operator-supplied holder (CLI/host config, never a spec field) —
  recorded here so that decision isn't rediscovered from scratch.
- **`push`/`wipe`/`dip-to-colour`/`shared-element` transitions — deferred.** `shared-element`
  in particular needs a unique-cross-scene-id guarantee `@claudevid/core` doesn't currently
  provide (layers other than `GroupLayer` have no `id` field at all) and an ambiguous-match
  policy; `push`/`wipe` need new buffer-composition primitives in `renderer-canvas` beyond a
  two-pass cross-fade. Both are real, scoped follow-ups, not "just" registry entries — a
  registry-of-transitions design was considered and rejected (party-architect's rebuttal:
  transitions aren't built from existing free channels the way presets are, so registry data
  would hide a renderer co-change rather than remove it).
- **`blur-in`, `counter`, `draw-on`, attention-beats (`pulse`/`shake`/`wiggle`) presets —
  deferred, and not "just" future registry entries.** Each needs a renderer capability that
  doesn't exist yet: `blur-in` needs a blur filter, `draw-on` needs path-length/stroke-dash
  support (no path/SVG layer exists), `counter` needs a formatted-number text channel,
  `wiggle`/`shake` need the (deferred) rotation-jitter or skew channel at a repeat cadence
  (`repeat` isn't in v1's `Track`). Recorded here per `GOALS.md`'s ask, so a future change
  doesn't have to rediscover why these aren't in the registry.
- **`Track.keyframes`/`repeat`/`direction` — deferred.** Every shipped v1 preset is a single
  `from → to` segment; keyframes/repeat/direction each demand a resolution rule the party
  panel correctly flagged as unspecified. Cutting them from `Track` entirely (rather than
  documenting a rule for fields nothing yet uses) removes the ambiguity instead of describing
  it.
- **Preset versioning — convention, not a runtime field.** See FR6. Revisit if/when there is
  more than one deployed consumer of the registry.

### Forward-compatibility notes for later changes

- 004 (code-block layer) will likely need a `revealChars`/discrete-step channel and its own
  `Track.property` extension — the `Channel` union in `properties.ts` is designed to grow
  (new string literal + a new interpolator module), not to be reopened structurally.
  `properties.ts`'s registry is deliberately unexported-union-friendly for this.
- The `min`-guarded transition-overlap arithmetic in FR12 is the piece 005 (encoder, not yet
  built) will need to read before it can decide whether chunk boundaries may fall inside a
  transition's overlap window — flagged here, not solved here.
