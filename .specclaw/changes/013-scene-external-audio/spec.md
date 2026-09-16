# Spec: Per-scene external audio — drive a scene from a pre-recorded WAV

**Change:** 013-scene-external-audio
**Created:** 2026-09-16
**Status:** 🟡 Draft

## Overview

A scene can name a pre-recorded audio file (`scene.audio.src`) and have it treated exactly like
synthesised Kokoro narration: its measured length drives `duration: "auto"`, it is laid into the
single voice track at the scene's start, and it is muxed by the existing Step G. The dead top-level
`audio.track` is removed so the published schema has one `audio` contract. Every new input path
fails closed: `src` is a validated, spec-relative, contained file path; the decode is bounded and
its output length is checked; `--captions` refuses to silently produce a partially captioned video.

Grounding: the original plan (`docs/Qwen_markdown_20260906_vsjxybyq8.md`) sketched root-level
`"audio": { "voiceover": "voiceover.mp3", "music": "music.mp3", ... }`; change 006 shipped only
the `audio.track` stub of that idea and never wired it. This change realises the *voiceover* half at
scene granularity (where `duration: "auto"` needs it) and deletes the stub; the *music* half stays
a future proposal.

### Open questions resolved during planning

1. **Pad defaults** — schema defaults are **0**. The academy consumer applies its own 0.4 s / 0.6 s
   via `academy_spec.py`; claudevid does not encode a house style.
2. **Flag name** — `--audio-root`. Image layers are out of scope; if a follow-up unifies asset
   roots it can alias the flag.
3. **Fixture** — **no binary fixture is committed.** The real-ffmpeg test generates a 1 s
   44.1 kHz sine WAV at test time with `ffmpeg -f lavfi -i sine=...`, the exact pattern
   `packages/audio/test/mux.test.ts:318` already uses, gated on ffmpeg presence like
   `graph.test.ts:279`.
4. **Version** — stays `0.1.0`. All workspace packages are private, the dist tarball has a single
   known consumer, and `scripts/build-dist-package.mjs` pins `PKG_VERSION = "0.1.0"`. The rollback
   copy is renamed with a `-prev` suffix so the two tarballs cannot collide.
5. **Sidecar shape** — `runRenderPipeline` returns `{ skippedCaptionSceneIds: string[] }`; the
   `render` command writes `<out>.captions-skipped.json` only when the list is non-empty. Keeps the
   pipeline free of a second file-writing seam.

## Requirements

### Functional Requirements

**Schema (`@claudevid/core`)**

- **FR1** — `sceneSchema` accepts an optional `audio` object: `{ src: string; padStart?: number;
  padEnd?: number }`. `src` is non-empty; `padStart`/`padEnd` are `≥ 0` and default to `0` when
  omitted (resolved type has them optional; the pipeline treats `undefined` as `0`).
- **FR2** — `src` must be a plain file path. The schema rejects, with a diagnostic at
  `/scenes/N/audio/src`, any value that contains `://` or matches `^[A-Za-z][A-Za-z0-9+.-]+:`
  (a two-or-more-character URL scheme prefix — `pipe:`, `concat:`, `data:`, `file:`, `http:` …).
  A single-letter prefix (`C:\…`) is not a scheme and is allowed.
- **FR3** — A scene carrying both `narration` and `audio` is rejected by `superRefine` at
  `/scenes/N` with the message `Scene "<id>" has both narration and audio — use one voice source
  per scene` and a repair suggestion naming both fields.
- **FR4** — The top-level `audio` field (`audioSchema`, the exported `AudioTrack` type, and
  `VideoSpec.audio`) is **removed** from `@claudevid/core`. A spec that still carries
  `"audio": { "track": … }` at the root fails validation with Zod's unrecognized-key diagnostic at
  `/audio` (the object schema is strict about unknown keys today; confirm and, if not, add
  `.strict()` to `videoSpecSchema`).
- **FR5** — `Scene` in `types.ts` gains `audio?: SceneAudio`; `SceneAudio` is exported from the
  core index. The generated JSON schema (`generateJsonSchema`) reflects FR1–FR4.

**Path resolution (`@claudevid/cli`)**

- **FR6** — A new pure-logic module `packages/cli/src/scene-audio-paths.ts` exports
  `resolveSceneAudioPaths(spec, { specDir, audioRoot?, statFn?, realpathFn? })`. For every scene
  with `audio`, it resolves `src` against `specDir` when relative (absolute paths are used as
  given), calls `realpathFn`, and requires the result to be an existing **regular file** whose real
  path is inside `realpath(audioRoot ?? specDir)` (path-prefix containment with a trailing
  separator, so `/deck/audio-evil` is not inside `/deck/audio`). It returns either
  `{ ok: true, spec }` — a **new** spec object whose `audio.src` values are the resolved absolute
  real paths — or `{ ok: false, diagnostics }` with one `Diagnostic` per failing scene at
  `/scenes/N/audio/src`, messages distinguishing *not found*, *not a regular file*, and *outside
  the allowed root (<root>)*, each with a suggestion (`move the file under <root> or pass
  --audio-root <dir>`).
- **FR7** — `validate`, `render`, `preview` (single-shot, `--watch`, and `--sheet`), `batch`
  (spec jobs, and prompt jobs whose generated spec is rendered) and `generate --render` call
  `resolveSceneAudioPaths` immediately after a successful `parseSpec`, with `specDir =
  dirname(resolve(specPath))` (for `generate`/`batch` prompt jobs: the directory the spec JSON is
  written to). Diagnostics are printed in the same `path: message, suggestion: …` shape as parse
  diagnostics and the command exits non-zero. A spec with no `audio` scenes passes through
  unchanged.
- **FR8** — `render`, `preview`, `batch` and `generate` accept `--audio-root <dir>`; `validate`
  accepts it too so a validate run reflects the same containment decision a render will make.

**Decoder (`@claudevid/audio`)**

- **FR9** — `packages/audio/src/decode.ts` exports `VOICE_TRACK_SAMPLE_RATE = 24000` (the one place
  the voice track's rate is stated; `tts.ts` documents that Kokoro produces this rate) and
  `decodeAudioFile(src, opts)` returning `Promise<{ audio: Buffer; sampleRate: number;
  durationSeconds: number }>` where `audio` is 16-bit signed little-endian PCM, `opts.channels`
  (default 1) interleaved, at `opts.sampleRate` (default `VOICE_TRACK_SAMPLE_RATE`).
- **FR10** — The decoder spawns `ffmpegPath` (default `"ffmpeg"`) via an injectable `spawnFn` with
  argv exactly `["-nostdin", "-hide_banner", "-loglevel", "error", "-i", src, "-vn", "-f", "s16le",
  "-acodec", "pcm_s16le", "-ac", String(channels), "-ar", String(sampleRate), "pipe:1"]`, stdio
  `["ignore", "pipe", "pipe"]`, and collects stdout into a Buffer and a bounded stderr tail (20
  lines, as `mux.ts`).
- **FR11** — The decode **fails closed** by throwing `DecodeError` (fields: `reason`, `src`,
  `exitCode`, `stderrTail`) when: the spawn errors (`reason: "spawn"`); ffmpeg exits non-zero
  (`"exit"`); wall-clock exceeds `opts.timeoutMs` (default 120 000) — the child is killed
  (`"timeout"`); decoded bytes exceed `opts.maxSeconds` (default 600) × rate × channels × 2 — the
  child is killed (`"too-long"`); the decoded length is below `opts.minSeconds` (default 0.25)
  (`"too-short"`, covers zero-byte-stdout-with-exit-0); or `|decodedSeconds −
  probeDurationSeconds(src)| > opts.durationToleranceSeconds` (default 0.25) (`"duration-mismatch"`).
  The probe uses `mux.ts`'s exported `probeDurationSeconds` through the same `spawnFn`, injectable
  as `opts.probeDurationSecondsFn`.
- **FR12** — `DecodeError`, `decodeAudioFile`, `VOICE_TRACK_SAMPLE_RATE` and the options type are
  exported from `@claudevid/audio`'s index.

**Pipeline (`@claudevid/cli`)**

- **FR13** — `runRenderPipeline` gains an injectable `decodeAudioFn` (default `decodeAudioFile`).
  Step A ("collect scene audio") produces, per scene, either its synthesised narration blocks
  (unchanged) or one decoded block from `scene.audio.src` with `offsetSeconds = padStart ?? 0`,
  `durationSeconds` = decoded length, and a `source: "narration" | "audio"` tag. Every block —
  synthesised or decoded — whose `sampleRate !== VOICE_TRACK_SAMPLE_RATE` causes the pipeline to
  throw naming the scene and both rates, before any frame is rendered.
- **FR14** — For an `audio` scene with `duration: "auto"`, the `audioDurations` entry is
  `padStart + decoded + padEnd`. Placement in `assembleVoiceTrack` is unchanged: the block occupies
  `[sceneStart + padStart, sceneStart + padStart + decoded)` and everything else in the scene window
  is zero-filled silence, so both pads are real quiet air in the muxed track. The existing
  same-scene clamp still truncates a block that runs past its window.
- **FR15** — Two advisory diagnostics (printed via the existing `reportDiagnostics` helper with
  label `audio:`, never fatal): (a) when scene *k+1* has `transition.kind === "cross-fade"` and
  `transition.duration > (padEnd of scene k)` and scene *k* has `audio` — message says the next
  scene's voice will start over this scene's speech; (b) when an `audio` scene has a numeric
  `duration` smaller than `padStart + decoded + padEnd` — message says the audio will be truncated
  at the scene end.
- **FR16** — Decoded blocks are **not** written to or read from the synthesis cache (`cache.ts`);
  a code comment at the decode call site says so and why.
- **FR17** — With `opts.captions === true` and at least one `audio` scene, `runRenderPipeline`
  throws `CaptionsExternalAudioError` **before Step A** naming the scene ids, unless
  `opts.captionsAllowPartial === true`. With allow-partial, `insertCaptionsLayers` receives the
  **full** scene list and skips scenes whose blocks are `source: "audio"` (they have no reference
  text); scene indices and `SceneWindow` lookups are untouched. `runRenderPipeline` returns
  `{ skippedCaptionSceneIds }` (empty when nothing was skipped).
- **FR18** — `render` accepts `--captions-allow-partial`; when the pipeline returns a non-empty
  `skippedCaptionSceneIds`, the command writes `<outPath>.captions-skipped.json` (`{ "skipped":
  [ids] }`) beside the MP4 and includes the count in its success message. `--captions-allow-partial`
  without `--captions` is an `ArgError`.

**Generated assets and docs**

- **FR19** — `pnpm --filter @claudevid/claude run generate-assets` is re-run; the committed
  `packages/claude/schemas/video-spec.schema.json`, its skill copy, and
  `packages/claude/prompts/video-director.md` reflect the new schema. `build-director-prompt.ts`
  gains one sentence: Claude must not emit `scene.audio` unless the user supplied audio files and
  their paths.
- **FR20** — `.claude/skills/video-generator/SKILL.md` gains an "External audio per scene" section:
  when to use it, spec-relative `src` and `--audio-root`, `narration` xor `audio`, pads, the
  fail-closed `--captions` rule and `--captions-allow-partial`, and that `audio.track` no longer
  exists. It says "normalised to the voice track's sample rate", not a number.

**Distribution**

- **FR21** — Build, test and package with `npx pnpm@10` (bare `pnpm` is broken on this machine —
  `.specclaw/learnings.md` L1): `npx pnpm -r run build`, `npx pnpm -r run test`,
  `node scripts/build-dist-package.mjs --skip-build`. Before `npm install -g` of the new tarball,
  copy the currently installed package's tarball (re-pack `/opt/homebrew/lib/node_modules/claudevid`
  with `npm pack`) to `~/Library/Caches/claudevid/rollback/claudevid-0.1.0-prev.tgz`, and record the
  rollback command in `verify-report.md`. Smoke gate: render
  `packages/claude/examples/tutorial.json` with the currently installed `claudevid` and with
  `node dist-package/dist/cli.js`; `ffprobe` durations must agree within 0.1 s before the global
  install proceeds. Record the wall-clock of the real-ffmpeg decode test (FR11's fixture) in
  `verify-report.md` as the measured per-scene decode cost.

### Non-Functional Requirements

- **NFR1** — Existing specs without `audio` scenes parse and render byte-for-byte the same
  timeline: no change to `compileTimeline`, `assembleVoiceTrack`'s placement arithmetic, or the
  synthesis path. The full existing test suite passes unchanged except where FR4 removes the
  `audio.track` acceptance.
- **NFR2** — Every new behaviour is testable without ffmpeg, a model, or the network: the decoder's
  `spawnFn`/`probeDurationSecondsFn`, the path resolver's `statFn`/`realpathFn`, and the
  pipeline's `decodeAudioFn` are injectable. Exactly one test in the change runs real ffmpeg and
  it is skipped when ffmpeg is absent.
- **NFR3** — `parseSpec` stays pure (no filesystem); file existence lives in the CLI layer (FR6).
- **NFR4** — The decoder holds at most `maxSeconds × sampleRate × channels × 2` bytes in memory
  (≈ 28.8 MB at defaults) and one child process per scene, sequentially.
- **NFR5** — No new third-party dependency.

## Acceptance Criteria

- **AC1** — `videoSpecSchema` accepts `{ id, duration: "auto", layers: [], audio: { src:
  "audio/a.wav", padStart: 0.4, padEnd: 0.6 } }`; resolved `scene.audio` equals the input.
- **AC2** — `audio.src` values `"http://x/a.wav"`, `"pipe:0"`, `"concat:a|b"`, `"data:audio/wav;…"`,
  `"file:///a.wav"` are each rejected with a diagnostic whose path is `/scenes/0/audio/src`;
  `"C:\\audio\\a.wav"` and `"./a.wav"` are accepted.
- **AC3** — `padStart: -1` is rejected at `/scenes/0/audio/padStart`.
- **AC4** — A scene with both `narration` and `audio` is rejected at `/scenes/0` with the FR3
  message.
- **AC5** — A spec with root-level `audio: { track: "x.wav" }` is rejected at `/audio`;
  `generateJsonSchema()` output contains `scenes.items.properties.audio` and no top-level
  `properties.audio`.
- **AC6** — `resolveSceneAudioPaths` with fakes: relative `src` resolves against `specDir`;
  absolute `src` is kept; a missing file → diagnostic *not found*; a directory → *not a regular
  file*; a real path outside the root → *outside the allowed root*; `audioRoot` widens the root;
  `/deck/audio-evil/a.wav` is **not** inside root `/deck/audio`; the returned spec is a new object
  and the input is unmodified.
- **AC7** — `runValidate` and `runRender` (with injected deps) report the FR6 diagnostics for a bad
  `src` and exit non-zero; a spec without `audio` is unaffected.
- **AC8** — `decodeAudioFile` with a fake spawn: the argv equals FR10's list exactly; stdout bytes
  become `audio`; `durationSeconds === audio.length / 2 / sampleRate / channels`; non-zero exit →
  `DecodeError` `reason: "exit"` with the stderr tail; exit 0 with zero bytes → `"too-short"`;
  exceeding `maxSeconds` → `"too-long"` and `child.kill` was called; exceeding `timeoutMs` (fake
  timers) → `"timeout"` and `child.kill` was called; probe disagreement beyond tolerance →
  `"duration-mismatch"`.
- **AC9** — Real ffmpeg (skipped when absent): a 1 s 44.1 kHz sine WAV generated at test time
  decodes to `24000 ± 24` samples of mono 16-bit PCM, `sampleRate === 24000`, and passes the probe
  cross-check.
- **AC10** — Pipeline with a fake decoder returning 2 s: an `audio` scene `{ padStart: 0.5, padEnd:
  1 }` with `duration: "auto"` yields a scene window of 3.5 s (105 frames at 30 fps); in the
  assembled voice track the first 0.5 s and last 1 s of that window are zero bytes and the block's
  bytes start at exactly `startFrame/fps + 0.5`.
- **AC11** — A spec mixing a Kokoro scene (fake synth, 24 000 Hz) and an `audio` scene renders
  with `outputDurationSeconds` equal to the sum of both computed durations and a single `voice`
  track.
- **AC12** — A fake decoder returning `sampleRate: 44100` makes the pipeline throw before any
  `renderFrame` call, naming the scene id and both rates.
- **AC13** — `opts.captions: true` with an `audio` scene and no allow-partial throws
  `CaptionsExternalAudioError` naming the scene id before `synthesizeFn`/`decodeAudioFn` are
  called; with `captionsAllowPartial: true` the narrated scene gets exactly one captions layer, the
  `audio` scene gets none, and the return value's `skippedCaptionSceneIds` equals `[audioSceneId]`.
- **AC14** — Advisory diagnostics: (a) `audio` scene with `padEnd: 0.2` followed by a scene with
  `transition: { kind: "cross-fade", duration: 0.5 }` emits one `audio:` warning; with `padEnd:
  0.6` it emits none. (b) `audio` scene with numeric `duration: 1` and a 2 s decoded block emits
  one truncation warning.
- **AC15** — `parseRenderArgs` parses `--captions-allow-partial` and `--audio-root <dir>`; `--captions-allow-partial`
  without `--captions` throws `ArgError`; `runRender` writes `<out>.captions-skipped.json` via the
  injected `writeFile` only when the pipeline reports skips.
- **AC16** — `generated-assets.test.ts` passes after regeneration; the committed schema and skill
  copy are byte-identical; `video-director.md` contains the FR19 sentence.
- **AC17** — `npx pnpm -r run test` and `npx pnpm -r run lint` pass across the workspace.
- **AC18** — The smoke gate passes (tutorial.json durations agree within 0.1 s between old and new
  builds), the rollback tarball exists at the FR21 path, and after `npm install -g`
  `claudevid validate` on a spec with `scene.audio` succeeds while the same spec fails on the
  rollback build — proving the installed binary is the new one.

## Edge Cases

1. **`audio` on a scene with `duration: "auto"` and no decodable audio** (empty WAV): FR11
   `"too-short"` aborts the render with the scene id; no partial MP4 is written (the throw happens
   in Step A, before the encode pipe opens).
2. **Cross-fade longer than `padEnd`**: allowed, FR15(a) warns, audio overlaps as authored.
3. **Numeric `duration` shorter than the audio**: allowed, FR15(b) warns, `assembleVoiceTrack`
   clamps at the scene end (existing behaviour).
4. **Relative `src` and `--watch` re-renders**: resolution uses the spec file's directory each
   time, so a moved spec re-resolves; a moved WAV fails with *not found* on the next render.
5. **Symlinked WAV pointing outside the root**: `realpath` follows it; containment is checked on the
   real path, so it is rejected — by design (containment is about what is read, not what is named).
6. **`--audio-root` given but a `src` is absolute and inside `specDir` yet outside `audioRoot`**:
   rejected — the root, when given, is the only allowed root.
7. **Windows drive-letter paths**: FR2's two-character scheme rule keeps `C:\…` valid; containment
   uses `path.sep`-aware prefix checks.
8. **MP3/FLAC sources**: decode fine through ffmpeg; the probe tolerance (0.25 s) absorbs encoder
   delay/padding. A source whose probe and decode disagree by more than that is rejected as
   corrupt rather than guessed at.
9. **A spec with `audio` scenes run through `preview --sheet`**: `compileTimeline` without
   `audioDurations` throws `MissingAudioDurationError` for `"auto"` scenes exactly as it does for
   narrated scenes today; unchanged, documented.
10. **`generate` producing `scene.audio`**: FR19's prompt sentence forbids it unless the user gave
    paths; if Claude emits one anyway, FR7's resolution fails with *not found* rather than rendering
    silence.

## Dependencies

- ffmpeg and ffprobe on `PATH` (already required by every render).
- No new packages.

## Notes

- Consumer side (separate repo, out of this change): `bistec-process-docs`'s
  `workspace/tools/claudevid/academy_spec.py brand --audio-dir` will write `scene.audio` with
  spec-relative `src` and the academy pads, and its docs switch the claudevid path to the cloned
  voice by default.
- Party findings and their resolutions are recorded in `proposal.md` (Open Questions) and
  `party-report.md`; every upheld BLOCK maps to FR2/FR6 (src), FR11 (decode length), FR17
  (captions ownership).
