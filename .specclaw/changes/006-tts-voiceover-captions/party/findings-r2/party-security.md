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
