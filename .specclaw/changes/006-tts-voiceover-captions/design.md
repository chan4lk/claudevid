# Design: Local TTS Voiceover & Duration Feedback (Kokoro synthesis only)

**Change:** 006-tts-voiceover-captions
**Created:** 2026-09-07

## Technical Approach

```
VideoSpec (scene.narration: string | NarrationBlock | NarrationBlock[])
        │  [core schema normalization — FR1]
        ▼
  NarrationBlock[] per scene
        │
        ▼
   resolveSynthesisRequest(block, spec-level voice/speed defaults, pinned modelId/modelDigest)
        │
        ▼
     SynthesisRequest { text, voice, speed, modelId, modelDigest }
        │
        ├──────────────► cache.ts: hash(SynthesisRequest) ──► hit? return { audio, durationSeconds }
        │                                                  └─► miss ▼
        │
        ▼
     tts.ts: synthesize(request) → { audio, sampleRate }   (Kokoro/onnxruntime-node in prod;
        │                                                    injectable fixture in tests — FR2)
        ▼
   measure duration from audio+sampleRate → durationSeconds
        │
        ▼
   cache.ts: atomic write { audio, durationSeconds } keyed on hash(request)  — FR4
        │
        ▼
durations.ts: computeAudioDurations(spec, opts)
   for each "auto" scene: sum block durationSeconds + head/tail padding, clamp to [min,max]  — FR5
        │
        ▼
   Record<sceneId, seconds>  ──────────────► core's compileTimeline(spec, { audioDurations })
                                              (packages/core/src/timeline.ts — UNCHANGED, already
                                               accepts this exact shape; MissingAudioDurationError
                                               already thrown when a scene's entry is absent)
```

`models.ts` is a separate concern that feeds `tts.ts` (which model file to load) and is checked
independently: pinned URL+digest, `claudevid models install` fetches, every load-from-cache
re-verifies the digest (FR6).

## Architecture

```
packages/audio/
  package.json               # deps: @claudevid/core (workspace), kokoro-js, onnxruntime-node
  tsup.config.ts
  vitest.config.ts
  tsconfig.json
  src/
    types.ts                 # NarrationBlock, SynthesisRequest, AudioDurationsOptions
    tts.ts                   # synthesize() — Kokoro/onnxruntime-node, injectable seam
    cache.ts                 # content-hash cache, atomic writes, single project-cache root
    durations.ts             # computeAudioDurations() — the FR5 entry point
    models.ts                # pinned model URL+digest, install command, verify-on-load
    cache-root.ts             # shared root-resolution helper (FR7) — used by cache.ts and models.ts
    index.ts                  # public exports
  test/
    cache.test.ts             # AC3, AC4, AC5, AC6 — fixture synthesize(), no real model
    durations.test.ts         # AC1(via core), AC7, AC8 — fixture synthesize()
    models.test.ts            # AC10 — digest verification, corrupted-cache-file case, fake fetch
    tts.live.test.ts           # AC9 — isolated file, real Kokoro, gated/skippable like 005's
                                 pipe.live.test.ts precedent

packages/core/  (existing package, one schema addition)
  src/
    types.ts                 # + NarrationBlock, scene.narration: string | NarrationBlock |
                               NarrationBlock[]
    schema.ts                 # + zod schema for the above, string normalizes to NarrationBlock[]
    layers.ts                  # untouched
  test/
    schema.test.ts             # + AC1, AC2 cases (narration normalization)
```

No change to `packages/core/src/timeline.ts` — verified: `CompileTimelineOptions.audioDurations`,
`resolveSceneDurationSeconds`, and `MissingAudioDurationError` are already present and already
implement the exact fail-closed contract this design needs (spec.md FR5/NFR3).

## File Changes Map

| File | Action | Description |
|------|--------|-------------|
| `packages/audio/package.json` | new | package scaffolding, deps on `kokoro-js`/`onnxruntime-node` |
| `packages/audio/tsup.config.ts` | new | mirrors `encoder-ffmpeg`'s config |
| `packages/audio/vitest.config.ts` | new | mirrors `encoder-ffmpeg`'s config |
| `packages/audio/tsconfig.json` | new | extends `tsconfig.base.json` |
| `packages/audio/src/types.ts` | new | `NarrationBlock`, `SynthesisRequest`, options types |
| `packages/audio/src/tts.ts` | new | `synthesize()` — Kokoro backend + injectable seam |
| `packages/audio/src/cache-root.ts` | new | shared cache-root resolution (FR7) |
| `packages/audio/src/cache.ts` | new | content-hash cache, atomic writes |
| `packages/audio/src/durations.ts` | new | `computeAudioDurations()` |
| `packages/audio/src/models.ts` | new | pinned model, install, verify-on-load |
| `packages/audio/src/index.ts` | new | public exports |
| `packages/audio/test/*.test.ts` | new | per Architecture above |
| `packages/core/src/types.ts` | modify | add `NarrationBlock`, `scene.narration` union type |
| `packages/core/src/schema.ts` | modify | add narration zod schema + string-shorthand normalization |
| `packages/core/test/schema.test.ts` | modify | add AC1/AC2 cases |

## Data Model Changes

```ts
// packages/core/src/types.ts
export interface NarrationBlock {
  text: string;
  voice?: string;
  speed?: number;
}
// Scene.narration?: string | NarrationBlock | NarrationBlock[]  (schema normalizes to NarrationBlock[])

// packages/audio/src/types.ts
export interface SynthesisRequest {
  text: string;
  voice: string;
  speed: number;
  modelId: string;
  modelDigest: string;
}
export interface CachedSynthesis {
  audio: Buffer;
  durationSeconds: number;
}
export interface AudioDurationsOptions {
  headPaddingSeconds?: number;
  tailPaddingSeconds?: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
}
```

## API Changes

- `@claudevid/audio` public exports: `synthesize`, `computeAudioDurations`, `resolveCacheRoot`,
  `installModels`, plus all types above.
- `@claudevid/core` public exports: `NarrationBlock` type addition; no existing export's
  signature changes (`compileTimeline` already accepts `opts.audioDurations`).

## Key Decisions

- **D1 — Cache key is the full resolved request object, not an enumerated field list.** Resolves
  party-security/party-visionary's convergent finding on the original proposal (lexicon/pitch
  omitted from a hand-maintained key). A field added in 008 (lexicon digest) is added to
  `SynthesisRequest` and the key changes automatically — no `cache.ts` change needed then.
- **D2 — No second cache mechanism, no duplicated cache root.** Verified `packages/encoder-
  ffmpeg` ships no chunk-resume cache (005's own party review cut it — see that change's
  design.md Grounding sources). This is the project's first content-hash cache; `cache-root.ts`
  is the single root-resolution helper both `cache.ts` and `models.ts` call, so there is one
  cache root (`.claudevid/cache/`), not two.
- **D3 — `computeAudioDurations` never touches `compileTimeline`.** It only produces the
  `Record<string, number>` shape core already consumes. This keeps `packages/core` free of any
  dependency on `packages/audio` (NFR1's inverse: core doesn't import audio either).
- **D4 — Narration is structural (`NarrationBlock`), never a bare string internally.** A bare
  string is accepted at the schema boundary and normalized once. Resolves the schema-door
  problem party-visionary raised for future multi-speaker/per-block voice support.
- **D5 — Model pinning replaces "download with integrity check against a self-served hash,"**
  revised after verify-report.md's PARTIAL finding that `tts.ts` originally bypassed this
  entirely. `PINNED_MODEL.id` (models.ts) is `tts.ts`'s single source of truth for which model to
  load, and `tts.ts` points `@huggingface/transformers`'s hub-client cache dir at this package's
  shared cache root (D2), so Kokoro's own download lands in and is reused from one place. Digest
  verification (`installModels`/`verifyInstalledModel`) remains a real, tested primitive for an
  explicit single-file fetch — it does not run against Kokoro's own multi-file hub-cached
  download, which has no single byte sequence to check against a pinned digest. Resolves
  party-security's root-of-trust WARN for the "which model, cached where" question; per-file
  integrity verification of a multi-file hub cache tree remains open (see spec.md FR6's scope
  boundary).
- **D6 — Fail-closed everywhere, no new fallback paths.** `MissingAudioDurationError` (already
  in core) covers the absent-map case; digest mismatch throws rather than re-fetching; exceeding
  max duration throws rather than clamping. No new "guess and continue" path is introduced by
  this change.

## Risks & Mitigations

- **Risk:** `onnxruntime-node` native build variance across platforms (CoreML/Metal on Apple
  Silicon vs. CPU fallback elsewhere). **Mitigation:** `tts.ts`'s production path is isolated
  behind the `synthesize()` seam; every test except AC9 never touches it, so CI doesn't need a
  working native build to validate FR3–FR7.
- **Risk:** Per-block wall-clock cost unknown (open question, carried from proposal.md).
  **Mitigation:** run an indicative bench during this change's own build (same pattern as change
  005's design.md), record actual seconds-per-block, cache-cold vs. cache-warm, before 008 begins
  (008's whisper.cpp cost stacks on top of this one).
- **Risk:** Model licensing unresolved. **Mitigation:** tracked as an explicit open item in
  proposal.md/spec.md Notes; not a blocker for this change's build since v1 ships no redistributed
  model weights in the repo (fetched at install time, not committed).
