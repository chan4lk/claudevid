### [BLOCK] party-security — Spec-supplied audio paths and track parameters are concatenated into one FFmpeg filter graph with no stated escaping

**Quotes:**
> Voiceover + background music + SFX composed through **one FFmpeg filter graph**:
> - per-track gain, fade in/out, trim, loop-to-length for music
> - `packages/audio/src/graph.ts` — FFmpeg filter graph: gain, fades, ducking, loudnorm
> - Music generation (bring your own track)

**Problem:** The music/SFX file path and every per-track number come from the video spec — a document authored by a model or pasted by a user — and land in a single FFmpeg filtergraph string. Filtergraph syntax is delimiter-sensitive (`,` `;` `:` `[` `]` `'` `\`) and supports source filters that read arbitrary files (`amovie=`/`movie=`), so a track path or gain value containing a delimiter does not fail — it silently redefines the graph, and a crafted path can add inputs the spec never declared. The design names the graph as a single concatenated artifact and never names a quoting, allow-list, or numeric-range step between the spec and the string. Nothing in the artifact bounds a gain to a range or a path to the project directory either, so an out-of-range gain or an absolute path outside the project is accepted as written.

**Fix:** Never build the graph by string concatenation from spec values: pass every media file as a separate `-i` input (paths as argv elements, never inside a filter string), reference them only by index in the graph, validate numeric parameters against explicit ranges and reject out-of-range values rather than clamping silently, and resolve every track path to a real file under the project or an explicitly configured asset root before invoking FFmpeg.

**Status:** upheld

### [BLOCK] party-security — Model output (whisper.cpp timestamps) is trusted as ground truth for timeline compilation with no validation against the known reference transcript

**Quotes:**
> We run **whisper.cpp** (Metal-accelerated on M3) over the *generated* audio to get word-level timestamps. Aligning against synthetic speech with a known reference transcript is a far easier problem than open transcription, so accuracy is high.
> Output: `{ word, start, end }[]` per block. This single artifact drives captions, speech-synced motion, and SRT/VTT export.
> The audio pipeline measures the synthesized block and supplies an `AudioDurations` map to change 001's `compileTimeline`

**Problem:** This is model-authored content steering the rest of the pipeline. whisper.cpp is an ASR model; its output is a probabilistic guess that can drop words, hallucinate words the reference transcript does not contain, emit non-monotonic or zero-length spans, or return timestamps past the end of the audio file. That guess becomes captions, motion trigger times, SRT/VTT sidecars, and — via `AudioDurations` — the compiled scene durations of the whole video. The artifact's only defence is the asserted premise "accuracy is high", which is a reason to expect fewer failures, not a check that detects one. The reference transcript is available and is never used as a verification oracle, only as an assumption.

**Fix:** Treat the aligner's output as untrusted and validate it before it leaves `align.ts`: assert the returned word sequence matches the reference transcript token-for-token after normalization, assert timestamps are monotonic, non-negative, non-overlapping, and bounded by the measured audio length of the block. On any violation, fail the block loudly rather than emitting the timings downstream.

**Status:** upheld

### [BLOCK] party-security — The low-confidence alignment fallback produces guessed timings that are indistinguishable from measured ones downstream

**Quotes:**
> - **Alignment accuracy on technical jargon.** whisper.cpp may mis-segment `kubectl` or `useEffect`. Since we know the reference transcript, is constrained/forced alignment against it reliable enough, or do we need a fallback (proportional distribution across a phrase) when confidence is low?
> Output: `{ word, start, end }[]` per block. This single artifact drives captions, speech-synced motion, and SRT/VTT export.

**Problem:** The proposed fallback is exactly the guessed timing the Problem section says is unacceptable ("Guessed timings drift within seconds and read as broken"), reintroduced on the failure path. Because it emits the same `{ word, start, end }[]` shape with no confidence field and no marker, a block that fell back is byte-shape-identical to a block that aligned successfully: the render is green, the captions look plausible, the SRT ships to a platform, and no operator can tell which scenes are real and which are interpolated. This is the fail-open case where the failure looks identical to success, and it is worse here than a hard error because the artifact leaves the machine.

**Fix:** Decide the fallback question in favour of failing closed by default — a block below the confidence threshold errors and names the scene and phrase. If a proportional-distribution fallback is kept, it must be opt-in, must carry a per-word `estimated: true` flag through captions and SRT export, must emit a warning naming every affected block, and must be recorded in a run artifact so a shipped video's degraded scenes are recoverable after the fact.

**Status:** upheld

### [BLOCK] party-security — The TTS cache key omits the lexicon, so a pronunciation fix silently serves the old mispronounced audio forever

**Quotes:**
> Narration is synthesized per scene (or per narration block), keyed by a hash of `text + voice + speed + model version`, cached under `.claudevid/cache/tts/`. Editing one sentence re-synthesizes one block.
> **8. Pronunciation control.** A project lexicon mapping technical terms to phonemes or respellings (`kubectl`, `Nginx`, `PostgreSQL`, `TypeScript`, `npx`). Without it, a tech-explainer voiceover mispronounces its own subject matter, which is disqualifying for this library's exact use case.

**Problem:** The lexicon is an input that changes the synthesized audio, and it is absent from the enumerated cache key. The named workflow — a user hears `kubectl` mispronounced and adds a lexicon entry — changes no keyed input, so every already-cached block hits the cache and the fix appears to do nothing, with no warning and no way to distinguish a correct cache hit from a stale one. Head/tail padding and any other synthesis parameter have the same exposure. A cache that returns a stale artifact on a green run is the permissive default: it silently ships the exact defect the feature exists to prevent. Separately, the key is a hash of inputs but the artifact names no validation of the cached file itself, so a truncated or partially-written entry from an interrupted run is served as a hit.

**Fix:** Key on the full synthesis input closure — text, voice, speed, model version, model file digest, and a digest of the resolved lexicon entries actually applied to that block, plus any padding/normalization parameters. Write cache entries atomically (temp file plus rename) and store the length/digest alongside so a partial entry is detected as a miss rather than replayed as audio. Provide a documented cache-invalidation command and state the eviction policy for the unbounded `.claudevid/cache/tts/` directory.

**Status:** upheld

### [WARN] party-security — `duration: "auto"` has a stated floor but no ceiling, letting a measured or misaligned block drive unbounded timeline and render cost

**Quotes:**
> A scene carrying `narration` may declare `duration: "auto"`. The audio pipeline measures the synthesized block and supplies an `AudioDurations` map to change 001's `compileTimeline` (configurable head/tail padding, minimum duration).
> - final mux against change 005's silent video with `-c:v copy -c:a aac`

**Problem:** The design names a minimum duration and no maximum. A scene duration is therefore a function of an untrusted input length (spec narration text) and, if the aligner's output feeds it, of model output. A pathological or accidental narration block — a pasted document, a runaway generation, a timestamp past end-of-file — silently becomes a scene of arbitrary length that change 002 renders frame by frame and change 005 encodes, spending wall-clock and disk with no bound and no prompt. There is also no stated behaviour when total audio length and total video length disagree at mux time: `-c:v copy -c:a aac` with no length policy produces a mismatched file rather than an error.

**Fix:** Add a configurable per-scene and per-project maximum duration alongside the minimum; exceeding it errors and names the scene rather than clamping silently. At mux, assert the audio and video durations agree within a stated tolerance and fail with both numbers when they do not.

**Status:** upheld

### [WARN] party-security — The mux writes over change 005's expensive encode with no stated output destination or recovery path

**Quotes:**
> - final mux against change 005's silent video with `-c:v copy -c:a aac`
> - `packages/audio/src/mux.ts` — final mux into change 005's output

**Problem:** "into change 005's output" describes the only durable effect this change has on the filesystem, and the artifact never says whether the muxed file is a new path or a replacement of the silent encode. If it replaces it, a bad mux — wrong ducking, wrong loudnorm gain, fallback timings, a truncated audio track — destroys the one artifact that is expensive to regenerate (a 30-minute VideoToolbox encode), and the recovery path is a full re-render, not a re-mux. The proposal's own premise is that iteration must be cheap; this is the one step where a failure makes iteration maximally expensive, and no recovery is stated.

**Fix:** State that mux writes to a distinct output path and never modifies the silent encode in place; write to a temp file and rename only on FFmpeg exit code 0 so an interrupted or failed mux cannot leave a truncated file at the final path; refuse to overwrite an existing output unless explicitly forced.

**Status:** upheld

### [WARN] party-security — Download-on-first-use names an integrity check but no root of trust, and one resolution of the whisper.cpp question executes an arbitrary user-supplied binary

**Quotes:**
> - Model acquisition: download-on-first-use with integrity check and a documented cache location
> - **whisper.cpp acquisition.** Bundle a prebuilt binary, require the user to install it, or use a Node binding (`nodejs-whisper` / `smart-whisper`)? Affects install friction significantly.
> Download on first use with a progress bar and integrity check, or an explicit `claudevid models install` step?

**Problem:** "Integrity check" without a pinned digest and a pinned source is self-certifying: verifying a downloaded file against a hash fetched from the same host that served the file detects corruption, not substitution. The effect is a network fetch of hundreds of megabytes of ML weights, triggered implicitly by an ordinary render, into a shared user-level cache. Separately, the "require the user to install it" option resolves to invoking whichever `whisper` binary the ambient environment supplies — a PATH-resolved executable is a control-flow decision made by untrusted environment state, and a shared `~/.cache/claudevid/` model directory is writable by anything running as that user, so a swapped model file is loaded on the next run with no signal.

**Fix:** Pin each model to an explicit URL plus a digest committed in the repository, verify before first use and on every load from cache, and fail closed on mismatch rather than re-downloading. If an installed binary is used, resolve it from an explicit configured absolute path — not bare PATH lookup — and verify its version at startup. Grant the download step network access only during an explicit `claudevid models install`, so a render never reaches the network implicitly.

**Status:** upheld

### [WARN] party-security — "Cannot drift by construction" and the timing-drift test grade the alignment against itself

**Quotes:**
> - reads the same word timings, so captions cannot drift from the audio by construction
> - Tests: timing-drift assertion (captions vs audio), ducking level check, loudness target check, cache-hit behaviour on single-sentence edit

**Problem:** The claimed invariant is that captions and audio share one timing source, which guarantees only that captions match the aligner's belief about the audio — not the audio. If the aligner is wrong, the captions are wrong in perfect lockstep and the invariant still holds. The proposed timing-drift assertion inherits the same circularity: comparing captions against the word timings the captions were generated from is tautological and passes by construction, including on a block that fell back to proportional distribution. The mechanism that could detect misalignment is the same mechanism being graded, and it always reports success.

**Fix:** Make the drift test independent of the aligner: for a fixture with known ground-truth word boundaries (or a silence-padded synthetic utterance whose boundaries are measurable from the waveform), assert the aligner's timings land within a stated tolerance of the measured boundaries, and assert the test fails when a deliberately perturbed alignment is injected. Drop the "by construction" claim from the design's guarantees; it is a statement about a shared variable, not about correctness.

**Status:** upheld
