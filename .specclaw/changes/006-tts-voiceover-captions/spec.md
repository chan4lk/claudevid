# Spec: Local TTS Voiceover & Duration Feedback (Kokoro synthesis only)

**Change:** 006-tts-voiceover-captions
**Created:** 2026-09-07
**Status:** 🟡 Draft

## Overview

New package `@claudevid/audio` (`packages/audio`). Synthesizes narration audio locally via
Kokoro (`kokoro-js` on `onnxruntime-node`), caches synthesized blocks content-addressably, and
measures each block's duration to feed core's already-shipped `duration: "auto"` /
`CompileTimelineOptions.audioDurations` seam (`packages/core/src/timeline.ts`,
`resolveSceneDurationSeconds`, `MissingAudioDurationError` — verified present on disk, no
core-side code change required).

This is the smaller, lower-risk half of the original 006 proposal
(`.specclaw/changes/006-tts-voiceover-captions/proposal.md` — see "Why this is split"). Forced
alignment, captions, speech-synced motion, the audio graph/mux, SRT/VTT, and the lexicon are
change 008, which depends on this one.

## Requirements

### Functional Requirements

- **FR1** — `packages/core`'s `scene.narration` field accepts either a bare string (shorthand)
  or a structured `NarrationBlock` (`{ text: string; voice?: string; speed?: number }`) or an
  array of `NarrationBlock`. A bare string normalizes to a single-item array of
  `{ text: <string> }`. This is the only core-side schema change in this increment.
- **FR2** — `synthesize(request: SynthesisRequest): Promise<{ audio: Buffer; sampleRate: number
  }>` in `packages/audio/src/tts.ts`, backed by Kokoro/onnxruntime-node in production. The
  function signature is the injection seam: tests supply a fake implementation, no real model
  required for anything except the one gated integration test (AC9).
- **FR3** — `SynthesisRequest` (`packages/audio/src/types.ts`) is `{ text: string; voice:
  string; speed: number; modelId: string; modelDigest: string }` — every field that changes the
  waveform in this increment, resolved to concrete values (no optional field left unresolved by
  the time it reaches the cache).
- **FR4** — `packages/audio/src/cache.ts` keys cache entries on a hash of the full
  `SynthesisRequest` object (not a hand-picked subset). A cache entry is `{ audio: Buffer;
  durationSeconds: number }`. Writes are atomic: write to a temp file in the same cache
  directory, then rename; a reader must never observe a partially-written entry.
- **FR5** — `packages/audio/src/durations.ts` exposes `computeAudioDurations(spec, opts):
  Promise<Record<string, number>>` — for every scene with `duration === "auto"`, synthesizes
  (cache-checked) each of its narration blocks, sums their measured durations, adds configurable
  head/tail padding, and clamps/validates against a configurable **minimum and maximum** duration
  in seconds. Exceeding the maximum throws (naming the scene id and the measured value) rather
  than silently clamping.
- **FR6** — `packages/audio/src/models.ts` pins the Kokoro ONNX model to an explicit URL and
  SHA-256 digest committed in this package's source. `claudevid models install` downloads and
  verifies against that digest. Every load from the local cache re-verifies the digest and fails
  closed (throws, does not re-download silently) on mismatch. No network access happens outside
  the explicit install command.
- **FR7** — Cache and model directories resolve through one shared root-resolution helper (used
  by both `cache.ts` and `models.ts`) so both agree on the project's cache root
  (`.claudevid/cache/`).

### Non-Functional Requirements

- **NFR1** — `packages/audio` has zero dependency on `packages/renderer-canvas`,
  `packages/motion`, or `packages/encoder-ffmpeg`. It depends only on `packages/core` (for
  `VideoSpec`/`NarrationBlock` types) and its own native runtime (`onnxruntime-node`/
  `kokoro-js`).
- **NFR2** — Every test except the one integration test (AC9) runs with zero real model
  download and zero real ONNX inference, via the `synthesize()` seam (FR2).
- **NFR3** — `computeAudioDurations`'s output is a plain `Record<string, number>` — the exact
  shape `CompileTimelineOptions.audioDurations` already accepts. No change to
  `packages/core/src/timeline.ts` is required or made by this change.

## Acceptance Criteria

- **AC1** — A `VideoSpec` scene with `narration: "hello world"` normalizes to
  `[{ text: "hello world" }]` when parsed by core's schema.
- **AC2** — A `VideoSpec` scene with `narration: [{ text: "a" }, { text: "b", voice: "x" }]`
  parses without modification.
- **AC3** — Calling `synthesize()` twice with an identical `SynthesisRequest` (via the fixture
  seam) produces a single cache write and a second call is a cache hit (no second call to the
  underlying `synthesize` fixture).
- **AC4** — Changing any single field of `SynthesisRequest` (text, voice, speed, modelId, or
  modelDigest) changes the cache key and produces a cache miss.
- **AC5** — Editing one narration block's text in a multi-block scene re-synthesizes only that
  block (the other block's cache entry is untouched, verified via call-count on the fixture).
- **AC6** — A cache write interrupted mid-write (simulated: kill before rename) leaves no
  partial entry visible to a subsequent read — that read is a cache miss, not corrupted audio.
- **AC7** — `computeAudioDurations` returns a duration for every `"auto"` scene in the spec,
  computed from the fixture's returned audio length plus configured padding.
- **AC8** — A scene whose computed duration (post-padding) exceeds the configured maximum throws
  an error naming the scene id and the computed value; one below the configured minimum is
  raised to the minimum (padding-and-bounds behavior stated once in FR5, tested for both
  directions).
- **AC9** *(gated integration tier, real model)* — `synthesize()` with the real Kokoro backend
  produces non-empty audio for a short sample sentence and the model digest verifies against the
  pinned value.
- **AC10** — `claudevid models install` downloads the pinned model and its digest verification
  passes; a deliberately corrupted local cache file fails digest verification on load and errors
  rather than silently re-downloading.
- **AC11** — `pnpm -r run build`, `pnpm -r run test`, `pnpm -r run lint` all pass from a clean
  checkout, and 001–005's existing suites are unaffected.

## Edge Cases

- Narration array is empty on a scene with `duration: "auto"` — throws naming the scene (no
  duration can be computed from zero blocks).
- Same text, same voice, different `speed` — different cache key (FR3/AC4).
- Two scenes share byte-identical narration text/voice/speed — same cache entry, computed once,
  reused for both scenes' duration sums (this is a feature of content-addressing, not a bug to
  guard against).
- Model digest mismatch on load from cache (e.g. cache dir shared across a library upgrade with
  no reinstall) — fails closed per FR6, never silently re-fetches.
- `duration: "auto"` scene present but `computeAudioDurations` never invoked / its output never
  passed to `compileTimeline` — core already throws `MissingAudioDurationError` (existing
  behavior, unchanged, verified in `packages/core/src/timeline.ts:61`).

## Dependencies

- `packages/core` — `VideoSpec`/`Scene`/`Layer` types, schema (`packages/core/src/schema.ts`,
  `packages/core/src/types.ts`), and the already-shipped `compileTimeline`/
  `CompileTimelineOptions`/`MissingAudioDurationError` (`packages/core/src/timeline.ts`).
- External: `kokoro-js`, `onnxruntime-node`.

## Notes

- Per-block wall-clock cost (party-po's open question) is measured during design/build via an
  indicative bench, following change 005's precedent of an indicative smoke bench in design.md
  rather than an asserted number in the spec.
- Per-scene voice/speed override, four caption styles, forced alignment, captions layer, audio
  graph, mux, lexicon, SRT/VTT are explicitly out of scope — see proposal.md and change 008.
- Model/voice-pack licensing review remains an open item, unchanged from the original proposal.
