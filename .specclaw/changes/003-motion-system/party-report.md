# Party Report: 003-motion-system

**Reviewed:** 2026-09-06
**Tier:** deep (classifier) — Unresolved design questions about motion vocabulary surface and transition overlapping would alter the core schema and API, combined with persistent animation properties in layer objects.
**Panel:** party-po(sonnet), party-architect(opus), party-ba(sonnet), party-security(opus), party-visionary(fable)
**Verdict:** CHANGES_REQUESTED

## Summary

37 findings: 8 BLOCK, 21 WARN, 8 NOTE upheld — 0 withdrawn

## Findings

### [BLOCK] party-architect — The existing preset enum and its renderer branches are never retired, leaving two sources of truth for what a preset is

**Quotes:** > Every new look ("slide-up-blur", "wipe-in-left") means a new enum member in the core Zod schema *and* a new `if` in the renderer *and* a change to Claude's director prompt.
**Quotes:** > New preset = a new entry in the registry. No core schema change, no renderer branch, and the catalogue is exported as documentation that change 007 injects into Claude's director prompt
**Quotes:** > - Physics beyond springs (collisions, particles, n-body)
**Problem:** The artifact names the existing mechanism precisely — an `AnimationPreset` enum inside core's Zod schema, plus `getEnterOpacity` and per-preset `if` branches in the renderer — and then introduces a parallel registry that produces the same names (`fade-up` appears in both). Nowhere in Scope, Out of Scope, or Impact does the proposal say the enum is deleted from core's schema, that `getEnterOpacity` is removed, or that the renderer's preset branches are stripped. "Files affected: ~28 new" describes only additions. Shipped as written, a spec containing `"fade-up"` has two resolvers that will disagree the moment the registry entry is tuned, and the core schema still rejects any preset name that only exists in the registry — which silently defeats the entire "no core schema change" claim the section rests on. No seat's round-1 finding disputes this; party-visionary's immutability finding on registry entries assumes the registry is the sole resolver, which is the state this finding says the commit does not reach.
**Fix:** Enumerate the deletions as co-changes in the same commit: the `AnimationPreset` enum member list, `getEnterOpacity`, and every renderer branch that reads a preset name — or state explicitly that the enum becomes an open `string` validated against the registry, and name that as a core schema change.
**Status:** upheld

### [BLOCK] party-architect — The package dependency is declared in both directions at once and the injection mechanism is unnamed

**Quotes:** > **Depends on:** 001-videospec-core (`Timeline`, easing), 002-canvas-render-engine (raster cache
> boundary — what is cheap to animate).
**Quotes:** > - `packages/motion/src/schema.ts` — Zod fragment contributed to core's layer/scene schema
**Problem:** `@claudevid/motion` is declared to depend on core for `Timeline` and easing, and simultaneously to contribute a Zod fragment *into* core's layer/scene schema. Core cannot import motion's fragment while motion imports core's types without a cycle. The word "contributed" hides the entire structural decision: is there a registration hook in core that motion calls at load time (order-dependent, and invisible to anyone reading core's schema), does core import motion (inverting the stated dependency), or does a third package compose both? An implementer must guess, and each guess produces a different package graph that the other seven files in Scope are then written against. party-security's `allowRawTracks` finding sharpens this rather than resolving it: a schema fragment whose validity is conditioned on an operator option must be constructed, not statically registered, and the artifact names no construction point.
**Fix:** State the direction of the edge and the mechanism: either core owns a generic extension point motion registers into, or the composed schema moves to a package that depends on both. Name which package's `package.json` gains which dependency in this commit.
**Status:** upheld

### [BLOCK] party-architect — Spring baking needs a frame rate that the pure evaluation signature does not carry, and no component is named as the baker

**Quotes:** > Springs are solved and **baked to a fixed frame count at compile time**, so evaluation stays a
> pure lookup and the timeline's duration is knowable in advance
**Quotes:** > evaluate(tracks: Track[], localTime: number): PropertyBag   // pure
**Problem:** "Baked to a fixed frame count" is only meaningful relative to an fps, and fps is a timeline/render-config concern that appears nowhere in `evaluate(tracks, localTime)` — the signature takes seconds and a track list, with no frame rate, no baked table, and no compile step in sight. The artifact also never says which component *is* the compiler: `easing.ts` holds "spring solver + baking", but baking must run after fps is known and before evaluation, which places it at a seam (core's `compileTimeline`? the render engine's setup? change 005's worker bootstrap?) that no line of the proposal identifies. Two implementers will put the bake in two different layers, and the one who puts it inside `evaluate` destroys the purity the whole design is justified by. party-visionary's finding that the bake couples duration to fps is the six-month consequence of the same unnamed seam; the merge-time defect is that no file in Scope is designated to receive fps.
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
**Problem:** Section 1 states the mechanism as settled ("the compiler emits a diagnostic") and Scope lists `diagnostics.ts` as a deliverable, but the open question concedes the owning layer is unchosen, and the two options are not interchangeable: one adds a motion dependency to core and changes `compileTimeline`'s public signature (a co-change to change 001 and every existing caller of it), the other leaves core untouched but means a spec can pass validation and only warn once a render begins. An implementer reading the solution section will build the first; an implementer reading the open questions may build the second. This is distinct from party-ba's and party-security's findings on the same lines: they ask what a diagnostic *does* (advisory vs blocking); this asks which component *owns* it and what public signature changes in this commit. Both must be answered, and the layer choice determines whether party-security's "non-zero exit in CI" fix is even reachable — a render-start diagnostic cannot fail a compile.
**Fix:** Pick the layer in this artifact, and if it is `compileTimeline`, list the signature change and its callers as co-changes. State the threshold as a number.
**Status:** upheld

### [WARN] party-architect — Transition timing semantics decide the meaning of timeline duration, and are left open while three other components depend on the answer

**Quotes:** > - **Do transitions overlap scene durations or extend the timeline?** A 0.5s cross-fade between
>   two 3s scenes yields either 5.5s (overlapping) or 6.5s (inserted).
**Quotes:** > Springs are solved and **baked to a fixed frame count at compile time**, so evaluation stays a
> pure lookup and the timeline's duration is knowable in advance
**Problem:** This is not a preference between two equally shaped designs — the two answers produce different `Timeline` duration arithmetic, different scene start offsets for every scene after the first, and, as the artifact itself notes, a chunk splitter in change 005 that can or cannot cut at scene edges. The proposal simultaneously claims duration is "knowable in advance" as a justification for spring baking, which is only true once this is decided; the bake window for a spring in the overlapped region differs between the two answers. Anything computing a scene's local time — which is the input to every function in this package — is downstream of it. party-po and party-visionary reached the same line from default-behaviour and irreversibility; this seat's claim is narrower and merge-scoped: `evaluate`'s `localTime` parameter, the one argument every function in Scope takes, has no defined origin until the question is answered, so the package cannot be implemented consistently in one commit.
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
**Problem:** The golden numeric tests are genuinely pure and need nothing. The second half of the sentence is not: a contact-sheet hash is a hash of rasterized PNG output, which requires change 002's canvas engine and, for anything with text, the host's font rasterization — so a test suite in `packages/motion` acquires a build-time dependency on the renderer and a hash that differs across machines. The proposal offers no seam at which the dumper can be given a recording stub instead of a real canvas, which is the point at which "no stub seam" turns into "these tests get skipped in CI". party-po's finding on the same line prices the re-baselining; this one says the tests cannot be run deterministically at all without a named double.
**Fix:** State the seam — a canvas-like interface `tools/motion-preview` accepts so it can be driven by a recording double in tests — or move contact-sheet hashing out of this package's test scope and keep motion's suite purely numeric.
**Status:** upheld

### [NOTE] party-architect — Rebuttal of party-visionary on transitions-as-closed-list: transitions and presets sit at different seams, so the preset remedy does not transfer
**Quotes:** > A transition is declared *between* scenes and evaluated above the layer loop, so change 002 can
> compose it as an operator over two scene buffers:
**Quotes:** > New preset = a new entry in the registry. No core schema change, no renderer branch
**Problem:** party-visionary reads the named transition list as "the exact shape the Problem section condemns for presets" and proposes making transitions registry entries built from the same track/channel model. The structural reading is wrong on the first half of that fix. Presets can be pure data because they compose channels the renderer already implements — `opacity`, `y`, `scale` are existing free mechanisms per the cost table, so a new bundle needs no renderer work. Transitions do not have that substrate: the artifact places them "above the layer loop" as "an operator over two scene buffers", and a `wipe` or a `push` is a new buffer-composition primitive in 002, not a combination of existing ones. Declaring them registry data would not remove the 002 co-change; it would hide it behind data that silently requires a renderer capability — the precedent party-visionary's own preset-families finding warns about. Their second alternative (state that transitions are intentionally a closed set and why) is the structurally sound one, and the closed-set boundary is itself a contract the artifact should name.
**Fix:** Uphold party-visionary's fallback only: state in the artifact that transitions are a closed set of buffer operators owned jointly with 002, and name what a contributor must add in both packages to extend it. Do not adopt the registry-of-transitions half of that fix.
**Status:** upheld

### [BLOCK] party-ba — The core problem evidence (quoted "doc" code) is unsourced and unverifiable from this artifact
**Quotes:**
> The doc's animation model is a **flat string enum**:
> evaluated by a single helper that returns an opacity:
> function getEnterOpacity(layer, localTime) { /* linear 0 → 1 */ }

**Problem:** The entire Problem section rests on these two code excerpts, attributed only to "the doc" — no filename, section, or version is cited anywhere in the proposal. As a round-1 reviewer with only this file, I cannot confirm the excerpt is current, complete, or representative of the actual requirement doc rather than a cherry-picked or paraphrased fragment. Every one of the four "ceiling" claims that follow ("only opacity animates", "presets are code branches", etc.) is derived entirely from this unverifiable quote. If the requirement doc has moved on, or the excerpt omits context that changes its meaning, the stated problem may not be the current problem.
**Fix:** Cite the exact document/section/commit the excerpts were pulled from so the claim is checkable.
**Status:** upheld

### [WARN] party-ba — The "~50× the cost" figure is asserted twice with no source, and drives a real design recommendation
**Quotes:**
> forces a full text re-layout every frame (~50× the cost).
> a model that emits `{ property: "fontSize", keyframes: [...] }` over
>   8 seconds has just made the render 50× slower.

**Problem:** The same unattributed multiplier appears once to motivate the cost-class table and again, unchanged, to justify the Open Questions recommendation to gate raw keyframe tracks behind an `allowRawTracks` flag. No benchmark, measurement methodology, or citation backs the number — it reads as a plausible-sounding illustrative figure treated as measured fact and then reused as load-bearing justification for a scope decision.
**Fix:** Either cite the benchmark this number comes from, or rephrase the justification qualitatively ("re-layout is substantially more expensive than a cached transform") without leaning on a specific unverified multiplier.
**Status:** upheld

### [WARN] party-ba — No acceptance criteria section exists; the proposal's central claims have no falsification path
**Quotes:**
> ## Scope
> ## Impact
> ## Open Questions

**Problem:** The proposal moves from Scope directly to Impact to Open Questions with no Acceptance Criteria section anywhere. The document's central claims — that this system "keeps generated videos fast by construction rather than by luck", that springs/OKLCH/stagger/shared-element transitions produce output that no longer reads as "generated", and that diagnostics prevent silent failures — have no stated observation that would confirm or falsify them at ship time. The only testing mentioned ("Golden numeric tests per interpolator; visual regression via contact-sheet hashes" under Scope) verifies interpolator correctness, not whether the stated problem (cheap-looking, slideshow-like generated video) is actually resolved.
**Fix:** Add acceptance criteria tied to the problem statement (e.g., specific diagnostic-trigger scenarios, a defined fps/cost threshold that must hold for a reference spec, or a shared-element-transition test that must visibly succeed) rather than only listing implementation test strategy.
**Status:** upheld

### [WARN] party-ba — "Diagnostic" is load-bearing and carries two contradictory readings (advisory warning vs. hard failure)
**Quotes:**
> the compiler **emits a diagnostic** when a spec animates an
> invalidating channel over a long window, telling the author (or Claude) the cheap equivalent
> the cost diagnostics exist precisely so
>   (b) fails loudly, but the default should be the safe surface.
> A 2s enter animation on
> a 1.2s layer is a **diagnostic**, not a silent truncation

**Problem:** "Diagnostic" is used three times to describe the mechanism that keeps the system safe (cost warnings, timing-clamp warnings), but the proposal never states whether a diagnostic is a non-blocking advisory (logged, generation continues) or a build-halting failure ("fails loudly" implies the latter). These are two different systems: one where Claude/the operator can ship an over-cost or over-long animation with a warning attached, and one where the pipeline refuses to proceed. Which reading is correct changes what gets built (error-handling path, whether generation can silently succeed with a warning nobody reads, or whether it blocks and requires a retry loop).
**Fix:** State explicitly whether a diagnostic blocks compilation/render or is advisory-only, for both the cost-class case and the timing-clamp case.
**Status:** upheld

I note that party-security's round-1 findings on the same "diagnostic" term (severity/disposition, `allowRawTracks` holder) independently converge on the same underlying ambiguity I flagged from the problem-evidence angle — this is a case of two seats finding the same fault line from different mandates, not duplication; theirs addresses trust-boundary consequence, mine addresses definitional ambiguity that changes what gets built. Both stand.

### [NOTE] party-ba — Proposal assumes an unestablished human-review step will catch what diagnostics don't
**Quotes:**
> otherwise Claude generates it, nobody notices, and the video ships with a title that never finishes appearing.
> will cheerfully produce a spec that renders at 4 fps, and nobody will know why.

**Problem:** The justification for diagnostics assumes a specific failure mode — that without them, a bad spec ships unnoticed — but the proposal never establishes what review process (if any) exists between spec generation and video output, or who is expected to read a diagnostic if one is emitted. This is probably a safe assumption for an AI-generated-video pipeline with no human-in-the-loop review, but it is asserted rather than shown.
**Fix:** None required if the no-human-review assumption is already established elsewhere (context.md); flagging only because this artifact alone doesn't establish it.
**Status:** upheld

### [WARN] party-po — Do-nothing cost is stated only as qualitative severity, never quantified
**Quotes:**
> Four things are wrong with it, and each one is a
> ceiling the library would hit within a week of real use:
> the single most obvious "this was generated" tell in an explainer video.

**Problem:** "Would hit a ceiling within a week" and "most obvious tell" are severity claims with no unit attached — no frequency of scenes needing stagger, no estimate of how often a generated video would need more than opacity/fade, no cost of the "tell" in terms of usable output. The whole ~28-file, large-complexity build is justified against an unquantified inconvenience. A reader cannot check whether the spend matches the harm.
**Fix:** Attach even one number — e.g. "X of Y sample scripts in the requirement doc need stagger or a transition beyond cut" — so the scope can be checked against the harm it claims to fix.
**Status:** upheld

### [WARN] party-po — Full preset catalogue shipped day one, despite the proposal's own argument that presets are cheap to add later
**Quotes:**
> New preset = a new entry in the registry. No core schema change, no renderer branch, and the
> catalogue is exported as documentation that change 007 injects into Claude's director prompt —
> so the model's expressive range grows automatically as the registry grows.
> Preset families shipped: fades, slides (4 directions), scale/pop, blur-in (pre-rendered), clip
> wipes (4 directions), typewriter, counter (animated numbers), draw-on (path length), and
> attention beats (pulse, shake, wiggle).

**Problem:** The proposal argues the registry design makes new presets free to add ("no core schema change, no renderer branch"). If that's true, it is also the argument for *not* shipping all ~9 families (several with 4 directional variants) in the first cut. `blur-in (pre-rendered)`, `counter`, `draw-on (path length)`, and the three `attention beats` are each a distinct interpolation/rendering concern bundled into v1 with no per-item value stated beyond appearing in the list. The cheaper variant — ship the engine + track model + stagger + a handful of presets (fade, slide, scale) proven out by change 007's prompt, then grow the catalogue exactly as the proposal says the mechanism allows — is never considered. (Round 1's own visionary and architect findings independently confirm several of these families require renderer capabilities the cost-class table never accounts for, which only sharpens this: those families are not "free registry entries" at all, and the case for deferring them is stronger than round 1 stated.)
**Fix:** Cut the preset list to the families that block a first usable video (fade/slide/scale + stagger), and treat draw-on/counter/blur-in/attention-beats as registry additions in a follow-up change, consistent with the proposal's own "grows automatically" claim.
**Status:** upheld

### [NOTE] party-po — Shared-element transition is bundled with the simple transition set, with no separate cut line named
**Quotes:**
> - `cut` (default), `cross-fade`, `dip-to-colour`
> - `push` / `slide` (4 directions), `wipe` (4 directions + radial)
> - **`shared-element`** — layers in adjacent scenes carrying the same `id` are matched and
>   their position/scale/colour interpolated across the boundary. This is the "one continuous
>   idea" effect that makes a sequence read as an argument rather than a deck. It is the reason
>   change 001 assigns stable `layerKey`s.

**Problem:** `cut`/`cross-fade`/`push`/`wipe` are all single-buffer interpolations; `shared-element` requires cross-scene layer matching by id and is presented as depending on a change-001 guarantee (stable `layerKey`s). It is a categorically different (and pricier) piece of work from the rest of the transition list, but it is listed as one more bullet rather than named as a separable slice that could ship after the simpler transitions land and prove out the timeline-level evaluation model.
**Fix:** Name `shared-element` as its own cut line — ship `cut`/`cross-fade`/`push`/`wipe` first, land `shared-element` once cross-scene id matching is validated.
**Status:** upheld

### [WARN] party-po — Recurring visual-regression test cost is unstated
**Quotes:**
> Golden numeric tests per interpolator; visual regression via contact-sheet hashes

**Problem:** "Visual regression via contact-sheet hashes" is a per-preset, per-transition, per-interpolator artifact that must be generated and compared on every change to `packages/motion` — across ~9 preset families, multiple transitions, and 4 interpolator types. No number is given for how many contact sheets this produces, how large they are, or how often they need re-baselining (a cost that recurs every time a preset's visual output legitimately changes). This is exactly the "recurring cost without a stated number" case. (Round 1's architect finding on the missing stub seam and machine-dependent rasterization is a structural companion to this: even setting seams aside, the sheer per-item count of this recurring artifact is never priced.)
**Fix:** State the expected contact-sheet count and the process/cost for re-baselining hashes when a preset intentionally changes.
**Status:** upheld

### [WARN] party-po — Shipped default for transition duration semantics is left undecided
**Quotes:**
> **Do transitions overlap scene durations or extend the timeline?** A 0.5s cross-fade between
> two 3s scenes yields either 5.5s (overlapping) or 6.5s (inserted). Overlapping is correct for
> video but complicates change 005's chunk-boundary splitting, since chunks can no longer be cut
> cleanly at scene edges.

**Problem:** This isn't an edge case — it's the default behavior of every scene transition a user or Claude ever declares, and it changes total video duration by design. The proposal identifies the correct answer ("overlapping is correct for video") but does not commit to it as the default, leaving the single most user-visible behavior of feature 7 unresolved going into planning. Round 1's visionary finding raises the stakes further by noting this is a one-way door once specs and audio are produced under one rule — which strengthens rather than weakens the case that this default must be committed in this artifact, not left open.
**Fix:** Commit to overlapping-by-default in this proposal (the correctness call is already made in the text), and scope the change-005 chunk-splitting consequence explicitly rather than leaving it as an open question.
**Status:** upheld

### [BLOCK] party-security — Preset catalogue is exported as untrusted content directly into the director prompt
**Quotes:**
> New preset = a new entry in the registry. No core schema change, no renderer branch, and the
> catalogue is exported as documentation that change 007 injects into Claude's director prompt —
> so the model's expressive range grows automatically as the registry grows.

**Problem:** Registry entries — names, descriptions, and any prose in a preset bundle — are concatenated into a model prompt with no stated escaping, delimiting, or allow-listing. Any preset added by a third-party package, a user config, or a generated file becomes prompt text in a trusted position: it can instruct the director to emit arbitrary spec content, including `allowRawTracks` usage or channels the operator disabled. No seat's round-1 finding removes this entry point; party-visionary's independent reading of the same line ("the catalogue is exported as documentation that change 007 injects into Claude's director prompt") treats the registry as an unversioned persisted grammar, which concedes rather than rebuts that registry content flows unreviewed into the prompt. Nothing on the page constrains the catalogue to a first-party, in-repo, reviewed source.
**Fix:** State that catalogue export emits only structured fields (preset name plus typed track data) rendered by a fixed template, never free-form registry prose; restrict prompt injection to the first-party shipped registry, and require any externally-registered preset to be excluded from the prompt unless explicitly allow-listed by the operator.
**Status:** upheld

### [BLOCK] party-security — Cost and over-length "diagnostics" have no stated severity, so the design fails open by default
**Quotes:**
> The cost class is not decoration — the compiler **emits a diagnostic** when a spec animates an
> invalidating channel over a long window, telling the author (or Claude) the cheap equivalent
> ("animate `scale` instead of `fontSize`"). This is the mechanism that keeps generated videos fast
> by construction rather than by luck.
> A 2s enter animation on
> a 1.2s layer is a **diagnostic**, not a silent truncation — otherwise Claude generates it, nobody
> notices, and the video ships with a title that never finishes appearing.

**Problem:** "Emits a diagnostic" is never bound to an outcome. A diagnostic that does not fail the build, and is not recorded in a machine-readable artifact, is a warning printed into a log nobody reads during an unattended generation run — the exact failure the second quote says it is preventing. The render still completes and still returns a green result, so a 4 fps spec and a truncated title are indistinguishable from a healthy run at the only place an operator looks: the exit status and the output file. Two other seats independently reached the ambiguity from their own lenses — party-ba on the term carrying "two contradictory readings (advisory warning vs. hard failure)" and party-architect on the owning layer being unchosen — which confirms the disposition is genuinely absent from the page rather than implied by it. Neither of their fixes closes the fail-open path: naming the layer and defining the term still permits "advisory, logged, run continues green" as the answer.
**Fix:** Assign each diagnostic class a stated disposition: cost diagnostics and clamped-animation diagnostics must be non-zero-exit errors in non-interactive/CI mode (overridable only by an explicit operator flag), and in all modes must be written to a persisted diagnostics record emitted alongside the video so a degraded run is distinguishable after the fact.

**Status:** upheld

### [BLOCK] party-security — `allowRawTracks` is an escape hatch with no stated holder; if the spec can set it, the reviewed party controls its own gate
**Quotes:**
> (c) presets by default, raw tracks behind an opt-in `allowRawTracks` flag. **Recommendation: (c)** — the cost diagnostics exist precisely so
> (b) fails loudly, but the default should be the safe surface.

**Problem:** The proposal never says where `allowRawTracks` lives. If it is a field the spec carries — and a spec is the artifact Claude authors — then the model that the flag exists to constrain can set the flag and grant itself the unconstrained surface, with no operator in the loop. The safety argument leans entirely on "the cost diagnostics exist precisely so (b) fails loudly", and party-ba's round-1 finding independently shows that the "50× slower" figure this recommendation rests on is itself unsourced, while my finding above shows nothing on the page makes a diagnostic loud enough to stop a run. Both legs of the fallback control are therefore absent, and no seat has identified an operator-side holder for the flag anywhere in the artifact.
**Fix:** State that `allowRawTracks` is an operator-supplied render/compile option (CLI flag or host config) and is explicitly rejected if present anywhere in the spec document; a spec containing raw tracks without the operator option must be a hard schema rejection, not a downgrade to presets.

**Status:** upheld

### [WARN] party-security — Spring solver and repeat/loop are unbounded compile-time work with no stated limits
**Quotes:**
> Springs are solved and **baked to a fixed frame count at compile time**, so evaluation stays a
> pure lookup and the timeline's duration is knowable in advance (a spring that settles on its own
> schedule cannot be composed into a fixed-length scene).
> repeat?: number | "loop"; direction?: "normal" | "alternate"

**Problem:** `spring({ stiffness, damping, mass, velocity })` accepts author-supplied numbers with no stated valid ranges. A near-zero `damping` or `mass`, or a negative value, produces a spring that never settles — so "baked to a fixed frame count" either loops until a settle threshold that never arrives (unbounded compile time and memory for the baked table) or silently truncates the motion. `repeat: number` is likewise unbounded, and the spec is model-authored, so these values arrive from a generator that has no cost intuition. Two seats attacked the same sentence from other angles in round 1 — party-architect on which component performs the bake and where fps enters, party-visionary on frame-count-versus-seconds coupling — and both fixes are compatible with mine and neither supplies a bound. The proposal names no valid range and no behaviour on a degenerate solve.
**Fix:** Schema-bound `stiffness`/`damping`/`mass`/`velocity` to positive finite ranges and `repeat` to a maximum count; cap the bake at a hard maximum frame count and make hitting the cap a rejection with a diagnostic, never a silent truncation of the curve.

**Status:** upheld

### [WARN] party-security — Shared-element matching is control flow driven by model-authored ids with no stated collision behaviour
**Quotes:**
> - **`shared-element`** — layers in adjacent scenes carrying the same `id` are matched and
> their position/scale/colour interpolated across the boundary.
> **Shared-element transitions need stable ids across scenes.** Should core's schema *require*
> unique layer ids, or should matching be opt-in via an explicit `sharedId`?

**Problem:** Matching is a control-flow decision made from a model-authored string field, and the proposal's own open question concedes uniqueness is not currently guaranteed. The behaviour when two layers in the same scene share an id, when an id matches by accident across unrelated scenes, or when a match is found but the two layers have incompatible types is unspecified — leaving an ambiguous match to resolve as first-wins or last-wins silently. Party-po's round-1 NOTE on the same lines argues shared-element is a separable slice; deferring it does not change the failure mode when it does ship, and party-architect's `random`-seed finding establishes the same pattern the panel already accepts — an underspecified nondeterminism inside the pure evaluator. The visible result here is a wrong-element morph in the shipped video with nothing in the run to indicate a match was ambiguous.
**Fix:** Require ids used for shared-element matching to be unique within a scene, and specify that an ambiguous or type-incompatible match degrades to `cut` **and** emits a recorded diagnostic rather than picking a candidate silently.

**Status:** upheld

### [NOTE] party-security — `motion-preview` writes files with no stated output-path constraint
**Quotes:**
> - `tools/motion-preview` — frame contact-sheet dumper
> A dumper that renders N evenly-spaced frames of a scene to a single PNG grid.

**Problem:** The dumper's only stated effect is writing a PNG, and neither the destination path nor `N` is constrained on the page. If the output path is derived from spec content (scene name, layer id) it is model-authored text reaching a filesystem path, and an overwrite of an existing file is an irreversible effect with no stated recovery. `N` is unbounded, so a large value is unbounded render work and disk. Party-architect's round-1 finding on the same tool argues it lacks a stub seam and acquires a renderer dependency; that neither establishes nor removes a path constraint, so the exposure remains undemonstrable from the text as written. Filed at NOTE for that reason.
**Fix:** State that the contact-sheet path is operator-supplied or a fixed derived slug (sanitised, no separators or traversal), that the tool refuses to overwrite an existing file without an explicit flag, and that `N` has a documented upper bound.

**Status:** upheld

### [NOTE] party-security — Rebuttal: party-architect's alternative fix, an open `string` validated against the registry, converts a fail-closed check into a fail-open one
**Quotes:**
> New preset = a new entry in the registry. No core schema change, no renderer branch, and the
> catalogue is exported as documentation that change 007 injects into Claude's director prompt —
> so the model's expressive range grows automatically as the registry grows.

**Problem:** Party-architect's first BLOCK is correct that two resolvers for `"fade-up"` will diverge, and I do not contest it. But its second offered remedy — making the preset name an open `string` validated against the registry — matters to my lens, because a closed enum in core's schema is currently the only fail-closed check on the page: an unknown preset name is rejected before anything resolves it. Combined with my first finding, if the registry is also the thing whose entries reach the director prompt and can be extended by a third-party package or generated file, then validating "against the registry" means the set of accepted names is defined by the same mutable surface that teaches the model what to emit — a check whose authority and whose subject are the same object, which is not a check. Whichever divergence remedy is chosen, the resolution must not be the one that widens the accepted-name set to whatever happens to be registered at load time.
**Fix:** If the enum is opened, state that registry validation runs against the first-party shipped registry snapshot only, that an unknown or externally-registered preset name is a hard schema rejection rather than a pass-through, and that registration order cannot widen the accepted set at runtime.
**Status:** upheld

### [WARN] party-visionary — The cost-class table is a hand-copied fact about 002's renderer, kept in sync by nobody
**Quotes:** > Every layer property becomes a typed animatable channel with a declared cost class:
> | `color`, `background` | colour | **invalidating** | re-raster |
> - `packages/motion/src/properties.ts` — animatable channel registry + cost classes
**Problem:** Whether `color` is free or invalidating is a property of how 002 paints, but it is declared in `packages/motion/src/properties.ts` and enforced by motion's diagnostic. The next change in 002 that tints cached glyph bitmaps with a composite operation (making `color` a free channel), or that adds a GPU path where `fontSize` is a transform, must also edit motion's table — and nothing fails if it doesn't. The drift is silent: the diagnostic keeps steering Claude (via 007's injected catalogue) away from a channel that is now cheap, and the only symptom is that generated videos never animate colour. No round-1 seat disputed this; party-architect's `PropertyBag` finding reinforces it by showing the channel/mechanism boundary is already undefined at merge, which is the boundary this pair drifts across.
**Fix:** Make 002 the authority — have it export a cost class per mechanism that `properties.ts` imports — or state in the artifact which side is authoritative and add a contract test that fails when the two disagree.
**Status:** upheld

### [WARN] party-visionary — Preset names and their numbers become a persisted, prompt-taught grammar with no version
**Quotes:** > "fade-up": [
>   { property: "opacity", from: 0, to: 1, easing: "out-cubic" },
>   { property: "y",       from: 48, to: 0, easing: "out-cubic" },
> ]
> New preset = a new entry in the registry. No core schema change, no renderer branch, and the
> catalogue is exported as documentation that change 007 injects into Claude's director prompt
**Problem:** The artifact argues only the additive case: a new preset is one registry entry. It does not address edit or removal. Once specs referencing `"fade-up"` are stored and 007 has taught Claude the catalogue, changing `from: 48` to `from: 32` silently re-renders every existing spec differently and breaks every contact-sheet hash; deleting a preset invalidates stored specs at Zod time. party-po's visual-regression finding independently names the same recurring event ("every time a preset's visual output legitimately changes") as an unpriced cost — that cost exists only because entries are unversioned. The registry is presented as cheap-to-grow data, but every entry becomes a frozen contract the moment a spec is saved.
**Fix:** State that released preset definitions are immutable (a changed look is a new name), or give registry entries a version that specs pin, so a later change to a preset is an addition rather than a rewrite of history.
**Status:** upheld

### [WARN] party-visionary — Baking springs to a frame count couples timeline duration to render fps
**Quotes:** > Springs are solved and **baked to a fixed frame count at compile time**, so evaluation stays a
> pure lookup and the timeline's duration is knowable in advance
> A dumper that renders N evenly-spaced frames of a scene to a single PNG grid. Reviewing motion
> should not require a 20-minute encode; this makes iterating on feel a 2-second loop
**Problem:** A spring baked to a frame count settles in a different number of seconds at 15 fps than at 60 fps. The first change that renders one spec at two rates — the `motion-preview` loop at a low rate for speed, then the final encode — either gets a preview whose timing lies about the final, or re-bakes per fps, in which case the "knowable in advance" duration is a function of fps and 005's chunk boundaries and 006's audio alignment inherit that dependency. party-architect's BLOCK on the same lines asks that the baker be named and given fps as an input; adopting that fix as written makes this coupling explicit rather than removing it, so the two findings are complementary, not duplicates.
**Fix:** Bake to a time duration in seconds (sampled at evaluation fps), or declare a canonical fps that defines duration and have all other rates resample from it, and say so in the artifact.
**Status:** upheld

### [WARN] party-visionary — Transitions are shipped as a closed named list, the exact shape the Problem section condemns for presets
**Quotes:** > New preset = a new entry in the registry. No core schema change, no renderer branch
> - `cut` (default), `cross-fade`, `dip-to-colour`
> - `push` / `slide` (4 directions), `wipe` (4 directions + radial)
> - `packages/motion/src/transitions.ts` — transition definitions incl. shared-element matching
**Problem:** Presets are made data precisely so that a new look does not need a schema enum member plus a renderer branch plus a prompt change. Transitions get no such statement: they are enumerated by name, `shared-element` has bespoke matching logic, and 002 is told to compose them "as an operator over two scene buffers". The contributor who adds a `zoom-through` transition one year on finds an enum in `schema.ts`, a branch in `transitions.ts`, a new operator in 002, and a manual edit to 007's prompt — the four-place change item 2 of the Problem section calls "precisely the design that stops libraries growing". No seat contested this in round 1.
**Fix:** Either declare transitions as registry entries built from the same track/channel model applied to two scene buffers (with `shared-element` as the one primitive that needs matching), or acknowledge in the artifact that transitions are intentionally a closed set and say why.
**Status:** upheld

### [WARN] party-visionary — The shipped preset families already break the "preset is a bundle of tracks" rule, so that is the precedent that will be copied
**Quotes:** > A preset is *data*: a named bundle of tracks.
> Preset families shipped: fades, slides (4 directions), scale/pop, blur-in (pre-rendered), clip
> wipes (4 directions), typewriter, counter (animated numbers), draw-on (path length), and
> attention beats (pulse, shake, wiggle).
**Problem:** `blur-in (pre-rendered)` needs a pre-render path in 002; `draw-on (path length)` needs a path-length channel; `counter` needs a formatted-number channel. None of those channels appear in the cost-class table, so the first release of the registry contains presets that require a new channel plus renderer support to exist. What a contributor learns from reading `presets.ts` is therefore "a preset may pull in a renderer mechanism", and the next one — `glow-in`, `blur-out`, `morph` — does the same, and the "no renderer branch" property is gone without anyone deciding to give it up. party-po's proposal to defer these families does not resolve this: it moves the undecided question to a follow-up change with no proposal in which to decide it.
**Fix:** Add `blur`, `pathLength`, and `counterValue` to the channel table with cost classes so those presets really are pure track bundles, or put them in a separately named tier in the registry ("requires renderer capability X") so the exception is visible rather than inferred.
**Status:** upheld

### [WARN] party-visionary — Transition duration semantics is framed as a pipeline trade-off; it is a one-way contract on every video's length
**Quotes:** > Do transitions overlap scene durations or extend the timeline? A 0.5s cross-fade between
> two 3s scenes yields either 5.5s (overlapping) or 6.5s (inserted). Overlapping is correct for
> video but complicates change 005's chunk-boundary splitting
**Problem:** The question is posed as a cost to 005's chunking. What it actually decides is the total duration of every spec that has a transition, and therefore the timestamp of every narration cue in 006 and every caption. Once specs and audio are produced under one rule, flipping to the other shortens or lengthens every existing video and desynchronises its audio; there is no later change that can reverse it without re-authoring. party-po and party-architect both ask that it be decided now; neither names it as irreversible, which is the part that changes what the decision must look like — a persisted per-transition field rather than a global rule, so the other semantics can be added later without rewriting old specs.
**Fix:** Decide it in this change, record it as irreversible, and make the chosen semantics an explicit persisted field on the transition rather than an implicit rule, so a later alternative can coexist with old specs instead of replacing them.
**Status:** upheld

### [NOTE] party-visionary — Presets hardcode pixel magnitudes; one step from parameterised presets before the static shape is pinned
**Quotes:** >   { property: "y",       from: 48, to: 0, easing: "out-cubic" },
> (a) named presets + a few
>   numeric params only — most reliable, least expressive
**Problem:** The recommended default surface is presets, and option (a) mentions "a few numeric params", but the registry entry shape shown is a static array with `48` baked in. The next change that makes `fade-up` resolution-aware (48px reads differently at 4K), or lets Claude say "fade-up, distance 24", has to change every registry entry from a static array to a template after specs and 007's prompt have pinned the static form. Defining entries as `(params) => Track[]` with defaults costs nothing now and is the seam that makes option (a) actually expressive.
**Fix:** Define preset entries as parameterised templates with defaults from the start, and let the catalogue export list the parameters.
**Status:** upheld

### [NOTE] party-visionary — Cost classes stop at a warning; the same data could drive 002's invalidation schedule for free
**Quotes:** > The cost class is not decoration — the compiler **emits a diagnostic** when a spec animates an
> invalidating channel over a long window
> Build `@claudevid/motion` — a **pure, declarative, time → property-bag evaluation engine**.
**Problem:** With a pure evaluator and declared cost classes, the compiler already knows for each layer the exact frames on which an invalidating channel changes value. Emitting that as an invalidation interval list would let 002 re-raster only on those frames — a 1s colour change in a 10s layer costs 30 re-rasters, not 300 — and would make the "long window" diagnostic a measured number rather than the unspecified heuristic party-architect and party-ba both flag. The artifact builds all the inputs and stops at telling the author to avoid the channel.
**Fix:** State that the diagnostics pass also emits per-layer invalidation intervals consumed by 002's raster cache, or record why that is deferred.
**Status:** upheld

### [NOTE] party-visionary — Rebuttal of party-po: deferring blur-in/counter/draw-on is not "consistent with the grows-automatically claim", because those presets are not registry additions
**Quotes:** > New preset = a new entry in the registry. No core schema change, no renderer branch, and the
> catalogue is exported as documentation that change 007 injects into Claude's director prompt —
> so the model's expressive range grows automatically as the registry grows.
> Preset families shipped: fades, slides (4 directions), scale/pop, blur-in (pre-rendered), clip
> wipes (4 directions), typewriter, counter (animated numbers), draw-on (path length), and
> attention beats (pulse, shake, wiggle).
**Problem:** party-po's fix treats `blur-in`, `counter`, and `draw-on` as items that can "grow automatically" later. The "grows automatically" property holds only for presets composed from channels already in the cost-class table; those three each need a channel that is not in the table and a mechanism in 002. Deferred, they arrive in a change whose proposal will read "just a registry addition" and then discover it is a schema plus renderer change — the precise mismatch this proposal's Problem section exists to remove. The long-horizon reading is the opposite of party-po's: the decision about whether such presets are allowed to pull in renderer capability must be recorded here, in the change that defines what a preset is, whether or not the presets themselves ship now.
**Fix:** If the families are cut for scope, keep the channel-table entries (`blur`, `pathLength`, `counterValue`) or the "requires renderer capability" tier in this proposal so the follow-up is genuinely a registry addition.
**Status:** upheld

## Dissent

No withdrawals.
