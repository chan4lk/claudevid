# Proposal: Local TTS Voiceover, Forced-Aligned Captions & Audio Mux

**Created:** 2026-09-06
**Status:** 🟡 Draft

**Depends on:** 001-videospec-core (`audio` block, `duration: "auto"`), 002-canvas-render-engine
(caption text rendering), 003-motion-system (word emphasis tracks), 005-videotoolbox-encoder
(silent video to mux into).

## Problem

The requirement doc treats audio as the last thing that happens:

> ### Phase 5: Audio
> `ffmpeg -i video.mp4 -i voiceover.mp3 -c:v copy -c:a aac -shortest final.mp4`

That is the wrong seam, for a reason that only becomes obvious once you try to make a real
explainer video: **a Claude-generated video has no `voiceover.mp3`. It has a script.** And the
visuals must follow the narration, not the other way round.

Concretely, four things are broken by muxing at the end:

1. **Scene durations are guesses.** Claude writes a scene with three sentences of narration and
   assigns `duration: 4`. The narration actually takes 7.2 seconds. The scene cuts mid-sentence.
   Every scene in a 30-minute video has this problem independently, and there is no way to fix it
   by hand at 360 scenes.
2. **Captions cannot exist.** The doc's Phase 4 caption format requires per-word start/end times:
   `{ "text": "This", "start": 0.0, "end": 0.2 }`. It then says *"Claude can generate caption
   timing from a transcript"* — Claude cannot. It has no idea how long a synthesized voice takes
   to say "kubectl". Guessed timings drift within seconds and read as broken.
3. **Motion cannot sync to speech.** The most effective explainer beat is a bullet or code line
   appearing exactly as it is named. That requires knowing when the word is spoken.
4. **Iteration is ruinous.** Fixing one sentence in scene 3 re-synthesizes 30 minutes of audio.

Meanwhile music sitting at a flat level under a voice makes the voice unintelligible, and
inconsistent loudness across a batch of videos is immediately noticeable to anyone watching two
of them in a row.

## Proposed Solution

Build `@claudevid/audio` — a **TTS-first** pipeline that runs *before* the timeline is finalized,
fully offline on Apple Silicon.

**1. Local synthesis with Kokoro.**
`kokoro-js` on `onnxruntime-node` (CoreML/Metal execution provider on M3 where available).
Chosen for: fully offline (no API key, no rate limit, no per-render cost — which matters
enormously for batch generation), MIT-licensed, fast enough on M3 for real-time-plus synthesis,
and good enough quality for technical narration. Voice selection, speed and pitch are exposed
per-spec and per-scene.

**2. Per-block synthesis with content-hash caching.**
Narration is synthesized per scene (or per narration block), keyed by a hash of
`text + voice + speed + model version`, cached under `.claudevid/cache/tts/`. Editing one
sentence re-synthesizes one block. This mirrors change 005's chunk resume and is what makes the
edit loop survivable.

**3. Word-level timings via forced alignment — the piece that unlocks everything.**
Kokoro produces audio, not timings. We run **whisper.cpp** (Metal-accelerated on M3) over the
*generated* audio to get word-level timestamps. Aligning against synthetic speech with a known
reference transcript is a far easier problem than open transcription, so accuracy is high.

Output: `{ word, start, end }[]` per block. This single artifact drives captions, speech-synced
motion, and SRT/VTT export.

**4. Duration feedback into the timeline.**
A scene carrying `narration` may declare `duration: "auto"`. The audio pipeline measures the
synthesized block and supplies an `AudioDurations` map to change 001's `compileTimeline`
(configurable head/tail padding, minimum duration). Order of operations becomes:

```
spec → synthesize narration → measure + align → compile timeline → render → encode → mux
```

This is why audio is a *pipeline stage*, not a post-processing step, and it is the change that
makes long-form output actually watchable.

**5. Captions layer.**
A `captions` layer registered into core, rendered by change 002, animated by change 003:

- styles: word-by-word pop, phrase blocks, karaoke highlight (active word emphasized), classic
  bottom-third
- safe-area aware, with a distinct centred/burned style for vertical shorts
- active-word emphasis (scale/colour) driven by change 003 tracks, so it composes with everything else
- reads the same word timings, so captions cannot drift from the audio by construction

**6. Audio graph and mux.**
Voiceover + background music + SFX composed through **one FFmpeg filter graph**:

- per-track gain, fade in/out, trim, loop-to-length for music
- **sidechain ducking** (`sidechaincompress`) so music drops under speech automatically — the
  difference between "has music" and "sounds produced"
- **loudness normalization** (`loudnorm`, targeting −14 LUFS for YouTube) so every video in a
  batch lands at the same perceived level
- final mux against change 005's silent video with `-c:v copy -c:a aac`

**7. Sidecar exports.** SRT and VTT generated from the same word timings, for platform upload.

**8. Pronunciation control.** A project lexicon mapping technical terms to phonemes or respellings
(`kubectl`, `Nginx`, `PostgreSQL`, `TypeScript`, `npx`). Without it, a tech-explainer voiceover
mispronounces its own subject matter, which is disqualifying for this library's exact use case.

## Scope

### In Scope

- `packages/audio/src/tts.ts` — Kokoro synthesis, voice/speed config, ONNX session lifecycle
- `packages/audio/src/cache.ts` — content-hash TTS cache
- `packages/audio/src/align.ts` — whisper.cpp forced alignment → word timings
- `packages/audio/src/lexicon.ts` — pronunciation overrides for technical terms
- `packages/audio/src/durations.ts` — `AudioDurations` map feeding `compileTimeline`
- `packages/audio/src/graph.ts` — FFmpeg filter graph: gain, fades, ducking, loudnorm
- `packages/audio/src/mux.ts` — final mux into change 005's output
- `packages/audio/src/captions/` — captions layer schema, layout, styles, word emphasis
- `packages/audio/src/export.ts` — SRT / VTT sidecars
- Model acquisition: download-on-first-use with integrity check and a documented cache location
- Tests: timing-drift assertion (captions vs audio), ducking level check, loudness target check,
  cache-hit behaviour on single-sentence edit

### Out of Scope

- **Cloud TTS providers and a `TtsProvider` abstraction** — explicitly deferred. v1 is
  local-Kokoro-only. (See Open Questions for the exit path.)
- Voice cloning, custom voice training
- Multi-speaker dialogue / character voices
- Music generation (bring your own track)
- Real-time or streaming synthesis
- Audio-reactive motion (waveform-driven animation) — a natural follow-on once timings exist
- Video encoding itself — change 005

## Impact

- **Files affected:** ~20 new
- **Complexity:** large
- **Risk:** medium-high — two native ML runtimes (onnxruntime-node, whisper.cpp) with model
  downloads and Apple Silicon build variance, plus a genuine cross-change coupling into 001's
  timeline compilation.

## Open Questions

- **Model distribution and disk footprint.** Kokoro ONNX (~80–350 MB depending on quantization)
  plus a whisper model (~75 MB for base, more for higher accuracy). Download on first use with a
  progress bar and integrity check, or an explicit `claudevid models install` step? Total
  footprint and where it lives (`~/.cache/claudevid/`?) needs deciding before anyone ships this
  in CI.
- **Does `duration: "auto"` land in core v1?** This is the same question raised in change 001,
  and it must be answered the same way in both. **Recommendation: yes, with an optional
  `AudioDurations` argument**, so core stays I/O-free and 006 does not force a schema break.
- **Alignment accuracy on technical jargon.** whisper.cpp may mis-segment `kubectl` or
  `useEffect`. Since we know the reference transcript, is constrained/forced alignment against it
  reliable enough, or do we need a fallback (proportional distribution across a phrase) when
  confidence is low?
- **Cloud providers later.** We are shipping local-only by explicit choice. If ElevenLabs-grade
  voice is wanted in six months, does the `synthesize()` signature we write now accommodate a
  provider that *returns its own word timings* (skipping alignment entirely)? Worth shaping the
  return type for that even while shipping one implementation.
- **whisper.cpp acquisition.** Bundle a prebuilt binary, require the user to install it, or use a
  Node binding (`nodejs-whisper` / `smart-whisper`)? Affects install friction significantly.
- **Where does narration live in the schema?** `scene.narration: string`, or a `voiceover` layer,
  or a top-level script array indexed to scenes? The first is simplest for Claude to emit
  correctly; the third makes a script reviewable as prose before any render.
- **Licensing.** Kokoro's model weights and voice packs need a licence review before this ships
  in a public package.

### Panel findings (adversarial review, round 2 — all upheld)

_Appended by the party panel. Verdict: CHANGES_REQUESTED (advisory; `party.block: false`)._

- **[BLOCK]** (party-architect) Captions layer placed in `packages/audio` while its schema, rendering and animation are owned by three other packages — see party-report.md
- **[BLOCK]** (party-architect) Second content-hash cache alongside the change-005 mechanism the proposal names — see party-report.md
- **[BLOCK]** (party-architect) Co-change to `compileTimeline`'s signature and all its existing callers is unnamed — see party-report.md
- **[BLOCK]** (party-architect) Forced alignment described as a constrained problem but built on an unconstrained transcriber — see party-report.md
- **[WARN]** (party-architect) The word-timing artifact is the shared contract of four consumers and is specified only as `{ word, start, end }[]` — see party-report.md
- **[WARN]** (party-architect) No deterministic test seam for tests that all depend on two native ML runtimes — see party-report.md
- **[NOTE]** (party-architect) FFmpeg is invoked from two packages with no stated shared invocation layer — see party-report.md
- **[BLOCK]** (party-ba) The proposal's own text contradicts the accuracy claim that "captions cannot exist" rests on — see party-report.md
- **[WARN]** (party-ba) Scale figures used to justify "large"/"medium-high" scope are asserted, not sourced — see party-report.md
- **[WARN]** (party-ba) Test descriptions have no failure threshold, so the proposal's headline claims are unfalsifiable at ship time — see party-report.md
- **[NOTE]** (party-ba) "block" is used for two different granularities that determine what the cache actually re-synthesizes — see party-report.md
- **[WARN]** (party-po) Duration-fix and caption/motion-sync value are bundled into one large, dual-native-runtime change with no staged variant considered — see party-report.md
- **[WARN]** (party-po) Per-render wall-clock cost of the pipeline is never quantified — see party-report.md
- **[WARN]** (party-po) Configuration surface (per-scene voice/speed/pitch, four caption styles, configurable padding) is added with no value attached to the granularity itself — see party-report.md
- **[NOTE]** (party-po) SRT/VTT export and the lexicon are cheap add-ons riding on the alignment artifact and could be named as an explicit late cut line — see party-report.md
- **[BLOCK]** (party-security) Spec-supplied audio paths and track parameters are concatenated into one FFmpeg filter graph with no stated escaping — see party-report.md
- **[BLOCK]** (party-security) Model output (whisper.cpp timestamps) is trusted as ground truth for timeline compilation with no validation against the known reference transcript — see party-report.md
- **[BLOCK]** (party-security) The low-confidence alignment fallback produces guessed timings that are indistinguishable from measured ones downstream — see party-report.md
- **[BLOCK]** (party-security) The TTS cache key omits the lexicon, so a pronunciation fix silently serves the old mispronounced audio forever — see party-report.md
- **[WARN]** (party-security) `duration: "auto"` has a stated floor but no ceiling, letting a measured or misaligned block drive unbounded timeline and render cost — see party-report.md
- **[WARN]** (party-security) The mux writes over change 005's expensive encode with no stated output destination or recovery path — see party-report.md
- **[WARN]** (party-security) Download-on-first-use names an integrity check but no root of trust, and one resolution of the whisper.cpp question executes an arbitrary user-supplied binary — see party-report.md
- **[WARN]** (party-security) "Cannot drift by construction" and the timing-drift test grade the alignment against itself — see party-report.md
- **[WARN]** (party-security) Rebuttal to party-visionary: an unmarked words-per-minute estimate for `auto` when `AudioDurations` is absent is the fail-open path, not a free preview — see party-report.md
- **[WARN]** (party-visionary) The cache key is a hand-maintained list of "everything that changes the waveform", and the proposal already names two inputs it omits — see party-report.md
- **[WARN]** (party-visionary) `duration: "auto"` makes the visual timeline a function of an unpinned model download, so a model upgrade silently changes every existing video's cut points — see party-report.md
- **[WARN]** (party-visionary) Narration as a bare string plus multi-speaker out of scope closes the schema door the out-of-scope item would need — see party-report.md
- **[WARN]** (party-visionary) The word-timings artifact is frozen by three consumers on merge day, and the proposal already names a case where consumers need provenance it does not carry — see party-report.md
- **[NOTE]** (party-visionary) Putting the `captions` layer inside `packages/audio` teaches that a layer lives where its data comes from, and the named follow-on will copy it — see party-report.md
- **[NOTE]** (party-visionary) The optional `AudioDurations` seam is one step short of letting the timeline compile without models at all — see party-report.md
- **[NOTE]** (party-visionary) The cache stores the audio but not the timings or measured duration it was created to produce, so alignment is paid on every run the cache was meant to make free — see party-report.md

---

**To proceed:** Review this proposal and approve to begin planning.
