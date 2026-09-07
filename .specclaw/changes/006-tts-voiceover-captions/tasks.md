# Tasks: Local TTS Voiceover & Duration Feedback (Kokoro synthesis only)

**Change:** 006-tts-voiceover-captions
**Created:** 2026-09-07
**Total Tasks:** 8

## Summary

8 tasks across 4 waves. Wave 1 adds the core-side schema change (narration normalization) and
scaffolds `packages/audio` with its shared types — both are zero-dependency on everything else
and everything downstream depends on them. Wave 2 builds the cache-root helper, `models.ts`
(pinned model + install + verify), and `tts.ts` (the `synthesize()` seam) in parallel — none of
the three depends on the others. Wave 3 builds `cache.ts` (depends on `tts.ts`'s request shape
and `cache-root.ts`) and `durations.ts` (depends on `cache.ts`), plus their tests. Wave 4 runs
the gated live-model integration test and the full-workspace regression pass. No core-side
`compileTimeline` change anywhere — verified already shipped in change 001.

## Tasks

### Wave 1 — Core schema addition, package scaffolding, shared types

- [x] `T1` — Core: `NarrationBlock` type + `scene.narration` schema, string-shorthand normalization
  - Files: `packages/core/src/types.ts`, `packages/core/src/schema.ts`, `packages/core/test/schema.test.ts`
  - Estimate: small
  - Kind: impl
  - Notes: Per spec.md FR1/AC1/AC2. `NarrationBlock = { text: string; voice?: string; speed?:
    number }`. `scene.narration?: string | NarrationBlock | NarrationBlock[]`, zod schema
    normalizes a bare string to `[{ text: <string> }]` at parse time so every downstream
    consumer only ever sees `NarrationBlock[]`. No change to any other schema field.

- [x] `T2` — `packages/audio` package scaffolding + shared types
  - Files: `packages/audio/package.json`, `tsup.config.ts`, `vitest.config.ts`, `tsconfig.json`, `src/types.ts`, `src/index.ts` (stub)
  - Estimate: small
  - Kind: config
  - Notes: Mirror `packages/encoder-ffmpeg`'s package.json/tsup/vitest shape (private, ESM,
    `main`/`types`/`exports` → `dist/`). Deps: `@claudevid/core` (workspace), `kokoro-js`,
    `onnxruntime-node`. `src/types.ts` defines `SynthesisRequest`, `CachedSynthesis`,
    `AudioDurationsOptions` per spec.md FR3/design.md Data Model — plain interfaces, no logic.

### Wave 2 — cache-root, models, tts (independent of each other)

- [x] `T3` — `cache-root.ts`: shared cache-root resolution helper
  - Files: `packages/audio/src/cache-root.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T2
  - Notes: Per spec.md FR7/design.md D2. Single function resolving `.claudevid/cache/` relative
    to the project root; both `cache.ts` (T5) and `models.ts` (T4) call it — neither hardcodes a
    path independently.

- [x] `T4` — `models.ts`: pinned model URL+digest, install command, verify-on-load
  - Files: `packages/audio/src/models.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T2, T3
  - Notes: Per spec.md FR6/AC10. Model URL + SHA-256 digest committed as constants in this file.
    `installModels()` downloads to the cache root (T3) and verifies digest before considering
    install complete. A load-from-cache helper re-verifies digest and throws (does not
    re-download) on mismatch. Network access confined to `installModels()` — nothing else in
    this package makes a network call.

- [x] `T5` — `tts.ts`: `synthesize()` — Kokoro backend + injectable seam
  - Files: `packages/audio/src/tts.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T2
  - Notes: Per spec.md FR2. `synthesize(request: SynthesisRequest): Promise<{ audio: Buffer;
    sampleRate: number }>`. Production implementation loads the model via `models.ts` (T4) and
    runs `kokoro-js` on `onnxruntime-node`. The function itself is the test seam — callers in
    `cache.ts`/`durations.ts` accept an injected `synthesize` implementation as a parameter/
    dependency rather than importing this module's default directly, so tests substitute a
    fixture with zero real inference (design.md NFR2).

### Wave 3 — cache.ts, durations.ts + their tests

- [x] `T6` — `cache.ts`: content-hash cache over the full `SynthesisRequest`, atomic writes
  - Files: `packages/audio/src/cache.ts`, `packages/audio/test/cache.test.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T3, T5
  - Notes: Per spec.md FR4/AC3/AC4/AC5/AC6/design.md D1. Key = hash of the entire
    `SynthesisRequest` object (`JSON.stringify` of a canonically-ordered object, then SHA-256) —
    never a hand-picked field subset, so a field added later changes the key with no code change
    here. Entry shape `{ audio, durationSeconds }` (design.md D-adjacent: cache the measurement
    alongside the audio). Writes: write to a temp file in the same directory, `fs.rename` to the
    final path — a reader sees either nothing or a complete entry, never partial. Test file
    covers AC3–AC6 entirely via a fixture `synthesize`, zero real model.

- [x] `T7` — `durations.ts`: `computeAudioDurations()` + its tests
  - Files: `packages/audio/src/durations.ts`, `packages/audio/test/durations.test.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T6
  - Notes: Per spec.md FR5/AC7/AC8. For every scene with `duration === "auto"`: resolves each
    `NarrationBlock` to a `SynthesisRequest` (spec-level voice/speed defaults + pinned
    `modelId`/`modelDigest` from `models.ts`), calls `cache.ts`'s get-or-synthesize path, sums
    `durationSeconds` across the scene's blocks, adds `headPaddingSeconds`/`tailPaddingSeconds`,
    clamps to `minDurationSeconds` (raise silently — a floor is not a diagnostic-worthy event)
    and **throws naming the scene id and computed value** when the result exceeds
    `maxDurationSeconds` (no silent clamp on the ceiling — design.md D6). Returns
    `Record<sceneId, seconds>` — the exact shape `CompileTimelineOptions.audioDurations` already
    accepts (verified against `packages/core/src/timeline.ts`, no core change). Test file covers
    AC7, AC8 (both min and max directions) via the same cache/synthesize fixtures as T6.

### Wave 4 — gated integration test + full-workspace regression

- [x] `T8` — Live-model integration test (gated) + workspace-wide build/test/lint pass
  - Files: `packages/audio/test/tts.live.test.ts`
  - Estimate: medium
  - Kind: test
  - Depends: T4, T5, T7
  - Notes: `tts.live.test.ts` is a separate, isolatable file (mirrors change 005's
    `pipe.live.test.ts` precedent — skippable on a runner without the real model/native build)
    covering AC9: real Kokoro synthesis of a short sample sentence produces non-empty audio and
    the loaded model's digest verifies against the pinned value from `models.ts`. Also record an
    indicative bench (seconds-per-block, cache-cold vs. cache-warm) in this task's notes/PR
    description per design.md's Risks section — informs 008's cost budgeting. Then run
    `pnpm -r run build`, `pnpm -r run test`, `pnpm -r run lint` from a clean checkout (AC11) and
    confirm 001–005's existing suites are unaffected. Reconcile every AC in spec.md against a
    task above before marking this change built.

---

## Legend

- `[ ]` Pending
- `[~]` In Progress
- `[x]` Complete
- `[!]` Failed

**Task format:**
```
- [ ] `T<n>` — <title>
  - Files: <files to create/modify>
  - Estimate: small | medium | large
  - Kind: docs | test | config | refactor | impl | migration
  - Depends: <task ids> (if any)
  - Notes: <additional context>
```
