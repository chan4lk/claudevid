### [BLOCK] party-ba — The proposal's own text contradicts the accuracy claim that "captions cannot exist" rests on
**Quotes:** > Aligning against synthetic speech with a known reference transcript is a far easier problem than open transcription, so accuracy is high.
> **Alignment accuracy on technical jargon.** whisper.cpp may mis-segment `kubectl` or `useEffect`. Since we know the reference transcript, is constrained/forced alignment against it reliable enough, or do we need a fallback (proportional distribution across a phrase) when confidence is low?
**Problem:** The Problem section's second broken thing is "Captions cannot exist" because timings can't be guessed; the Proposed Solution names forced alignment as "the piece that unlocks everything" and asserts flatly that "accuracy is high." But the Open Questions section immediately walks that back to an open, unresolved doubt, and names exactly the vocabulary class (`kubectl`, `useEffect`) that this library exists to narrate (see also the pronunciation-lexicon item, which independently treats technical-term mispronunciation as "disqualifying for this library's exact use case"). If alignment on jargon is unreliable, the claim that "captions cannot drift from the audio by construction" is unverified for the proposal's core use case, not a settled fact used to justify the whole pipeline reordering.
**Status:** upheld

### [WARN] party-ba — Scale figures used to justify "large"/"medium-high" scope are asserted, not sourced
**Quotes:** > Every scene in a 30-minute video has this problem independently, and there is no way to fix it by hand at 360 scenes.
**Problem:** The 30-minute-video / 360-scene figures anchor the severity of "Scene durations are guesses" and, by extension, the case for a whole new package with two native ML runtimes rather than a narrower fix (e.g., a duration-check lint, or manual re-timing tooling). No source is given for this being a representative workload for this library (an actual video length distribution, a sampled project, an existing bug report). The number is illustrative arithmetic (30 min ÷ 360 ≈ 5s/scene), not evidence that this is what users actually produce.
**Status:** upheld

### [WARN] party-ba — Test descriptions have no failure threshold, so the proposal's headline claims are unfalsifiable at ship time
**Quotes:** > Tests: timing-drift assertion (captions vs audio), ducking level check, loudness target check, cache-hit behaviour on single-sentence edit
**Problem:** These are the only acceptance criteria offered for the proposal's strongest claims — "captions cannot drift from the audio by construction" and ducking being "the difference between 'has music' and 'sounds produced.'" "Timing-drift assertion" states no drift tolerance (10ms? 200ms?) and "ducking level check" states no target reduction, so as written neither criterion can distinguish a passing implementation from a broken one — any nonzero-effort implementation satisfies "there is an assertion." (The loudness criterion is partially rescued by the −14 LUFS figure given elsewhere in the proposal, but the other two are not.)
**Status:** upheld

### [NOTE] party-ba — "block" is used for two different granularities that determine what the cache actually re-synthesizes
**Quotes:** > Narration is synthesized per scene (or per narration block), keyed by a hash of
> `text + voice + speed + model version`, cached under `.claudevid/cache/tts/`. Editing one
> sentence re-synthesizes one block. This mirrors change 005's chunk resume and is what makes the
> edit loop survivable.
**Problem:** The synthesis unit is introduced as "per scene (or per narration block)" — two candidate granularities presented as interchangeable — and then the survivability claim ("editing one sentence re-synthesizes one block") only holds if a block is sentence-sized, not scene-sized. If "block" turns out to mean "scene" (the first-named option), editing one sentence in a multi-sentence scene re-synthesizes the whole scene's narration, which is exactly the "iteration is ruinous" failure the proposal opens by condemning, just at smaller scale. Which reading ships changes both the cache key granularity and the alignment/duration bookkeeping in `durations.ts`.
**Status:** upheld
