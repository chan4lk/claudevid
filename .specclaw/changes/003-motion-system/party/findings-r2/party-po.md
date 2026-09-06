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
