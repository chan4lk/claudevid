# Proposal: Forced-Aligned Captions, Speech-Synced Motion & Audio Graph

**Created:** 2026-09-07
**Status:** 🟡 Draft

**Depends on:** 006-tts-voiceover-captions (Kokoro synthesis, content-hash cache keyed on the
full resolved `SynthesisRequest`, `AudioDurations` feeding core's already-shipped
`compileTimeline` seam), 001-videospec-core, 002-canvas-render-engine (layer rendering, owns
this change's captions layout/draw), 003-motion-system (word-emphasis tracks), 005-videotoolbox-
encoder (silent video to mux into, and its `argv.ts`/`probe.ts` pattern for FFmpeg invocation —
reused here rather than re-invented).

## Origin

Split out of the original 006 proposal (`.specclaw/changes/006-tts-voiceover-captions/party-
report.md`) per party-po's recommendation to separate the duration-feedback value (shipped in
006) from the alignment-dependent value (captions, speech-synced motion, SRT/VTT) into its own
increment, since the latter is the riskier, less-settled half: two native ML runtimes stacked,
an untrusted model output steering timeline compilation, and a filter-graph construction problem.
This proposal exists to resolve those specifically, not to re-litigate 006's scope.

## Problem

Kokoro (006) produces audio, not word-level timings. Without timings:

- **Captions cannot exist** with per-word start/end times — guessed timings drift and read as
  broken.
- **Motion cannot sync to speech** — the effective explainer beat (a bullet or code line
  appearing exactly as it's named) needs to know when the word is spoken.
- **No SRT/VTT** can be generated for platform upload.

A flat-level music bed under narration is unintelligible, and inconsistent loudness across a
batch of videos reads as unprofessional next to each other.

## Proposed Solution

**1. Forced alignment via whisper.cpp, with a named reconciliation step — not "accuracy is high."**

The original proposal asserted forced alignment against a known transcript is inherently
accurate; party-architect and party-ba both showed this contradicts the fact that whisper.cpp is
an open transcriber (it can drop, insert, or reorder tokens relative to the reference), and the
original proposal's own Open Questions conceded this for exactly the jargon this library exists
to narrate (`kubectl`, `useEffect`). This proposal makes the reconciliation step an explicit,
scoped component:

- `align.ts` runs whisper.cpp over the synthesized audio to get a raw recognized token stream
  with timestamps.
- A **reconciliation function** aligns the recognized stream to the known reference transcript
  (edit-distance / DTW-style alignment between two known token sequences — a bounded, testable
  problem, unlike open ASR).
- **The aligner's output is treated as untrusted and validated before it leaves `align.ts`**: the
  reconciled word sequence must match the reference transcript token-for-token after
  normalization; timestamps must be monotonic, non-negative, non-overlapping, and bounded by the
  measured audio length. Any violation fails that block loudly, naming the scene and phrase —
  never emitted downstream silently.
- **Fail-closed by default** on low-confidence spans: a block below threshold errors rather than
  falling back to a guess. An **opt-in** `--allow-estimated-timing` mode may enable a
  proportional-distribution fallback, but every word produced that way carries `estimated: true`
  through captions, motion, and SRT/VTT, is logged in a run artifact naming every affected block,
  and never masquerades as a measured timing. This directly resolves party-security's BLOCK that
  the original fallback was shape-identical to real output.

**2. Word-timing artifact with reserved provenance fields.**
`{ word: string; start: number; end: number; estimated: boolean; confidence?: number }[]`, plus
an explicit, documented convention: `start`/`end` are **block-relative**, and applying the
block's timeline offset (from 006's `AudioDurations`-derived scene window) is the caller's job,
done in exactly one place (`durations.ts` in 006 already knows the scene's start frame — this
package's mux/captions code reads that, not a second offset calculation). `word` is always the
reference-transcript surface form (pre-lexicon-substitution) so a caption renders `kubectl`, not
a phonetic respelling. Punctuation is not a separate word entry. A `segments?: {start,end}[]`
field groups words into phrase-level cues for the phrase-block caption style.

**3. Captions live in the render package, not here.**
The original proposal put captions' schema/layout/styles inside `packages/audio`, which
party-architect flagged as a BLOCK (the render package would have to depend on the audio
package, or the schema would be duplicated) and party-visionary flagged as a precedent problem
for the named audio-reactive-motion follow-on. Fix, per both:

- The `captions` layer **schema** lives in `packages/core` alongside every other layer schema.
- **Layout, styles, and drawing** live in `packages/renderer-canvas` (change 002's package),
  which is the only package that already knows how to lay out and paint a layer.
- **Active-word emphasis** is a `packages/motion` (003) track, same as every other animated
  property.
- `packages/audio` (this change) owns exactly one thing relevant to captions: producing the
  word-timing artifact (item 2) and, if needed, grouping it into cue segments. It has no caption
  rendering code and no dependency on `renderer-canvas`.
- Caption styles shipped in v1: **one** — karaoke highlight (active word emphasized), since
  that's the style the Problem section's speech-sync beat actually needs. Phrase-block and
  classic bottom-third are cut pending a named scene that needs them (party-po WARN: the original
  four-style surface had no stated value beyond "nice to have configurable").

**4. Audio graph and mux, argv-built, reusing 005's invocation pattern.**
The original proposal's filter-graph construction concatenated spec-supplied file paths and
per-track gain/fade numbers into an FFmpeg filter string — party-security's BLOCK, since
filtergraph syntax is delimiter-sensitive and supports source filters that read arbitrary files.
Fix, following the pattern already proven in `packages/encoder-ffmpeg/src/argv.ts` (005's "sole
owner of the complete FFmpeg argv" module, pure, no string concatenation from untrusted input):

- Every media file (voiceover, music, SFX) is passed as a separate `-i` input — file paths are
  argv elements, never substrings inside a filter graph.
- The filter graph references inputs only by index (`[0:a]`, `[1:a]`, ...).
- Every numeric parameter (gain, fade duration, loop count) is validated against an explicit
  range before being formatted into the graph string; out-of-range values are rejected, not
  clamped silently.
- Every track path is resolved to a real file under the project root or an explicitly configured
  asset root before FFmpeg is invoked.
- This package reuses `packages/encoder-ffmpeg`'s `probe.ts` (ffmpeg binary resolution) rather
  than resolving the binary a second way — resolves party-architect's NOTE that two packages
  independently invoking FFmpeg is one owner's worth of logic implemented twice.
- **Sidechain ducking** (`sidechaincompress`) and **loudness normalization** (`loudnorm`,
  targeting −14 LUFS) are graph stages, built the same argv-safe way.
- **Mux output**: writes to a distinct output path, never overwrites 005's silent encode in
  place. Writes to a temp file, renames only on FFmpeg exit code 0. Refuses to overwrite an
  existing output unless explicitly forced. At mux, asserts audio and video durations agree
  within a stated tolerance; fails with both numbers on mismatch. Resolves party-security's WARN
  that a bad mux could destroy the one artifact expensive to regenerate.

**5. Sidecar exports.** SRT and VTT generated from the same word-timing artifact (item 2),
including the `estimated` marker so a shipped caption/subtitle file can be inspected for
degraded scenes after the fact.

**6. Pronunciation lexicon.** Project lexicon mapping technical terms to phonemes/respellings.
Its resolved digest becomes part of 006's `SynthesisRequest` (006's cache key already covers
"the full resolved request object," so adding this field here requires no cache-scheme
migration — this was the point of that design in 006).

**7. Deterministic test seam.** `align.ts` exposes an injectable alignment interface
(`align(audio, referenceTranscript): Promise<WordTiming[]>`) the same way 006's `tts.ts` exposes
`synthesize()` — so cache/graph/captions/export logic is tested against fixtures, and the
real-whisper.cpp path is a separately-gated integration tier. The timing-drift test is built
against an **independent ground truth** (a fixture with known word boundaries, or a silence-
padded synthetic utterance whose boundaries are measurable from the waveform) with a stated
tolerance, and includes a case that must fail when a deliberately perturbed alignment is
injected — resolving party-security's WARN that "captions cannot drift by construction" only
proves captions match the aligner's belief, not the audio, and that an ungrounded drift test
passes by construction even on a fallback block.

## Scope

### In Scope

- `packages/audio/src/align.ts` — whisper.cpp invocation + reconciliation against reference
  transcript + validation (monotonic/bounded/token-match) + fail-closed default +
  opt-in-estimated fallback with `estimated: true` marking
- `packages/audio/src/word-timing-types.ts` — the shared word-timing type (item 2), block-
  relative-offset convention documented at the type
- `packages/core`: `captions` layer schema
- `packages/renderer-canvas`: captions layout + karaoke-highlight draw
- `packages/motion`: active-word emphasis track
- `packages/audio/src/graph.ts` — argv-safe FFmpeg filter graph: per-track gain/fade/trim/loop,
  sidechain ducking, loudnorm; reuses `encoder-ffmpeg`'s `probe.ts`
- `packages/audio/src/mux.ts` — distinct-output-path mux, temp+rename, duration-tolerance check
- `packages/audio/src/export.ts` — SRT/VTT from the word-timing artifact
- `packages/audio/src/lexicon.ts` — pronunciation overrides, digest feeds 006's cache key
- Tests: reconciliation-validation tests (token mismatch, non-monotonic timestamp, out-of-bound
  timestamp all rejected), grounded timing-drift test with independent fixture + perturbation
  case, ducking-level and loudness-target checks with stated thresholds, mux duration-tolerance
  test, argv-construction tests proving no string concatenation of spec-supplied values

### Out of Scope

- Cloud TTS providers (unchanged from 006)
- Voice cloning, custom voice training, multi-speaker dialogue/character voices
- Music generation (bring your own track)
- Real-time/streaming synthesis or alignment
- Audio-reactive (waveform-driven) motion — natural follow-on once this ships; per party-
  visionary's NOTE, the next author should copy this change's layer-placement rule (schema in
  core, layout in the renderer, package-specific data production only), not the original
  proposal's placement
- Phrase-block and classic-bottom-third caption styles (cut to karaoke-highlight only; add when
  a scene demonstrably needs them)

## Impact

- **Files affected:** ~14 new + 3 packages touched for the captions schema/layout/emphasis split
- **Complexity:** large
- **Risk:** medium-high — whisper.cpp (Metal-accelerated on Apple Silicon) alongside 006's
  onnxruntime-node, model download/build variance, and this change is where an untrusted model
  output (alignment) is allowed to steer timeline-adjacent behavior — mitigated by the
  validate-before-use and fail-closed decisions above, but the risk class itself (not just this
  change's handling of it) is real and should be re-checked in design.md against whatever
  whisper.cpp build is actually pinned.

## Open Questions

- **whisper.cpp acquisition.** Bundle a prebuilt binary, require user install, or a Node binding
  (`nodejs-whisper` / `smart-whisper`)? If "require user install," resolve the binary from an
  explicit configured absolute path — never a bare PATH lookup — and verify its version at
  startup, per party-security's WARN about ambient-PATH execution of an arbitrary binary.
- **Reconciliation algorithm choice.** Edit-distance alignment vs. DTW vs. a library — needs a
  concrete pick in design.md with a stated behavior for the case where reconciliation itself
  can't produce a confident mapping for a whole block (this is the trigger for the fail-closed
  path in item 1).
- **Per-block wall-clock cost for alignment specifically** (separate from 006's synthesis cost,
  since whisper.cpp reruns even on a synthesis cache hit unless the cache — per 006's design —
  stores the timing artifact once alignment exists, which is exactly what 006's cache-entry
  shape was built to allow without a second migration).
- **Licensing** for the pinned whisper.cpp model, same review as 006's Kokoro model.

---

**To proceed:** Review this proposal and approve to begin planning.
