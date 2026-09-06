### [BLOCK] party-architect — The existing preset enum and its renderer branches are never retired, leaving two sources of truth for what a preset is

**Quotes:** > Every new look ("slide-up-blur", "wipe-in-left") means a new enum member in the core Zod schema *and* a new `if` in the renderer *and* a change to Claude's director prompt.
**Quotes:** > New preset = a new entry in the registry. No core schema change, no renderer branch, and the catalogue is exported as documentation that change 007 injects into Claude's director prompt
**Quotes:** > - Physics beyond springs (collisions, particles, n-body)
**Problem:** The artifact names the existing mechanism precisely — an `AnimationPreset` enum inside core's Zod schema, plus `getEnterOpacity` and per-preset `if` branches in the renderer — and then introduces a parallel registry that produces the same names (`fade-up` appears in both). Nowhere in Scope, Out of Scope, or Impact does the proposal say the enum is deleted from core's schema, that `getEnterOpacity` is removed, or that the renderer's preset branches are stripped. "Files affected: ~28 new" describes only additions. Shipped as written, a spec containing `"fade-up"` has two resolvers that will disagree the moment the registry entry is tuned, and the core schema still rejects any preset name that only exists in the registry — which silently defeats the entire "no core schema change" claim the section rests on.
**Fix:** Enumerate the deletions as co-changes in the same commit: the `AnimationPreset` enum member list, `getEnterOpacity`, and every renderer branch that reads a preset name — or state explicitly that the enum becomes an open `string` validated against the registry, and name that as a core schema change.
**Status:** upheld

### [BLOCK] party-architect — The package dependency is declared in both directions at once and the injection mechanism is unnamed

**Quotes:** > **Depends on:** 001-videospec-core (`Timeline`, easing), 002-canvas-render-engine (raster cache
> boundary — what is cheap to animate).
**Quotes:** > - `packages/motion/src/schema.ts` — Zod fragment contributed to core's layer/scene schema
**Problem:** `@claudevid/motion` is declared to depend on core for `Timeline` and easing, and simultaneously to contribute a Zod fragment *into* core's layer/scene schema. Core cannot import motion's fragment while motion imports core's types without a cycle. The word "contributed" hides the entire structural decision: is there a registration hook in core that motion calls at load time (order-dependent, and invisible to anyone reading core's schema), does core import motion (inverting the stated dependency), or does a third package compose both? An implementer must guess, and each guess produces a different package graph that the other seven files in Scope are then written against.
**Fix:** State the direction of the edge and the mechanism: either core owns a generic extension point motion registers into, or the composed schema moves to a package that depends on both. Name which package's `package.json` gains which dependency in this commit.
**Status:** upheld

### [BLOCK] party-architect — Spring baking needs a frame rate that the pure evaluation signature does not carry, and no component is named as the baker

**Quotes:** > Springs are solved and **baked to a fixed frame count at compile time**, so evaluation stays a
> pure lookup and the timeline's duration is knowable in advance
**Quotes:** > evaluate(tracks: Track[], localTime: number): PropertyBag   // pure
**Problem:** "Baked to a fixed frame count" is only meaningful relative to an fps, and fps is a timeline/render-config concern that appears nowhere in `evaluate(tracks, localTime)` — the signature takes seconds and a track list, with no frame rate, no baked table, and no compile step in sight. The artifact also never says which component *is* the compiler: `easing.ts` holds "spring solver + baking", but baking must run after fps is known and before evaluation, which places it at a seam (core's `compileTimeline`? the render engine's setup? change 005's worker bootstrap?) that no line of the proposal identifies. Two implementers will put the bake in two different layers, and the one who puts it inside `evaluate` destroys the purity the whole design is justified by.
**Fix:** Name the component that performs the bake, the input it takes (fps, scene duration), and the type the baked result has; then show how a baked spring reaches `evaluate` — as a field on `Track`, a second argument, or a closure captured at compile time.
**Status:** upheld

### [BLOCK] party-architect — `from: "random"` puts nondeterminism inside the component whose purity is the design's load-bearing claim

**Quotes:** > stagger({ each: 0.06, from: "first" | "center" | "last" | "random", easing?, overlap? })
**Quotes:** > It draws nothing. It takes tracks and a local time and returns resolved values. That purity is
> what makes it exhaustively testable, trivially parallelizable across the workers in change 005,
**Quotes:** > - Golden numeric tests per interpolator; visual regression via contact-sheet hashes
**Problem:** `random` takes no seed anywhere in the signature. An unseeded random stagger is not a pure function of `(tracks, localTime)`, which breaks the two properties the proposal spends its opening paragraph establishing: it cannot be golden-tested (every run reorders the cascade), and it cannot be "trivially parallelizable across the workers in change 005" — two workers rendering adjacent chunks of the same scene would each draw their own ordering and the cascade would visibly reshuffle at the chunk boundary. It also makes the "visual regression via contact-sheet hashes" line unimplementable for any preset using it.
**Fix:** Make the seed part of the contract — either a required `seed` field on `stagger`, or derive the permutation deterministically from the group's `layerKey`s that change 001 already assigns.
**Status:** upheld

### [WARN] party-architect — The `Track` shape leaves at least four resolution rules for the implementer to invent

**Quotes:**
```
type Track = {
  property: AnimatableProperty
  from?: Value; to?: Value          // shorthand
  keyframes?: { at: number; value: Value; easing?: Easing }[]
  easing?: Easing
  delay?: number; duration?: number
  repeat?: number | "loop"; direction?: "normal" | "alternate"
}
```
**Quotes:** > Animations are clamped to the layer's active interval from change 001.
**Problem:** Every field is optional, so the type admits states the prose never resolves. What happens when both `from/to` and `keyframes` are present — does one win, or is it an error? When a keyframe carries `easing` and the track also carries `easing`, which applies to the segment? What is `duration` when omitted — the layer's active interval, or the last keyframe's `at`? What does `repeat: "loop"` mean once clamping to the layer interval truncates the cycle mid-way — snap to the cycle boundary, or freeze at a partial value? And when two tracks in the same array target the same `property`, does the later one win or do they compose? This is a contract shared by the schema validator, the evaluator, the preset registry, and the diagnostics module; each unresolved rule is a place those four disagree.
**Fix:** For each optional field, state the default and the precedence rule, and state whether mutually exclusive combinations are schema errors or resolved silently.
**Status:** upheld

### [WARN] party-architect — `PropertyBag` is the contract with the renderer and its shape is undefined, particularly for transforms

**Quotes:** > evaluate(tracks: Track[], localTime: number): PropertyBag   // pure
**Quotes:** > - **transform** — composed as a matrix so rotation about a chosen origin behaves correctly
>   under nesting.
**Quotes:** > | `x`, `y` | number | free | transform |
**Problem:** The property table declares `x`, `y`, `scale`, `scaleX/Y`, `rotation`, `skew` as separate scalar channels, while the interpolator section says transforms are composed as a matrix. The output type `PropertyBag` is named but never defined, so it is unclear whether the renderer in change 002 receives six scalars and does its own composition (in which case "composed as a matrix so rotation about a chosen origin behaves correctly under nesting" is not motion's job at all) or receives a single pre-composed matrix (in which case the channel-level cost table and the diagnostics that read it operate on something that no longer exists at the output boundary). The transform origin is mentioned — "rotation about a chosen origin" — but no channel, field, or layer property supplies it. This is the one type both packages must agree on.
**Fix:** Define `PropertyBag` concretely, state whether transform channels arrive composed or raw, and name where the rotation origin comes from.
**Status:** upheld

### [WARN] party-architect — The body asserts the compiler emits cost diagnostics; the open questions say the layer is undecided

**Quotes:** > The cost class is not decoration — the compiler **emits a diagnostic** when a spec animates an
> invalidating channel over a long window
**Quotes:** > - **Where do cost diagnostics fire?** At `compileTimeline` (early, but core would need to know
>   about motion) or at render start (later, but keeps core motion-agnostic)? This is a layering
>   decision that affects change 001's public API.
**Problem:** Section 1 states the mechanism as settled ("the compiler emits a diagnostic") and Scope lists `diagnostics.ts` as a deliverable, but the open question concedes the owning layer is unchosen, and the two options are not interchangeable: one adds a motion dependency to core and changes `compileTimeline`'s public signature (a co-change to change 001 and every existing caller of it), the other leaves core untouched but means a spec can pass validation and only warn once a render begins. An implementer reading the solution section will build the first; an implementer reading the open questions may build the second. The "over a long window" threshold is also unspecified — no duration, no channel-specific cutoff — so the diagnostic itself is not reproducible between the two.
**Fix:** Pick the layer in this artifact, and if it is `compileTimeline`, list the signature change and its callers as co-changes. State the threshold as a number.
**Status:** upheld

### [WARN] party-architect — Transition timing semantics decide the meaning of timeline duration, and are left open while three other components depend on the answer

**Quotes:** > - **Do transitions overlap scene durations or extend the timeline?** A 0.5s cross-fade between
>   two 3s scenes yields either 5.5s (overlapping) or 6.5s (inserted).
**Quotes:** > Springs are solved and **baked to a fixed frame count at compile time**, so evaluation stays a
> pure lookup and the timeline's duration is knowable in advance
**Problem:** This is not a preference between two equally shaped designs — the two answers produce different `Timeline` duration arithmetic, different scene start offsets for every scene after the first, and, as the artifact itself notes, a chunk splitter in change 005 that can or cannot cut at scene edges. The proposal simultaneously claims duration is "knowable in advance" as a justification for spring baking, which is only true once this is decided; the bake window for a spring in the overlapped region differs between the two answers. Anything computing a scene's local time — which is the input to every function in this package — is downstream of it.
**Fix:** Decide it in this artifact and state the resulting duration formula, since `evaluate`'s `localTime` argument has no defined meaning without it.
**Status:** upheld

### [WARN] party-architect — Two easing homes: the full standard set lands in motion while core keeps the easing this proposal builds on

**Quotes:** > **Depends on:** 001-videospec-core (`Timeline`, easing)
**Quotes:** > - `packages/motion/src/easing.ts` — spring solver + baking (builds on 001's easing primitives)
**Quotes:** > The full standard set, CSS-compatible `cubic-bezier(x1,y1,x2,y2)`, `steps(n, jump)`, and —
**Problem:** The artifact names easing as an existing thing in core, then places "the full standard set" plus `cubic-bezier` and `steps` in a new `easing.ts` under motion, described only as "builds on". Which package owns the `Easing` type that appears in `Track` and in each keyframe is therefore unresolved, and if core's schema already validates easing names (it must, to have shipped the linear one this proposal criticises), there are now two lists of legal easing names that must be kept in sync. That is the same divergence pattern as the preset enum.
**Fix:** State whether the standard set is added to core's easing module and re-exported, or whether core's easing is reduced to primitives that motion composes — and if the latter, name it as a co-change to core.
**Status:** upheld

### [WARN] party-architect — The visual regression strategy has no stub seam; it runs through the render engine this package claims not to depend on

**Quotes:** > - Golden numeric tests per interpolator; visual regression via contact-sheet hashes
**Quotes:** > It draws nothing.
**Quotes:** > A dumper that renders N evenly-spaced frames of a scene to a single PNG grid.
**Problem:** The golden numeric tests are genuinely pure and need nothing. The second half of the sentence is not: a contact-sheet hash is a hash of rasterized PNG output, which requires change 002's canvas engine and, for anything with text, the host's font rasterization — so a test suite in `packages/motion` acquires a build-time dependency on the renderer and a hash that differs across machines. The proposal offers no seam at which the dumper can be given a recording stub instead of a real canvas, which is the point at which "no stub seam" turns into "these tests get skipped in CI".
**Fix:** State the seam — a canvas-like interface `tools/motion-preview` accepts so it can be driven by a recording double in tests — or move contact-sheet hashing out of this package's test scope and keep motion's suite purely numeric.
**Status:** upheld
