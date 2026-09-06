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

### [NOTE] party-ba — Proposal assumes an unestablished human-review step will catch what diagnostics don't
**Quotes:**
> otherwise Claude generates it, nobody notices, and the video ships with a title that never finishes appearing.
> will cheerfully produce a spec that renders at 4 fps, and nobody will know why.

**Problem:** The justification for diagnostics assumes a specific failure mode — that without them, a bad spec ships unnoticed — but the proposal never establishes what review process (if any) exists between spec generation and video output, or who is expected to read a diagnostic if one is emitted. This is probably a safe assumption for an AI-generated-video pipeline with no human-in-the-loop review, but it is asserted rather than shown.
**Fix:** None required if the no-human-review assumption is already established elsewhere (context.md); flagging only because this artifact alone doesn't establish it.
**Status:** upheld
