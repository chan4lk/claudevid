# Tasks: Per-scene external audio — drive a scene from a pre-recorded WAV

**Change:** 013-scene-external-audio
**Created:** 2026-09-16
**Total Tasks:** 8

## Summary

Eight tasks in four waves. Wave 1 builds the two independent primitives — the schema field and the
decoder — each with its tests; they touch disjoint packages and can run in parallel. Wave 2 adds
the CLI path resolver (needs the core types) and the pipeline branch (needs both primitives), also
disjoint files. Wave 3 wires the commands and regenerates the Claude assets. Wave 4 is docs and the
build/package/smoke/reinstall gate.

Kept coarse (Rule 2): the five command files that each add the same three-line "resolve after
parse" call are one task, not five; docs and the prompt sentence ride with the tasks that own the
neighbouring files.

**Parallel-wave discipline** (`.specclaw/learnings.md` L2/L3): `git.strategy` is
`branch-per-change`, so tasks in one wave share a working tree. Each task stages and commits
**only its own declared files, by exact path** — never `git add -A`, `.`, or `-a`.

**Tooling** (`learnings.md` L1): bare `pnpm` is broken on this machine. Every task runs tests with
`npx pnpm@10 --filter <pkg> run test` (or `npx pnpm -r run test`), never `pnpm`.

## Tasks

### Wave 1 — Primitives

- [x] `T1` — `scene.audio` in the core schema; remove `audio.track`
  - Files: `packages/core/src/schema.ts`, `packages/core/src/types.ts`, `packages/core/src/index.ts`, `packages/core/test/schema.test.ts`, `packages/core/test/json-schema.test.ts`
  - Estimate: small
  - Kind: impl
  - Notes: FR1–FR5, AC1–AC5. `sceneAudioSchema = z.object({ src, padStart?, padEnd? })` with
    `src` refined by `!/:\/\//.test(s) && !/^[A-Za-z][A-Za-z0-9+.-]+:/.test(s)` (two-plus-char
    scheme; `C:\` stays legal — Edge Case 7). Refinement message names the forbidden prefixes.
    Add the `narration` xor `audio` issue to `sceneSchema`'s existing `superRefine` (path `[]`
    relative to the scene → surfaces as `/scenes/N`), message per FR3 with a `suggestion`-friendly
    wording. Delete `audioSchema`, the `AudioTrack` export in `schema.ts`/`types.ts`/`index.ts`,
    and `VideoSpec.audio`; grep the workspace for `AudioTrack` imports **from `@claudevid/core`**
    (the `@claudevid/audio` `AudioTrack` interface in `graph.ts` is a different type and stays).
    Check whether `videoSpecSchema` already rejects unknown keys; if not, add `.strict()` so AC5's
    `/audio` diagnostic exists. Update `SceneInput`/`VideoSpecInput` type aliases. Tests: the five
    ACs, plus assert `generateJsonSchema()` has `scenes.items.properties.audio` and no root
    `properties.audio`.

- [x] `T2` — `decodeAudioFile` + `VOICE_TRACK_SAMPLE_RATE` in `@claudevid/audio`, with tests
  - Files: `packages/audio/src/decode.ts`, `packages/audio/src/index.ts`, `packages/audio/src/tts.ts`, `packages/audio/test/decode.test.ts`
  - Estimate: medium
  - Kind: impl
  - Notes: FR9–FR12, AC8–AC9, NFR2, NFR4. Mirror `mux.ts`: `spawnFn`/`ffmpegPath` seams,
    `waitForExit`-style settlement, 20-line stderr tail. Argv exactly as FR10 (test asserts the
    array). Count stdout bytes as they arrive; when `> maxSeconds*rate*channels*2` call
    `child.kill()` and reject `"too-long"`; `setTimeout(timeoutMs)` → `child.kill()` →
    `"timeout"` (use `vi.useFakeTimers()` in that test). After exit 0: `"too-short"` when
    `bytes < minSeconds*rate*channels*2`; then `probeDurationSecondsFn(src)` (default: `mux.ts`'s
    exported `probeDurationSeconds` with the same `spawnFn`) and `"duration-mismatch"` when
    `|decoded − probed| > durationToleranceSeconds` (0.25). `DecodeError` fields: `reason`, `src`,
    `exitCode`, `stderrTail`. `tts.ts`: one comment line referencing the constant — **do not**
    change its behaviour. Real-ffmpeg test: generate the WAV with `spawnSync("ffmpeg", ["-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "44100", path])` into
    `os.tmpdir()`, gate with the `describe.skipIf(!ffmpegAvailable)` pattern from
    `graph.test.ts:225-233`, assert `24000 ± 24` samples and `sampleRate 24000`. Record that
    test's wall time in your task report (FR21 decode-cost figure).

### Wave 2 — CLI resolver and pipeline branch

- [x] `T3` — `resolveSceneAudioPaths` in the CLI, with tests
  - Files: `packages/cli/src/scene-audio-paths.ts`, `packages/cli/test/scene-audio-paths.test.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T1
  - Notes: FR6, AC6, NFR3. Signature per spec: `{ specDir, audioRoot?, statFn?, realpathFn? }`
    defaulting to `fs.statSync`/`fs.realpathSync`. Order per scene: resolve relative → `statFn`
    (`ENOENT` → *not found*; `!isFile()` → *not a regular file*) → `realpathFn` → containment:
    `real.startsWith(realRoot + path.sep) || real === realRoot`… (a file can't equal the root; keep
    the `+ sep` form so `/deck/audio-evil` fails against `/deck/audio`). Return a **new** spec
    (`{ ...spec, scenes: scenes.map(...) }`), never mutate. Diagnostics use the existing
    `Diagnostic` shape from `@claudevid/core` with `path: "/scenes/N/audio/src"` and the FR6
    suggestion text. Tests cover every AC6 bullet with injected fakes only.

- [x] `T4` — Pipeline: collect scene audio, pads, rate check, diagnostics, captions gate, return value
  - Files: `packages/cli/src/render-pipeline.ts`, `packages/cli/test/render-pipeline.test.ts`
  - Estimate: large
  - Kind: impl
  - Depends: T1, T2
  - Notes: FR13–FR17, AC10–AC14, NFR1. Rename `synthesizeNarration` → `collectSceneAudio`
    (keep the doc comment's design note, extend it). Add `source` to `SynthesizedBlock`; for an
    `audio` scene push one block `{ text: "", audio, sampleRate, durationSeconds, offsetSeconds:
    padStart ?? 0, source: "audio" }`. Immediately after collection, throw if any block's
    `sampleRate !== VOICE_TRACK_SAMPLE_RATE` (message: scene id, block rate, expected rate).
    `computeAudioDurationsRecord`: for `audio` scenes add `(padStart ?? 0) + (padEnd ?? 0)`.
    **Do not touch `assembleVoiceTrack`** — pads are silence because it zero-fills and places by
    `offsetSeconds` (D1); AC10 asserts that by inspecting the WAV the pipeline writes (inject
    `tempRun`? no — read the file at the `voiceTrackPath` passed to `buildAudioGraphArgvFn`'s
    `tracks[0].filePath` inside the fake, before the pipeline's `finally` cleans it up). Captions
    gate **before** Step A: `opts.captions && !opts.captionsAllowPartial && anyAudioScene` →
    `throw new CaptionsExternalAudioError(ids)` (export it). In `insertCaptionsLayers`, skip a scene
    whose blocks are all `source: "audio"` and collect its id. Advisory diagnostics through
    `reportDiagnostics("audio:", …)` after the timeline is compiled (FR15 a/b). Add a comment at the
    decode call: decoded blocks bypass `cache.ts` deliberately (FR16). Return
    `{ skippedCaptionSceneIds }`. Existing tests must pass unchanged (NFR1) — `buildFakes` gains a
    `decodeAudioFn` fake returning a fixed 2 s zero buffer at 24 000 Hz.

### Wave 3 — Commands and generated assets

- [x] `T5` — Wire path resolution and the new flags into every command
  - Files: `packages/cli/src/commands/render.ts`, `packages/cli/src/commands/validate.ts`, `packages/cli/src/commands/preview.ts`, `packages/cli/src/commands/batch.ts`, `packages/cli/src/commands/generate.ts`, `packages/cli/test/render.test.ts`, `packages/cli/test/validate.test.ts`, `packages/cli/test/generate.test.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T3, T4
  - Notes: FR7, FR8, FR18, AC7, AC15. In each command, right after `parseSpec(...).ok`: `const
    resolved = resolveSceneAudioPaths(spec, { specDir: path.dirname(path.resolve(specPath)),
    audioRoot })`; on `!ok` print diagnostics in the existing `path: message, suggestion` format
    and return non-zero. `render.ts`: parse `--captions-allow-partial` (ArgError without
    `--captions`) and `--audio-root`; pass `captionsAllowPartial` to the pipeline; on a non-empty
    `skippedCaptionSceneIds` write `<outPath>.captions-skipped.json` through a new injected
    `writeFile` dep and append `(captions skipped on N scene(s), see …)` to the message. `validate.ts`
    adds `--audio-root` to its arg parsing (check how it parses today; add `findFlagValue`).
    `preview.ts`: resolve in the single-shot path, in `watchPreview`'s rerender, and before
    `renderContactSheet`. `batch.ts`: resolve spec jobs against `dir`; prompt jobs resolve against
    the written spec's directory. `generate.ts`: resolve against `dirname(outPath)` before
    `--render`. Add the `resolveSceneAudioPaths` call to the existing DI `deps` objects so
    `render.test.ts`/`validate.test.ts` can inject fakes (AC7). Keep the untouched-command tests
    green. T4 changed `runRenderPipeline`'s return type; the two `vi.fn` fakes in
    `generate.test.ts` (lines ~183/195) must return `{ skippedCaptionSceneIds: [] }` so `tsc --noEmit`
    passes again.

- [x] `T6` — Director prompt sentence + regenerate schema/prompt/skill assets
  - Files: `packages/claude/src/prompts/build-director-prompt.ts`, `packages/claude/prompts/video-director.md`, `packages/claude/schemas/video-spec.schema.json`, `.claude/skills/video-generator/schemas/video-spec.schema.json`
  - Estimate: small
  - Kind: config
  - Depends: T1
  - Notes: FR19, AC16. Add one bullet to the authoring guidance in `build-director-prompt.ts`:
    never emit `scene.audio` unless the user supplied audio files and their paths; otherwise use
    `narration`. Then `npx pnpm@10 --filter @claudevid/claude run generate-assets` (it writes the
    prompt and schema and syncs the skill copies). Run `npx pnpm@10 --filter @claudevid/claude run
    test` — `generated-assets.test.ts` and `examples.test.ts` must pass. Commit only the four
    declared files (the generator may also touch example copies; if it rewrites an example
    byte-identically nothing shows in `git status`).

### Wave 4 — Docs, build, package, smoke, reinstall

- [x] `T7` — Skill documentation
  - Files: `.claude/skills/video-generator/SKILL.md`
  - Estimate: small
  - Kind: docs
  - Depends: T5
  - Notes: FR20. New section "External audio per scene" after "Captions are never hand-authored":
    the field and pads, `narration` xor `audio`, spec-relative `src` + containment +
    `--audio-root`, fail-closed `--captions` + `--captions-allow-partial` + the sidecar, that
    audio is normalised to the voice track's sample rate (no number), and that the old root
    `audio.track` is gone. Keep it under ~35 lines; the schema is the source of truth for shapes.

- [x] `T8` — Build, test, lint, package, rollback copy, smoke gate, global reinstall
  - Files: `dist-package/` (regenerated, untracked), `claudevid-0.1.0.tgz` (regenerated), `.specclaw/changes/013-scene-external-audio/verify-report.md` (measurements only — the verify phase owns the file)
  - Estimate: medium
  - Kind: config
  - Depends: T5, T6, T7
  - Notes: FR21, AC17, AC18, NFR1. Sequence: (1) `npx pnpm@10 -r run lint` and `npx pnpm@10 -r run
    test` — all green. (2) `npx pnpm@10 -r run build`, then `node scripts/build-dist-package.mjs
    --skip-build` (the script's own `run("pnpm", …)` is the broken binary — hence `--skip-build`).
    (3) Rollback copy: `mkdir -p ~/Library/Caches/claudevid/rollback && (cd
    /opt/homebrew/lib/node_modules/claudevid && npm pack --pack-destination
    ~/Library/Caches/claudevid/rollback)` then rename the result to `claudevid-0.1.0-prev.tgz`.
    (4) Smoke gate: render `packages/claude/examples/tutorial.json` twice into a temp dir — once with
    the installed `claudevid render`, once with `node dist-package/dist/cli.js render` — and compare
    `ffprobe` durations (≤ 0.1 s apart). Do **not** proceed if they differ. (5) `npm install -g
    ./claudevid-0.1.0.tgz`. (6) Prove the swap: `claudevid validate` on a temp spec with
    `scene.audio` (pointing at the T2 sine WAV) succeeds; the same spec against
    `node ~/Library/Caches/claudevid/rollback/…/dist/cli.js validate` (extract the tgz) fails. Report:
    rollback path + exact rollback command, both smoke durations, the T2 decode wall time, and the
    installed `dist/cli.js` sha256 — the verify phase copies these into `verify-report.md`.

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
  - Kind: docs | test | config | refactor | impl | migration   (optional; hints the build subagent's role, tools, and model)
  - Depends: <task ids> (if any)
  - Notes: <additional context>
```

The optional `Kind` hint is consumed by `build.dynamic_agents` (when enabled) to
synthesize a specialized subagent per task. Omit it and build classifies
heuristically, defaulting to `impl`.
