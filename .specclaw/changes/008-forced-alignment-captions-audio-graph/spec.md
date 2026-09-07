# Spec: Forced-Aligned Captions, Speech-Synced Motion & Audio Graph

**Change:** 008-forced-alignment-captions-audio-graph
**Created:** 2026-09-07
**Status:** 🟡 Draft

## Overview

Adds word-level forced alignment (via `@huggingface/transformers`'s ASR pipeline — the same
runtime as 006's Kokoro synthesis, not a second native stack), a `captions` layer as its own
package (`packages/layer-captions`, following `packages/layer-code`'s existing registration
pattern — verified against `packages/core/src/layers.ts`'s `registerLayer` and
`packages/renderer-canvas/src/painters.ts`'s `registerPainter`), an argv-safe FFmpeg audio graph
and mux (following `packages/encoder-ffmpeg`'s `argv.ts`/`probe.ts` pattern), SRT/VTT export, and
a pronunciation lexicon feeding into 006's synthesis cache key.

Grounding: `packages/audio` (006) already depends on `@huggingface/transformers` directly
(`packages/audio/package.json`) and already routes its cache directory through
`resolveCacheSubdir` (`packages/audio/src/cache-root.ts`) — this change reuses both rather than
introducing a second dependency or a second cache root.

## Requirements

### Functional Requirements

- **FR1** — `packages/audio/src/align.ts` exposes `align(request: AlignRequest):
  Promise<WordTiming[]>` where `AlignRequest = { audio: Buffer; sampleRate: number;
  referenceText: string }`. Production implementation runs `@huggingface/transformers`'s
  `automatic-speech-recognition` pipeline (Whisper, `return_timestamps: 'word'`) over `audio`.
  The function itself is the injection seam (mirrors 006's `synthesize()`): callers accept an
  injected `align`-shaped function so every test except the gated live-model integration test
  substitutes a fixture.
- **FR2** — A **reconciliation step** inside `align.ts` aligns the ASR pipeline's raw recognized
  word stream against `referenceText`'s tokenization (edit-distance alignment — see design.md for
  the concrete algorithm) before any timing is returned. The raw ASR output never reaches a
  caller unreconciled.
- **FR3** — Reconciled output is validated before `align()` returns: every reference word has a
  timing entry; `start`/`end` are monotonic non-decreasing across the sequence, non-negative, and
  bounded by the audio's measured duration (`audio.length / 2 / sampleRate`, matching 006's
  format). Any violation throws, naming the block and the specific check that failed.
- **FR4** — Low-confidence spans fail closed by default: if reconciliation cannot map a
  contiguous run of reference words with acceptable confidence, `align()` throws by default. An
  explicit opt-in mode (`allowEstimated: true` in `AlignRequest`) enables a proportional-
  distribution fallback across the low-confidence span; every word produced this way carries
  `estimated: true` and the call collects every affected span into a `estimatedSpans` field
  returned alongside the timings (not silently mixed in).
- **FR5** — `WordTiming = { word: string; start: number; end: number; estimated: boolean;
  confidence?: number }`. `start`/`end` are **block-relative** (documented at the type). `word`
  is always `referenceText`'s surface form (pre-lexicon-substitution), never the ASR pipeline's
  own recognized spelling. Punctuation is not a separate entry.
- **FR6** — `packages/layer-captions` (new package) registers a `captions` layer schema via
  core's `registerLayer("captions", ...)` and a painter via renderer-canvas's
  `registerPainter("captions", ...)`, following `packages/layer-code`'s existing structure
  exactly (verified: `packages/layer-code/src/schema.ts`'s `registerLayer` call and
  `packages/layer-code/src/index.ts`'s `registerPainter` call are the precedent). One style
  shipped: karaoke highlight (active word emphasized via a `packages/motion` track — no
  captions-specific motion code, since animation is generic across layer types per
  `packages/core/src/layers.ts`'s `baseLayerShape`).
- **FR7** — `packages/audio/src/graph.ts` builds an FFmpeg filter graph using argv-array
  construction only (mirrors `packages/encoder-ffmpeg/src/argv.ts`): every media file (voiceover,
  music, SFX) is a separate `-i` input; the filter graph references inputs by index; every
  numeric parameter (gain, fade duration, loop count) is validated against an explicit range
  before formatting into the graph string, rejecting out-of-range values rather than clamping.
  Sidechain ducking (`sidechaincompress`) and loudness normalization (`loudnorm`, −14 LUFS)
  are graph stages built the same way. Resolves the FFmpeg binary via `packages/encoder-ffmpeg`'s
  `probe()` (no second binary-resolution implementation).
- **FR8** — `packages/audio/src/mux.ts` writes the muxed output to a distinct path (never
  overwrites 005's silent encode in place); writes to a temp file, renames only on FFmpeg exit
  code 0; refuses to overwrite an existing output unless explicitly forced; asserts audio/video
  duration agreement within a stated tolerance, failing with both numbers on mismatch.
- **FR9** — `packages/audio/src/export.ts` generates SRT and VTT from a `WordTiming[]`, including
  the `estimated` marker per entry (or per affected span) so a shipped subtitle file can be
  inspected for degraded scenes.
- **FR10** — `packages/audio/src/lexicon.ts` exposes a project pronunciation lexicon (term →
  phoneme/respelling). Its resolved digest becomes a field of 006's `SynthesisRequest` (extending
  the type — the cache key already covers "the full resolved request object" per 006's design.md
  D1, so this requires no `cache.ts` change).

### Non-Functional Requirements

- **NFR1** — `packages/audio` gains no new native-runtime dependency for alignment — ASR uses the
  same `@huggingface/transformers`/`onnxruntime-node` stack already present for 006's synthesis.
- **NFR2** — Every test except the gated live-model integration test runs with zero real ASR
  inference, via the `align()` seam (FR1).
- **NFR3** — `packages/layer-captions` has no dependency cycle: it depends on `@claudevid/core`,
  `@claudevid/renderer-canvas`, `@claudevid/motion`, and `@claudevid/audio` (for the `WordTiming`
  type only); none of those packages depends back on `layer-captions` (verified pattern:
  `packages/layer-code` has the same one-directional shape today).

## Acceptance Criteria

- **AC1** — Reconciliation correctly maps a clean recognized stream (no drops/insertions) against
  its reference transcript, producing one `WordTiming` per reference word.
- **AC2** — A recognized stream with a dropped word, an inserted word, and a reordered pair (3
  separate fixture cases) each still produce a timing entry for every reference word (FR3's
  completeness guarantee), or the affected span is marked `estimated: true` under
  `allowEstimated`.
- **AC3** — Non-monotonic, negative, or past-audio-length timestamps from a fixture aligner are
  rejected — `align()` throws naming the violated check (FR3).
- **AC4** — With `allowEstimated: false` (default), a fixture simulating a low-confidence span
  causes `align()` to throw. With `allowEstimated: true`, it returns timings for that span with
  every word in it marked `estimated: true` and included in `estimatedSpans`.
- **AC5** — A `VideoSpec` scene with a `captions` layer parses via core's schema (registered by
  `layer-captions`) and renders via `renderer-canvas` without importing `layer-captions` directly
  in either package (structural check: `packages/core` and `packages/renderer-canvas`'s own
  `package.json` files list no dependency on `layer-captions`).
- **AC6** — `graph.ts`'s argv builder rejects a gain value outside its declared range and a music
  file path is passed as a separate `-i` argv element, never concatenated into the filter-graph
  string (structural test: assert the constructed argv array contains the path as a whole
  element, and assert the filter-graph string itself contains no raw file path).
- **AC7** — Ducking test: with a fixture audio pair (voice + music), the graph's `loudnorm`+
  `sidechaincompress` stages reduce music level under speech by at least a stated dB threshold
  (measured via a synthetic level check, not a subjective listen).
- **AC8** — `mux.ts` writes to a distinct output path; a forced non-zero FFmpeg exit leaves no
  file at the final path (temp+rename only on success); a duration mismatch beyond the stated
  tolerance throws naming both durations.
- **AC9** — SRT/VTT export from a `WordTiming[]` with one `estimated: true` span produces sidecar
  files that mark that span distinctly from measured timings.
- **AC10** — Adding a lexicon entry changes 006's `SynthesisRequest`'s resolved digest field,
  producing a cache miss on the next synthesis of affected text (verified against 006's existing
  cache-key mechanism, no new cache code).
- **AC11** *(gated integration tier, real model)* — `align()` with the real ASR pipeline produces
  non-empty word timings for a short synthesized sample sentence.
- **AC12** — `pnpm -r run build`, `pnpm -r run test`, `pnpm -r run lint` all pass from a clean
  checkout; 001–006's existing suites unaffected.

## Edge Cases

- Reconciliation cannot map any words in a block (total ASR failure) — treated as the whole block
  being low-confidence; FR4's fail-closed/opt-in-estimated behavior applies to the entire block.
- A `WordTiming`'s block-relative offset must be applied by exactly one caller (the code that
  already knows the scene's compiled start frame from 006's `AudioDurations`/core's
  `compileTimeline`) — `align.ts`/`layer-captions` never independently recompute a timeline
  offset.
- Lexicon entry covers a word that never appears in a given scene's narration — no-op for that
  scene, does not affect its cache key (only the digest of *applied* entries changes the key,
  per 006's design.md D1 "full resolved request object").
- FFmpeg reports success (exit 0) but the muxed output's duration doesn't match the video's —
  FR8's tolerance check still fails this explicitly rather than trusting the exit code alone.

## Dependencies

- 006-tts-voiceover-captions (`SynthesisRequest`, cache, `resolveCacheSubdir`, `@huggingface/
  transformers` already a direct dependency).
- 001-videospec-core (`registerLayer`, base layer types).
- 002-canvas-render-engine (`registerPainter`, layout/paint dispatch).
- 003-motion-system (generic animation tracks, consumed by `layer-captions` for emphasis).
- 005-videotoolbox-encoder (`probe()` for FFmpeg binary resolution, silent video to mux into).

## Notes

- Whisper model size (base vs. small) is a design.md decision, not fixed here — same pinning
  treatment as 006's Kokoro model (single source of truth, shared cache root, no new acquisition
  mechanism).
- Per-block alignment wall-clock cost is measured during design/build (indicative bench,
  following 005/006's precedent), not asserted here.
- Phrase-block and classic-bottom-third caption styles, cloud providers, voice cloning,
  multi-speaker dialogue, music generation, and real-time/streaming are explicitly out of scope
  (see proposal.md).
- **Known limitation (found in verify-report.md):** `layer-captions`'s painter converts frame
  number to seconds via a hardcoded `DEFAULT_FPS = 30` constant, inherited from `layer-code`'s
  identical pre-existing pattern (`PainterFn` carries no `fps`; `TimelineLayer` doesn't either).
  On a `VideoSpec` with `fps !== 30`, captions desync from audio proportionally
  (`actualFps/30`×). Not fixed here — threading real `fps` through `PainterFn` is a cross-cutting
  change affecting `layer-code` too, out of this change's scope. Tracked as a follow-on for
  whichever change next touches `PainterFn`'s signature.
