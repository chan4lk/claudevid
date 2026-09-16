# Design: Per-scene external audio — drive a scene from a pre-recorded WAV

**Change:** 013-scene-external-audio
**Created:** 2026-09-16

## Technical Approach

Treat a decoded audio file as one more "block" in the structure Step A already builds
(`Map<sceneId, SynthesizedBlock[]>` in `packages/cli/src/render-pipeline.ts`). Everything
downstream — `computeAudioDurationsRecord` (Step B), `compileTimeline` (Step C),
`assembleVoiceTrack` (Step D), the mux (Step G) — consumes blocks by `durationSeconds` and
`offsetSeconds` and never asks where the PCM came from. So the feature is: (1) a schema field,
(2) a decoder that yields the `synthesize()` shape, (3) a branch in Step A, plus the guards the
panel asked for at each new boundary.

Three boundaries, three guards:

| Boundary | Guard | Where |
|---|---|---|
| JSON → spec | `src` is a plain path, no URL scheme; `narration` xor `audio` | `core/schema.ts` (pure) |
| spec → filesystem | spec-relative resolution, `realpath`, regular file, containment under `specDir`/`--audio-root` | `cli/scene-audio-paths.ts` (CLI layer, injectable fs) |
| file → PCM | bounded spawn (timeout, byte cap), minimum length, ffprobe cross-check, single sample rate | `audio/decode.ts` |

## Architecture

```
validate/render/preview/batch/generate
        │ parseSpec (pure)                       core/schema.ts   ← FR1–FR5
        │ resolveSceneAudioPaths(spec, specDir)  cli/scene-audio-paths.ts ← FR6–FR8
        ▼
runRenderPipeline(spec, opts)
  ├─ captions gate (FR17) ─ throws CaptionsExternalAudioError unless allow-partial
  ├─ Step A  collectSceneAudio
  │     narration → synthesizeFn (unchanged)          source: "narration"
  │     audio     → decodeAudioFn(resolved src)       source: "audio", offset = padStart
  │     every block: sampleRate === VOICE_TRACK_SAMPLE_RATE else throw (FR13)
  ├─ Step B  audioDurations[scene] = padStart + decoded + padEnd        (FR14)
  ├─ Step C  compileTimeline (unchanged)
  ├─ advisory diagnostics: overlap > padEnd, fixed duration < audio    (FR15)
  ├─ Step E  insertCaptionsLayers — skips source:"audio" blocks         (FR17)
  ├─ Step D  assembleVoiceTrack (unchanged; zero-fill = pads are silence)
  └─ Step G  mux (unchanged)  → returns { skippedCaptionSceneIds }
```

## File Changes Map

| File | Action | Description |
|------|--------|-------------|
| `packages/core/src/schema.ts` | modify | Add `sceneAudioSchema` (FR1–FR2), `narration` xor `audio` refinement (FR3), remove `audioSchema`/`AudioTrack` and `audio` from `videoSpecSchema` (FR4) |
| `packages/core/src/types.ts` | modify | Add `SceneAudio`, `Scene.audio?`; remove `AudioTrack` re-export and `VideoSpec.audio` (FR5) |
| `packages/core/src/index.ts` | modify | Export `SceneAudio`; drop `AudioTrack` |
| `packages/core/test/schema.test.ts` | modify | AC1–AC5 |
| `packages/core/test/json-schema.test.ts` | modify | AC5 (schema shape) |
| `packages/audio/src/decode.ts` | create | `VOICE_TRACK_SAMPLE_RATE`, `decodeAudioFile`, `DecodeError`, `DecodeAudioOptions` (FR9–FR11) |
| `packages/audio/src/index.ts` | modify | Export the above (FR12) |
| `packages/audio/src/tts.ts` | modify | One comment line: Kokoro's 24 kHz is `VOICE_TRACK_SAMPLE_RATE` |
| `packages/audio/test/decode.test.ts` | create | AC8 (fake spawn, fake timers), AC9 (real ffmpeg, gated) |
| `packages/cli/src/scene-audio-paths.ts` | create | `resolveSceneAudioPaths` (FR6) |
| `packages/cli/test/scene-audio-paths.test.ts` | create | AC6 |
| `packages/cli/src/render-pipeline.ts` | modify | Step A branch, `decodeAudioFn` seam, rate check, pads in durations, advisory diagnostics, captions gate + skip, return value (FR13–FR17) |
| `packages/cli/test/render-pipeline.test.ts` | modify | AC10–AC14 |
| `packages/cli/src/commands/render.ts` | modify | `--captions-allow-partial`, `--audio-root`, path resolution, sidecar (FR7, FR8, FR18) |
| `packages/cli/src/commands/validate.ts` | modify | Path resolution + `--audio-root` (FR7, FR8) |
| `packages/cli/src/commands/preview.ts` | modify | Path resolution in once/watch/sheet (FR7) |
| `packages/cli/src/commands/batch.ts` | modify | Path resolution for spec jobs and rendered prompt jobs (FR7) |
| `packages/cli/src/commands/generate.ts` | modify | Path resolution before `--render` (FR7) |
| `packages/cli/test/render.test.ts`, `validate.test.ts` | modify | AC7, AC15 |
| `packages/claude/src/prompts/build-director-prompt.ts` | modify | FR19 sentence |
| `packages/claude/prompts/video-director.md`, `packages/claude/schemas/video-spec.schema.json`, `.claude/skills/video-generator/schemas/video-spec.schema.json` | regenerate | FR19 via `generate-assets` |
| `.claude/skills/video-generator/SKILL.md` | modify | FR20 section |
| `.specclaw/changes/013-scene-external-audio/verify-report.md` | create (verify phase) | FR21 records: rollback path/command, smoke durations, decode cost |

## Data Model Changes

```ts
// core/types.ts
export interface SceneAudio {
  /** Plain file path, relative to the spec file's directory or absolute. Never a URL. */
  src: string;
  /** Silence before the audio starts, seconds (default 0). */
  padStart?: number;
  /** Silence after the audio ends, seconds (default 0). */
  padEnd?: number;
}
export interface Scene { …; audio?: SceneAudio; }   // narration xor audio
export interface VideoSpec { …; /* audio?: AudioTrack — REMOVED */ }
```

```ts
// cli/render-pipeline.ts (internal)
interface SynthesizedBlock {
  text: string;            // "" for audio blocks
  audio: Buffer; sampleRate: number; durationSeconds: number; offsetSeconds: number;
  source: "narration" | "audio";
}
```

## API Changes

- `@claudevid/core`: `+ SceneAudio`, `− AudioTrack` (type), `− VideoSpec.audio`.
- `@claudevid/audio`: `+ decodeAudioFile(src, opts?)`, `+ DecodeError`, `+ DecodeAudioOptions`,
  `+ VOICE_TRACK_SAMPLE_RATE`.
- `@claudevid/cli` `runRenderPipeline(spec, opts)`: `opts.decodeAudioFn?`,
  `opts.captionsAllowPartial?`; **return type** `Promise<void>` → `Promise<{ skippedCaptionSceneIds:
  string[] }>` (callers that ignore the result are unaffected). `+ CaptionsExternalAudioError`.
- CLI flags: `render --captions-allow-partial`, `render|validate|preview|batch|generate --audio-root <dir>`.

## Key Decisions

- **D1 — Blocks, not a parallel structure.** Decoded audio enters the same `SynthesizedBlock`
  map as narration with a `source` tag. Steps B/C/D/G need no change; pads become silence for free
  because `assembleVoiceTrack` zero-fills and places by `offsetSeconds`. The alternative (a second
  map and a second placement loop) would duplicate the clamp and offset arithmetic the proposal
  exists to avoid duplicating.
- **D2 — Existence checks in the CLI, not the schema.** `parseSpec` is pure and shared with the
  Claude repair loop; putting `fs` in it would make `@claudevid/core` environment-dependent. The
  CLI layer already owns file I/O for every command, so `resolveSceneAudioPaths` sits beside
  `parseSpec` in each command and speaks the same `Diagnostic` shape. (party-architect WARN on
  parse/decode seam; party-security BLOCK 1.)
- **D3 — Spec-relative paths with containment.** Resolving against the spec file's directory makes
  a committed spec portable (party-visionary), and containment under that directory (or an explicit
  `--audio-root`) closes the arbitrary-file-read path (party-security). `realpath` first so symlink
  escapes are caught. Image layers keep their cwd rule — out of scope, named as follow-up.
- **D4 — One sample-rate constant, error on mismatch.** `VOICE_TRACK_SAMPLE_RATE` lives in
  `@claudevid/audio` next to the synthesiser; the decoder defaults to it and the pipeline rejects
  any block that disagrees. Adopting a block's rate at runtime would make the track's rate a
  function of spec content (party-security rebuttal of party-visionary), so the constant is
  fail-closed and the duplication is gone.
- **D5 — Decode failures are checks, not measurements.** Exit code alone lets an empty stream
  render green; hence the minimum length, the byte cap, the timeout, and the ffprobe cross-check
  (party-security BLOCK 2). Tolerance 0.25 s: WAV agrees to the sample; MP3 carries encoder
  delay/padding of tens of milliseconds; anything beyond a quarter second is a corrupt or
  truncated file, not a codec quirk.
- **D6 — Captions fail closed; skip is opt-in and recorded.** `insertCaptionsLayers` keeps the
  full scene list (indices stable — party-architect BLOCK 3) and skips by `source`. The sidecar
  file makes the degradation survive the terminal (party-security WARN).
- **D7 — Delete `audio.track` now.** It has no reader (grep in proposal), no example, no doc. The
  repo owner chose deletion over renaming the scene field; a future music bed reintroduces
  whole-video audio under its own name and reuses `decodeAudioFile` (channels option) as its input.
- **D8 — No cache for decoded blocks.** `cache.ts` is keyed on narration text and exists because
  synthesis is slow; a local file decode is not. Stated in code (FR16) so nobody guesses.
- **D9 — Fixture generated at test time.** No binary in the repo; `mux.test.ts` already builds sine
  WAVs with `ffmpeg -f lavfi`. Same gate, same pattern.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Removing `audio.track` breaks an unknown consumer | grep shows none in the repo; the dist README never documented it; AC5 makes the failure a clear `/audio` diagnostic, not silence |
| ffprobe duration for compressed sources disagrees with decoded length | 0.25 s tolerance (D5); WAV is the primary input; `duration-mismatch` names both numbers so the operator can widen `durationToleranceSeconds` deliberately |
| `realpath` on a not-yet-existing path throws | resolver checks `statFn` first and maps `ENOENT` to *not found* |
| Bare `pnpm` is broken on this machine (L1) | every build/test/package command uses `npx pnpm@10`; `build-dist-package.mjs` is run with `--skip-build` after an explicit `npx pnpm -r run build` |
| Global reinstall regresses other pipelines | rollback tarball + smoke gate (FR21, AC18) before `npm install -g` |
| Parallel build waves racing on one working tree (L2) | each task stages/commits only its declared files by exact path (L3) |

## Grounding sources

- `docs/Qwen_markdown_20260906_vsjxybyq8.md` — original plan's root `"audio": { "voiceover": …,
  "music": … }` block: establishes that `audio.track` was the unfinished voiceover/music idea, and
  that per-scene voice is the half this change realises.
- `.claude/skills/video-generator/SKILL.md` — "Captions are never hand-authored … the render pipeline
  inserts the `captions` layer itself": why external-audio scenes cannot be captioned and why the
  gate must be explicit.
- `.specclaw/learnings.md` L1 ("bare 'pnpm' binary … is broken"), L2/L3 (commit race; stage only
  declared files): drive FR21's `npx pnpm` and the tasks' commit discipline.
- `packages/cli/src/render-pipeline.ts` (`assembleVoiceTrack` header: "a track is assumed to
  occupy the full output duration from t=0 … this single continuous file has to exist"): why D1
  reuses the block map rather than adding a second track.
- `packages/audio/test/mux.test.ts:318` (`sine=frequency=440:duration=2`) and
  `graph.test.ts:279` (`describe.skipIf(!ffmpegAvailable)`): the fixture and gating pattern D9
  copies.
