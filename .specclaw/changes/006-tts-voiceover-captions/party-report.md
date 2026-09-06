# Party Report: 006-tts-voiceover-captions

**Reviewed:** 2026-09-06
**Tier:** deep (classifier) — Unresolved questions about narration schema location and duration-auto support change what gets built, audio moves before timeline with mandatory AudioDurations feedback into 001's compileTimeline, and captions become a new persisted layer in the core schema.
**Panel:** party-po(sonnet), party-architect(opus), party-ba(sonnet), party-security(opus), party-visionary(fable)
**Verdict:** CHANGES_REQUESTED

## Summary

31 findings: 9 BLOCK, 16 WARN, 6 NOTE upheld — 0 withdrawn

## Findings

### [BLOCK] party-architect — Captions layer placed in `packages/audio` while its schema, rendering and animation are owned by three other packages
**Quotes:** > A `captions` layer registered into core, rendered by change 002, animated by change 003:
**Quotes:** > - `packages/audio/src/captions/` — captions layer schema, layout, styles, word emphasis
**Problem:** The proposal itself states the captions layer is registered into core, rendered by 002 and animated by 003, then puts its schema, layout and styles inside the audio package. Layer schema belongs where every other layer schema lives (core, per the "registered into core" phrasing); layout and style belong with the renderer that draws them. Placing them in `packages/audio` makes the render package depend on the audio package — or forces a duplicate caption schema on the core side — for a layer whose only audio input is a `{word,start,end}[]` array. The seam that keeps this clean is: audio emits word timings, core owns the layer schema, 002 owns layout/draw, 003 owns emphasis tracks. party-visionary reached the same placement on the long horizon (precedent for audio-reactive motion); that is a separate consequence of the same misplacement and does not change the merge-day reading: the dependency edge from 002 to 006 lands in this commit.
**Fix:** Reduce `packages/audio` to producing word timings and, if needed, caption *cue grouping*. Move the layer schema to core and layout/styles to the rendering package, or state explicitly in the artifact why 002 must import from 006.

### [BLOCK] party-architect — Second content-hash cache alongside the change-005 mechanism the proposal names
**Quotes:** > cached under `.claudevid/cache/tts/`. Editing one sentence re-synthesizes one block. This mirrors change 005's chunk resume and is what makes the edit loop survivable.
**Quotes:** > - `packages/audio/src/cache.ts` — content-hash TTS cache
**Quotes:** > footprint and where it lives (`~/.cache/claudevid/`?) needs deciding before anyone ships this
**Problem:** The artifact names an existing mechanism ("change 005's chunk resume"), says the new cache *mirrors* it, and then builds a separate `cache.ts` anyway with no stated reason 005's cache cannot be extended or shared. Two content-addressed caches in one product diverge on the first change to key derivation, eviction, or invalidation-on-version-bump. Worse, the artifact gives two different roots for on-disk state in the same document — `.claudevid/cache/tts/` (project-relative) for TTS artifacts and `~/.cache/claudevid/` (home-relative) for models — so this commit lands two cache roots as well as two cache implementations. Round-1 findings from party-security (lexicon absent from the key, no atomic write), party-visionary (key as named subset rather than resolved request), and party-visionary again (timings not cached alongside audio) are three independent defects in the *contents* of this second cache; each is a defect that a single shared cache layer would have had to solve once.
**Fix:** Either reuse/extend the change-005 cache layer for TTS blocks, or state in the artifact what 005's cache cannot do. Pick one cache root and one root-resolution helper for both models and TTS output.

### [BLOCK] party-architect — Co-change to `compileTimeline`'s signature and all its existing callers is unnamed
**Quotes:** > The audio pipeline measures the synthesized block and supplies an `AudioDurations` map to change 001's `compileTimeline`
**Quotes:** > **Recommendation: yes, with an optional `AudioDurations` argument**, so core stays I/O-free and 006 does not force a schema break.
**Quotes:** > - **Files affected:** ~20 new
**Problem:** This change adds a parameter to a core function in another package and adds `"auto"` as an accepted value of `duration`, but the Impact section counts only new files and the Scope section lists no core-side edits at all. At minimum the same commit must touch: `compileTimeline`'s signature, the `duration` field's type/validator in the 001 schema (a string union alongside a number), every existing call site of `compileTimeline`, and existing timeline tests that assert numeric durations. The proposal calls this "a genuine cross-change coupling into 001's timeline compilation" under Risk but never enumerates it as work, so the merge half-lands: audio can produce durations that core still rejects at validation. party-visionary's NOTE that the absent-map behaviour for `auto` is unspecified is the same seam viewed forward; the merge-day fact is that call sites and the validator are unlisted work.
**Fix:** Enumerate the core-side co-changes in Scope — schema union for `duration`, `compileTimeline` signature, call sites, validator, existing tests — and state whether 001 must merge first or in the same commit.

### [BLOCK] party-architect — Forced alignment described as a constrained problem but built on an unconstrained transcriber
**Quotes:** > We run **whisper.cpp** (Metal-accelerated on M3) over the *generated* audio to get word-level timestamps. Aligning against synthetic speech with a known reference transcript is a far easier problem than open transcription, so accuracy is high.
**Quotes:** > whisper.cpp may mis-segment `kubectl` or
**Quotes:** > `useEffect`. Since we know the reference transcript, is constrained/forced alignment against it
**Quotes:** > reliable enough, or do we need a fallback (proportional distribution across a phrase) when
**Quotes:** > confidence is low?
**Problem:** The design justifies whisper.cpp by asserting the problem is *forced alignment* (transcript known), but whisper.cpp is an open transcriber — it emits its own token sequence, which may not match the reference text at all. The proposal's own Open Question concedes this. That leaves the load-bearing contract of the whole change undefined: what happens when the recognized token stream and the reference transcript disagree? Word timings are the single artifact that drives captions, motion sync and SRT/VTT, so a token-mismatch reconciliation step (align recognized tokens to reference tokens; decide per-word what `start`/`end` means for an unmatched word) is a required component, not a fallback. It appears in neither Scope nor the file list. party-ba flags the accuracy *claim* as unevidenced and party-security flags the aligner's output as untrusted and its fallback as indistinguishable downstream; all three converge on a component that must exist and is not in the file list, which is the structural fact.
**Fix:** Name the reconciliation component in Scope (recognized-to-reference token alignment plus the proportional-distribution fallback) and specify its output contract: whether every reference word is guaranteed a timing, and what marks a low-confidence one.

### [WARN] party-architect — The word-timing artifact is the shared contract of four consumers and is specified only as `{ word, start, end }[]`
**Quotes:** > Output: `{ word, start, end }[]` per block. This single artifact drives captions, speech-synced
**Quotes:** > motion, and SRT/VTT export.
**Quotes:** > - reads the same word timings, so captions cannot drift from the audio by construction
**Problem:** Four consumers (captions layer, 003 emphasis tracks, SRT, VTT) share this type and an implementer must guess: are `start`/`end` block-relative or timeline-absolute, and if block-relative, who applies the offset and how does head/tail padding interact with it? Is `word` the reference token or whisper's token (see the mismatch above)? Is punctuation a word? Are lexicon respellings reflected in `word`, so a caption would render the phoneme spelling rather than `kubectl`? Two implementers will answer these differently, and the "cannot drift by construction" claim only holds if the offset convention is stated once. party-visionary asks for reserved `confidence`/`source` fields and party-security asks for an `estimated` marker; those are additions to a type whose existing three fields are themselves not pinned to an origin — the origin question must be answered first or the added fields inherit the same ambiguity.
**Fix:** Specify the timing origin (block-relative vs absolute) and who applies padding/offset, whether `word` is always the reference-transcript surface form, and how punctuation and lexicon-substituted terms appear.

### [WARN] party-architect — No deterministic test seam for tests that all depend on two native ML runtimes
**Quotes:** > - Tests: timing-drift assertion (captions vs audio), ducking level check, loudness target check,
**Quotes:** >   cache-hit behaviour on single-sentence edit
**Quotes:** > - **Risk:** medium-high — two native ML runtimes (onnxruntime-node, whisper.cpp) with model
**Quotes:** >   downloads and Apple Silicon build variance, plus a genuine cross-change coupling into 001's
**Problem:** Every listed test as written runs the real stack: timing-drift needs Kokoro plus whisper, cache-hit needs a real synthesis to populate the cache, ducking and loudness need real FFmpeg over real audio. Combined with model download-on-first-use and Apple Silicon build variance the proposal itself flags, these become the tests that get `skip`-ped in CI. There is no named interface between the pipeline and the two runtimes — no `synthesize()`/`align()` boundary with a fake — so there is nowhere to insert one later without restructuring. Note the cache-hit test in particular needs no model at all if synthesis is behind a seam. party-security's finding that the drift test grades the aligner against itself is the complementary defect: the test is both circular *and* has no stub seam, so fixing the circularity requires the fixture boundary named here.
**Fix:** Name the two injection points in Scope (a synthesis interface and an alignment interface) so cache, durations, graph-construction and SRT/VTT tests run against fixtures, and mark the runtime-dependent tests as a separately-gated integration tier.

### [NOTE] party-architect — FFmpeg is invoked from two packages with no stated shared invocation layer
**Quotes:** > - `packages/audio/src/graph.ts` — FFmpeg filter graph: gain, fades, ducking, loudnorm
**Quotes:** > - `packages/audio/src/mux.ts` — final mux into change 005's output
**Quotes:** > final mux against change 005's silent video with `-c:v copy -c:a aac`
**Problem:** Change 005 is named as the encoder and this change invokes FFmpeg independently for the graph and the mux. That means two packages resolve the FFmpeg binary path, two decide how to handle a non-zero exit, and two parse whatever FFmpeg writes to stderr. No correctness consequence at this commit, but the binary-resolution and exit-handling decision has one owner's worth of logic and two implementations. party-security's BLOCK on filtergraph string construction and its WARN on temp-file-plus-rename at mux both land inside this invocation logic; with two invocation sites, each of those fixes has to be applied twice or diverge.
**Fix:** State whether 006 reuses 005's FFmpeg invocation helper or deliberately owns its own, and if the latter, why.

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
**Problem:** These are the only acceptance criteria offered for the proposal's strongest claims — "captions cannot drift from the audio by construction" and ducking being "the difference between 'has music' and 'sounds produced.'" "Timing-drift assertion" states no drift tolerance (10ms? 200ms?) and "ducking level check" states no target reduction, so as written neither criterion can distinguish a passing implementation from a broken one — any nonzero-effort implementation satisfies "there is an assertion." (The loudness criterion is partially rescued by the −14 LUFS figure given elsewhere in the proposal, but the other two are not.) party-security's round-1 finding on the same test line independently observes that the drift assertion is circular against the aligner it grades — a distinct but reinforcing defect: the criterion is both untargeted and, even with a target, would need an independent ground truth to mean anything.
**Status:** upheld

### [NOTE] party-ba — "block" is used for two different granularities that determine what the cache actually re-synthesizes
**Quotes:** > Narration is synthesized per scene (or per narration block), keyed by a hash of
> `text + voice + speed + model version`, cached under `.claudevid/cache/tts/`. Editing one
> sentence re-synthesizes one block. This mirrors change 005's chunk resume and is what makes the
> edit loop survivable.
**Problem:** The synthesis unit is introduced as "per scene (or per narration block)" — two candidate granularities presented as interchangeable — and then the survivability claim ("editing one sentence re-synthesizes one block") only holds if a block is sentence-sized, not scene-sized. If "block" turns out to mean "scene" (the first-named option), editing one sentence in a multi-sentence scene re-synthesizes the whole scene's narration, which is exactly the "iteration is ruinous" failure the proposal opens by condemning, just at smaller scale. Which reading ships changes both the cache key granularity and the alignment/duration bookkeeping in `durations.ts`.
**Status:** upheld

### [WARN] party-po — Duration-fix and caption/motion-sync value are bundled into one large, dual-native-runtime change with no staged variant considered
**Quotes:**
> **4. Duration feedback into the timeline.**
> A scene carrying `narration` may declare `duration: "auto"`. The audio pipeline measures the
> synthesized block and supplies an `AudioDurations` map to change 001's `compileTimeline`
>
> **3. Word-level timings via forced alignment — the piece that unlocks everything.**
> Kokoro produces audio, not timings. We run **whisper.cpp** (Metal-accelerated on M3) over the
> *generated* audio to get word-level timestamps.
>
> **Risk:** medium-high — two native ML runtimes (onnxruntime-node, whisper.cpp) with model
> downloads and Apple Silicon build variance, plus a genuine cross-change coupling into 001's
> timeline compilation.
**Problem:** The proposal's own opening problem is "scene durations are guesses" — item 4 fixes that using only Kokoro's synthesized-audio length, no whisper.cpp involved. Whisper.cpp forced alignment is needed only for captions and motion-sync (items 5/6), a separate value proposition. The proposal ships both native ML runtimes, plus the full audio-graph/mux/export/lexicon stack, as one "large" / "medium-high risk" unit, and never names or prices the cheaper option of shipping duration-feedback (Kokoro + measurement only) first, deferring the whisper.cpp dependency to a second increment once the first is validated. Round-1 findings from party-architect (no test seam for the two-runtime stack) and party-security (fallback timings indistinguishable from measured ones) independently establish that the alignment half is the riskier, less-settled half of this change — reinforcing rather than undermining the case for splitting it from the duration-fix half.
**Fix:** Name the split explicitly: Kokoro-synthesis + duration-feedback as a smaller first cut; forced-alignment + captions + motion-sync + audio-graph as a follow-on that reuses the cache. State why (if there is a reason) they must land atomically instead.
**Status:** upheld

### [WARN] party-po — Per-render wall-clock cost of the pipeline is never quantified
**Quotes:**
> fast enough on M3 for real-time-plus synthesis
>
> We run **whisper.cpp** (Metal-accelerated on M3) over the *generated* audio to get word-level
> timestamps.
**Problem:** "Real-time-plus" and "Metal-accelerated" describe direction, not magnitude. This pipeline stage runs on every new/edited narration block for every render, on top of change 005's encode step, and the proposal's own example (30-minute video, 360 scenes) establishes the scale at which this cost compounds — but supplies no wall-clock estimate for synthesis+alignment at that scale, cached or cold. Without a number, the "iteration is ruinous... this is what makes the edit loop survivable" claim in scope item 2 can't be checked against the running cost it's meant to solve. Party-visionary's round-1 finding that alignment results are never cached (only audio is) sharpens this: as written, whisper.cpp reruns on every render regardless of cache-hit status on the synthesis side, which makes the unstated per-run cost larger than the proposal implies, not smaller.
**Fix:** State expected seconds-per-block for synthesis and alignment on the target M3 hardware, and the aggregate for a representative video, cache-cold and cache-warm.
**Status:** upheld

### [WARN] party-po — Configuration surface (per-scene voice/speed/pitch, four caption styles, configurable padding) is added with no value attached to the granularity itself
**Quotes:**
> Voice selection, speed and pitch are exposed per-spec and per-scene.
>
> - styles: word-by-word pop, phrase blocks, karaoke highlight (active word emphasized), classic
>   bottom-third
> - safe-area aware, with a distinct centred/burned style for vertical shorts
>
> configurable head/tail padding, minimum duration
**Problem:** The problem section motivates one caption need (captions must exist and not drift) and one duration need (scenes must not cut mid-sentence). Nothing in the problem section asks for four caption presentation styles, a dedicated vertical-format variant, or voice/speed/pitch control at both the spec level *and* the per-scene level rather than spec-level alone. Each knob is a permanent surface: more schema, more tests, more combinations to keep in sync with change 003's emphasis tracks. None of these four items has a stated value beyond "nice to have configurable."
**Fix:** For each knob, name the scenario that requires per-scene (not per-spec) override, and cut caption styles to the one the problem section actually needs, adding the rest only if a scene demonstrably requires it.
**Status:** upheld

### [NOTE] party-po — SRT/VTT export and the lexicon are cheap add-ons riding on the alignment artifact and could be named as an explicit late cut line
**Quotes:**
> **7. Sidecar exports.** SRT and VTT generated from the same word timings, for platform upload.
>
> **8. Pronunciation control.** A project lexicon mapping technical terms to phonemes or respellings
**Problem:** Both items are low marginal cost once word timings exist (item 3) and each has a stated value (platform upload, avoiding mispronunciation), so neither is objectionable on its own. But if the panel accepts the split proposed above (duration-feedback first, alignment-dependent features second), the proposal should say explicitly that items 7 and 8 belong to the *second* increment, not the first — right now they're listed as flat in-scope items with no shipping-order relative to items 1-4. Party-security's round-1 finding that the lexicon is missing from the cache key is a separate (correctness) defect in item 8 and does not change its value-per-cost; the sequencing point stands independently of whether that defect is fixed.
**Fix:** Tag each in-scope file with which increment it belongs to if the staged-delivery option above is adopted.
**Status:** upheld

### [BLOCK] party-security — Spec-supplied audio paths and track parameters are concatenated into one FFmpeg filter graph with no stated escaping
**Quotes:**
> Voiceover + background music + SFX composed through **one FFmpeg filter graph**:
> - per-track gain, fade in/out, trim, loop-to-length for music
> - `packages/audio/src/graph.ts` — FFmpeg filter graph: gain, fades, ducking, loudnorm
> - Music generation (bring your own track)

**Problem:** The music/SFX file path and every per-track number come from the video spec — a document authored by a model or pasted by a user — and land in a single FFmpeg filtergraph string. Filtergraph syntax is delimiter-sensitive (`,` `;` `:` `[` `]` `'` `\`) and supports source filters that read arbitrary files (`amovie=`/`movie=`), so a track path or gain value containing a delimiter does not fail — it silently redefines the graph. Filter *parameters* must live inside the graph string by construction, so the numeric surface exists regardless of how paths are passed, and no seat's round-1 finding names a quoting, allow-list, or numeric-range step between the spec and that string. party-architect's NOTE that FFmpeg is invoked from two packages with no shared invocation layer widens this: the escaping decision, if it is ever made, has two implementations.
**Fix:** Never build the graph by string concatenation from spec values: pass every media file as a separate `-i` input (paths as argv elements, never inside a filter string), reference them only by index in the graph, validate numeric parameters against explicit ranges and reject out-of-range values rather than clamping silently, and resolve every track path to a real file under the project or an explicitly configured asset root before invoking FFmpeg.
**Status:** upheld

### [BLOCK] party-security — Model output (whisper.cpp timestamps) is trusted as ground truth for timeline compilation with no validation against the known reference transcript
**Quotes:**
> We run **whisper.cpp** (Metal-accelerated on M3) over the *generated* audio to get word-level timestamps. Aligning against synthetic speech with a known reference transcript is a far easier problem than open transcription, so accuracy is high.
> Output: `{ word, start, end }[]` per block. This single artifact drives captions, speech-synced motion, and SRT/VTT export.
> The audio pipeline measures the synthesized block and supplies an `AudioDurations` map to change 001's `compileTimeline`

**Problem:** This is model-authored content steering the rest of the pipeline. whisper.cpp is an ASR model; its output can drop words, emit tokens the reference transcript does not contain, produce non-monotonic or zero-length spans, or return timestamps past end-of-audio. That guess becomes captions, motion trigger times, SRT/VTT sidecars, and — via `AudioDurations` — the compiled scene durations of the whole video. party-architect's round-1 BLOCK reaches the same entry point from the structural side (whisper.cpp is an open transcriber, so the recognized token stream may not match the reference at all, and no reconciliation component is named) and party-ba's BLOCK confirms the "accuracy is high" premise is contradicted by the proposal's own Open Questions. Three seats independently arriving at this input strengthens it: the reference transcript is available and is used only as an assumption, never as a verification oracle.
**Fix:** Treat the aligner's output as untrusted and validate it before it leaves `align.ts`: assert the returned word sequence matches the reference transcript token-for-token after normalization, assert timestamps are monotonic, non-negative, non-overlapping, and bounded by the measured audio length of the block. On any violation, fail the block loudly rather than emitting the timings downstream.
**Status:** upheld

### [BLOCK] party-security — The low-confidence alignment fallback produces guessed timings that are indistinguishable from measured ones downstream
**Quotes:**
> - **Alignment accuracy on technical jargon.** whisper.cpp may mis-segment `kubectl` or `useEffect`. Since we know the reference transcript, is constrained/forced alignment against it reliable enough, or do we need a fallback (proportional distribution across a phrase) when confidence is low?
> Output: `{ word, start, end }[]` per block. This single artifact drives captions, speech-synced motion, and SRT/VTT export.

**Problem:** The proposed fallback is exactly the guessed timing the Problem section calls unacceptable ("Guessed timings drift within seconds and read as broken"), reintroduced on the failure path. Because it emits the same `{ word, start, end }[]` shape with no confidence field and no marker, a block that fell back is shape-identical to a block that aligned: the render is green, the captions look plausible, the SRT ships to a platform, and no operator can tell which scenes are interpolated. party-visionary's round-1 WARN reaches the same gap from the evolution side ("the consumer cannot tell guessed from aligned") and their `confidence`/`source` field is the same remedy; the difference is that a missing provenance field is a migration cost to them and a fail-open to me — the shipped video is wrong and the run says nothing.
**Fix:** Decide the fallback question in favour of failing closed by default — a block below the confidence threshold errors and names the scene and phrase. If a proportional-distribution fallback is kept, it must be opt-in, must carry a per-word `estimated: true` flag through captions and SRT export, must emit a warning naming every affected block, and must be recorded in a run artifact so a shipped video's degraded scenes are recoverable after the fact.
**Status:** upheld

### [BLOCK] party-security — The TTS cache key omits the lexicon, so a pronunciation fix silently serves the old mispronounced audio forever
**Quotes:**
> Narration is synthesized per scene (or per narration block), keyed by a hash of `text + voice + speed + model version`, cached under `.claudevid/cache/tts/`. Editing one sentence re-synthesizes one block.
> **8. Pronunciation control.** A project lexicon mapping technical terms to phonemes or respellings (`kubectl`, `Nginx`, `PostgreSQL`, `TypeScript`, `npx`). Without it, a tech-explainer voiceover mispronounces its own subject matter, which is disqualifying for this library's exact use case.

**Problem:** The lexicon is an input that changes the synthesized audio and is absent from the enumerated cache key; pitch is too. The named workflow — a user hears `kubectl` mispronounced and adds a lexicon entry — changes no keyed input, so every already-cached block hits and the fix appears to do nothing, with no warning and no way to distinguish a correct hit from a stale one. party-visionary reached the identical hole in round 1 and their fix (key on the full resolved synthesis request object, so a new knob cannot bypass the key) is strictly better than enumerating inputs; I adopt it. I uphold rather than defer because their finding does not cover the second exposure in my quote's scope: the artifact names no validation of the cached *file*, so a truncated or partially-written entry from an interrupted run is replayed as audio on a green run.
**Fix:** Key on the full resolved synthesis request object per party-visionary, including a digest of the applied lexicon entries and the model file digest. Additionally: write cache entries atomically (temp file plus rename), store length/digest alongside so a partial entry is a miss rather than replayed audio, and document a cache-invalidation command and eviction policy for the unbounded `.claudevid/cache/tts/` directory.
**Status:** upheld

### [WARN] party-security — `duration: "auto"` has a stated floor but no ceiling, letting a measured or misaligned block drive unbounded timeline and render cost
**Quotes:**
> A scene carrying `narration` may declare `duration: "auto"`. The audio pipeline measures the synthesized block and supplies an `AudioDurations` map to change 001's `compileTimeline` (configurable head/tail padding, minimum duration).
> - final mux against change 005's silent video with `-c:v copy -c:a aac`

**Problem:** The design names a minimum duration and no maximum. A scene duration is a function of an untrusted input length (spec narration text) and, if the aligner's output feeds it, of model output. A pathological or accidental block — a pasted document, a runaway generation, a timestamp past end-of-file — silently becomes a scene of arbitrary length that 002 renders frame by frame and 005 encodes, with no bound and no prompt. Distinct from party-po's cost finding: theirs asks for a wall-clock *estimate* of the normal case, mine asks for a *bound* on the abnormal one. There is also no stated behaviour when total audio and total video length disagree at mux: `-c:v copy -c:a aac` with no length policy produces a mismatched file rather than an error.
**Fix:** Add a configurable per-scene and per-project maximum duration alongside the minimum; exceeding it errors and names the scene rather than clamping silently. At mux, assert the audio and video durations agree within a stated tolerance and fail with both numbers when they do not.
**Status:** upheld

### [WARN] party-security — The mux writes over change 005's expensive encode with no stated output destination or recovery path
**Quotes:**
> - final mux against change 005's silent video with `-c:v copy -c:a aac`
> - `packages/audio/src/mux.ts` — final mux into change 005's output

**Problem:** "into change 005's output" describes the only durable filesystem effect this change has, and the artifact never says whether the muxed file is a new path or a replacement of the silent encode. If it replaces it, a bad mux — wrong ducking, wrong loudnorm gain, fallback timings, a truncated audio track — destroys the one artifact that is expensive to regenerate, and recovery is a full re-render rather than a re-mux. No seat's round-1 finding addresses the destination of the write; party-architect's NOTE on FFmpeg invocation touches exit-code handling but not what is on disk when the exit code is non-zero.
**Fix:** State that mux writes to a distinct output path and never modifies the silent encode in place; write to a temp file and rename only on FFmpeg exit code 0 so an interrupted or failed mux cannot leave a truncated file at the final path; refuse to overwrite an existing output unless explicitly forced.
**Status:** upheld

### [WARN] party-security — Download-on-first-use names an integrity check but no root of trust, and one resolution of the whisper.cpp question executes an arbitrary user-supplied binary
**Quotes:**
> - Model acquisition: download-on-first-use with integrity check and a documented cache location
> - **whisper.cpp acquisition.** Bundle a prebuilt binary, require the user to install it, or use a Node binding (`nodejs-whisper` / `smart-whisper`)? Affects install friction significantly.
> Download on first use with a progress bar and integrity check, or an explicit `claudevid models install` step?

**Problem:** "Integrity check" without a pinned digest and a pinned source is self-certifying: verifying a downloaded file against a hash fetched from the same host that served it detects corruption, not substitution. The effect is an implicit network fetch of hundreds of megabytes of ML weights, triggered by an ordinary render, into a shared user-level cache writable by anything running as that user. The "require the user to install it" option resolves to invoking whichever `whisper` binary the ambient PATH supplies — a control-flow decision made by untrusted environment state. party-visionary's round-1 WARN independently shows the same unpinned model is also a *correctness* hazard (an unpinned model re-times every `auto` scene); a single pinned-and-verified model id satisfies both findings.
**Fix:** Pin each model to an explicit URL plus a digest committed in the repository, verify before first use and on every load from cache, and fail closed on mismatch rather than re-downloading. If an installed binary is used, resolve it from an explicit configured absolute path — not bare PATH lookup — and verify its version at startup. Grant network access only during an explicit `claudevid models install`, so a render never reaches the network implicitly.
**Status:** upheld

### [WARN] party-security — "Cannot drift by construction" and the timing-drift test grade the alignment against itself
**Quotes:**
> - reads the same word timings, so captions cannot drift from the audio by construction
> - Tests: timing-drift assertion (captions vs audio), ducking level check, loudness target check, cache-hit behaviour on single-sentence edit

**Problem:** The claimed invariant guarantees only that captions match the aligner's *belief* about the audio, not the audio; if the aligner is wrong, captions are wrong in lockstep and the invariant still holds. The proposed drift assertion inherits the circularity: comparing captions against the timings they were generated from passes by construction, including on a block that fell back to proportional distribution. party-ba's WARN that the test states no tolerance is a necessary but not sufficient repair — adding a threshold to a tautological comparison yields a tautology with a number. The mechanism that could detect misalignment is the mechanism being graded, and it always reports success.
**Fix:** Make the drift test independent of the aligner: for a fixture with known ground-truth word boundaries (or a silence-padded synthetic utterance whose boundaries are measurable from the waveform), assert the aligner's timings land within a stated tolerance of the measured boundaries, and assert the test fails when a deliberately perturbed alignment is injected. Drop the "by construction" claim from the design's guarantees; it is a statement about a shared variable, not about correctness.
**Status:** upheld

### [WARN] party-security — Rebuttal to party-visionary: an unmarked words-per-minute estimate for `auto` when `AudioDurations` is absent is the fail-open path, not a free preview
**Quotes:**
> **Recommendation: yes, with an optional
>   `AudioDurations` argument**, so core stays I/O-free and 006 does not force a schema break.
> A scene carrying `narration` may declare `duration: "auto"`. The audio pipeline measures the synthesized block and supplies an `AudioDurations` map to change 001's `compileTimeline`

**Problem:** party-visionary's round-1 NOTE correctly identifies that the artifact never says what `auto` resolves to when the map is absent, but their proposed remedy — a deterministic words-per-minute estimate substituted silently — makes the omission worse in exactly the direction the Problem section condemns. As proposed, `compileTimeline` called without the map produces a fully-formed timeline that is numerically indistinguishable from a measured one; the render pipeline that forgets to pass the map, or whose synthesis stage errored earlier, does not fail — it produces a video with guessed cut points and a green exit. The optional argument is the seam that makes the *absent* case the permissive default, and "clearly marked as an estimate" is stated as a doc property, not a runtime one. I am not asking them to withdraw; I am asking the panel to accept the estimate only with a guard.
**Fix:** If the estimate is adopted, make it unreachable by accident: require an explicit `mode: 'estimate'` argument rather than inferring it from an absent map, have `compileTimeline` throw on `auto` scenes when neither the map nor the explicit estimate mode is supplied, and mark every estimated scene in the compiled timeline so a downstream render or export can refuse to emit a final artifact built on estimates.
**Status:** upheld

### [WARN] party-visionary — The cache key is a hand-maintained list of "everything that changes the waveform", and the proposal already names two inputs it omits
**Quotes:** > Narration is synthesized per scene (or per narration block), keyed by a hash of
> `text + voice + speed + model version`, cached under `.claudevid/cache/tts/`.
> Voice selection, speed and pitch are exposed
> per-spec and per-scene.
> A project lexicon mapping technical terms to phonemes or respellings
**Problem:** The key enumerates four inputs, but the same document exposes pitch and a project lexicon as synthesis inputs and puts neither in the key. party-security independently filed the lexicon omission as a BLOCK on the fail-open axis; that convergence confirms the merge-day defect, but the long-horizon defect is the enumeration itself. party-security's proposed fix is a longer enumeration (text, voice, speed, model version, model file digest, lexicon digest, padding), which is the same pattern with more entries, and the next knob (emotion, SSML pauses, a second model) bypasses it in exactly the same way because the key lives in `cache.ts` and the knob lands in `tts.ts` or `lexicon.ts`. If party-po's staged split is adopted, this gets worse: increment one fixes the key shape before increment two adds the inputs that most need to be in it.
**Fix:** Define the key as a hash of the full resolved synthesis request object (post-lexicon text, all voice parameters, model id and digest) rather than a named subset, so adding a knob cannot bypass the cache without touching the request type. Adopt party-security's atomic-write and stored-digest points on top of that.
**Status:** upheld

### [WARN] party-visionary — `duration: "auto"` makes the visual timeline a function of an unpinned model download, so a model upgrade silently changes every existing video's cut points
**Quotes:** > keyed by a hash of
> `text + voice + speed + model version`
> Model acquisition: download-on-first-use with integrity check and a documented cache location
> A scene carrying `narration` may declare `duration: "auto"`. The audio pipeline measures the
> synthesized block and supplies an `AudioDurations` map to change 001's `compileTimeline`
**Problem:** No other seat addressed reproducibility. party-security's root-of-trust finding asks for a pinned URL and digest committed in the repository, which is necessary but pins the *library's* model, not the *project's*: a library upgrade six months on still re-times every `auto` scene in every existing spec, shifts every 003 motion cue, and re-flows every caption, and invalidates the whole TTS cache for every project at once. The proposal never says whether a spec records the model it was rendered with, so re-rendering an old spec on a fresh machine produces a different video with no warning.
**Fix:** State that the model id and version are a spec-level (or lockfile-level) fact the pipeline reads, not a machine-level fact it discovers, and that a mismatch is a warning rather than a silent re-time.
**Status:** upheld

### [WARN] party-visionary — Narration as a bare string plus multi-speaker out of scope closes the schema door the out-of-scope item would need
**Quotes:** > - Multi-speaker dialogue / character voices
> - **Where does narration live in the schema?** `scene.narration: string`, or a `voiceover` layer,
>   or a top-level script array indexed to scenes? The first is simplest for Claude to emit
>   correctly
**Problem:** Two round-1 findings from other seats sharpen this rather than weaken it. party-ba shows the survivability claim only holds if a "block" is sentence-sized, which means the schema must carry sentence segmentation the string cannot express. party-po questions per-scene voice/speed/pitch knobs; wherever they land, a structured narration block is the natural carrier and a bare string has no room for them. The change that adds character voices later has to either break every existing spec (string becomes object) or introduce a parallel field and support both forever, and the cache keys on the text so the migration also invalidates every cached block.
**Fix:** Whichever location is chosen, make the value a structured block (`{ text, voice?, speaker? }` or an array of them) from day one, with the bare string accepted as shorthand that normalises to it.
**Status:** upheld

### [WARN] party-visionary — The word-timings artifact is frozen by three consumers on merge day, and the proposal already names a case where consumers need provenance it does not carry
**Quotes:** > Output: `{ word, start, end }[]` per block. This single artifact drives captions, speech-synced
> motion, and SRT/VTT export.
> or do we need a fallback (proportional distribution across a phrase) when
>   confidence is low?
> does the `synthesize()` signature we write now accommodate a
>   provider that *returns its own word timings* (skipping alignment entirely)?
**Problem:** Three seats reached this type independently: party-architect asks it to state timing origin and surface-form conventions, party-security requires a per-word `estimated: true` marker on the fallback path, and this seat asks for provenance and segment grouping. That is three fields from three lenses on a type the proposal specifies as three fields total and describes as the piece that unlocks everything. If it ships as `{ word, start, end }` and each of those needs arrives as a separate later change, each is a three-consumer migration plus fixture rewrite; the first one sets the precedent that the type is frozen and the rest get bolted on as side maps.
**Fix:** Reserve the room now: a per-word `confidence` or `source` field, an optional phrase/segment grouping, and a stated timing origin, even if v1 always fills them with constants.
**Status:** upheld

### [NOTE] party-visionary — Putting the `captions` layer inside `packages/audio` teaches that a layer lives where its data comes from, and the named follow-on will copy it
**Quotes:** > - `packages/audio/src/captions/` — captions layer schema, layout, styles, word emphasis
> A `captions` layer registered into core, rendered by change 002, animated by change 003
> - Audio-reactive motion (waveform-driven animation) — a natural follow-on once timings exist
**Problem:** party-architect filed the merge-day layering problem as a BLOCK; this finding is the precedent it leaves if the block is resolved by exception rather than by rule. The contributor who picks up the named "natural follow-on" of audio-reactive motion will generalise from where captions landed, not from a reviewer comment on this change. If captions move to the renderer, the artifact should say *why* so the follow-on inherits the rule.
**Fix:** State in the artifact that layers live with the renderer and consume audio artifacts by type import only, and place `captions/` accordingly, so the follow-on has a correct template to copy.
**Status:** upheld

### [NOTE] party-visionary — The optional `AudioDurations` seam is one step short of letting the timeline compile without models at all
**Quotes:** > **Recommendation: yes, with an optional
>   `AudioDurations` argument**, so core stays I/O-free and 006 does not force a schema break.
> Total
>   footprint and where it lives (`~/.cache/claudevid/`?) needs deciding before anyone ships this
>   in CI.
**Problem:** party-architect's test-seam finding is the same gap seen from the test side: nothing can exercise `compileTimeline` on an `auto` scene without the real stack. The proposal never says what `auto` resolves to when the map is absent, so every future non-render consumer (storyboard preview, thumbnail extraction, schema linter, CI smoke test) either fails on `auto` scenes or downloads models first. A deterministic no-audio estimate defined now makes the whole preview class of changes free and gives the test seam a meaningful default.
**Fix:** Specify the absent-map behaviour for `auto` as a documented words-per-minute estimate, clearly marked as such, and have the real measurement replace it.
**Status:** upheld

### [NOTE] party-visionary — The cache stores the audio but not the timings or measured duration it was created to produce, so alignment is paid on every run the cache was meant to make free
**Quotes:** > Editing one
> sentence re-synthesizes one block. This mirrors change 005's chunk resume and is what makes the
> edit loop survivable.
> We run **whisper.cpp** (Metal-accelerated on M3) over the
> *generated* audio to get word-level timestamps.
**Problem:** party-po's unquantified wall-clock finding makes this concrete: whatever the per-block alignment cost is, as described it is paid for all 360 blocks on every edit, not the one that changed. If party-po's staged split is adopted, the risk is sharper still, because increment one fixes the cache entry as audio-only and increment two, arriving later with alignment, adds a second cache with a second key in `align.ts`; the two drift on the first key change. The content hash that identifies the audio identifies its timings and duration exactly.
**Fix:** Make the cache entry the full per-block artifact set `{ audio, timings, duration }` keyed once, with the timings slot allowed to be empty until alignment lands, so alignment and measurement are hits whenever synthesis is.
**Status:** upheld

## Dissent

No withdrawals.
