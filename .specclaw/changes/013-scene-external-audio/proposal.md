# Proposal: Per-scene external audio — drive a scene from a pre-recorded WAV

**Created:** 2026-09-16
**Status:** 🟡 Draft

## Problem

The only way to put voice on a claudevid video is Kokoro narration. `packages/cli/src/render-pipeline.ts`
synthesises every `scene.narration` block (Step A), sums the measured lengths into the
`audioDurations` record that `duration: "auto"` consumes (Step B), lays the PCM into one
continuous voice-track WAV at each scene's `startFrame` (Step D), and muxes it (Step G). Nothing
else can enter that path.

The one field that looks like it should — the top-level `audio.track` in
`packages/core/src/schema.ts:17` — is declared and exported as `AudioTrack` but never consumed.
Evidence: `grep -rn "\.track\b" packages/cli/src packages/audio/src` returns no matches, and
`grep -n "spec.audio\|audio?.track" packages/cli/dist/*.js` returns nothing but the
`MuxDurationMismatchError` class name. It is a stub.

Concrete consumer: the BISTEC Hearts Academy video pipeline (`bistec-process-docs`,
`.claude/skills/academy-video/SKILL.md` Step 4 and
`docs/superpowers/specs/2026-09-16-academy-sessions-and-claudevid-design.md`) produces per-slide
narration WAVs from cloned-voice backends (NeuTTS Air, OmniVoice, MiMo, Audio8) that reproduce the
presenter's voice. The repo owner's standing requirement, restated on 2026-09-16 when the claudevid
path was adopted ("i need cloned voice"), is that academy videos use that voice. Every one of the
~60 academy decks that pipeline tracks is a candidate; the first claudevid session videos are
blocked on this. Today the only options are:

- **Give up `duration: "auto"`** and compute every scene's numeric duration from the WAV outside
  claudevid, render silent, and mux with ffmpeg afterwards. That re-implements `compileTimeline`'s
  cross-fade overlap arithmetic (`startFrame = frameCursor - overlapFrames`) in a second place. The
  arithmetic has changed once already (change 003 introduced the overlap); a second copy drifts the
  next time it does, and the failure is audio landing on the wrong slide — visible only by watching
  the video.
- **Use Kokoro** and lose the presenter's identity.

Neither is acceptable for a pipeline whose whole point is that the JSON spec is the single source
of truth for timing.

## Proposed Solution

Add an optional **per-scene** `audio` field that behaves exactly like a synthesised narration
block from the timeline's point of view, and delete the dead top-level `audio.track` so the
regenerated schema carries exactly one `audio` contract.

```json
{
  "id": "slide-03-first-test",
  "duration": "auto",
  "audio": { "src": "audio/slide-3-first-test.wav", "padStart": 0.4, "padEnd": 0.6 },
  "layers": [ ... ]
}
```

1. **Schema (`@claudevid/core`).** `sceneSchema` gains
   `audio?: { src: string; padStart?: number ≥ 0; padEnd?: number ≥ 0 }`.
   - `src` is a **plain file path**: the schema rejects any value containing `://` or starting with
     a protocol prefix (`pipe:`, `concat:`, `data:`, `file:` and friends) with a JSON-pointer
     diagnostic at `/scenes/N/audio/src`. Relative paths resolve against the **spec file's
     directory** (not `process.cwd()`), so a committed spec re-renders on any machine.
   - A scene may carry `narration` **or** `audio`, not both — `superRefine` issue at `/scenes/N`
     with a repair suggestion.
   - `audio` with a numeric `duration` is permitted; the voice is clamped to the scene window
     exactly as narration blocks already are (`assembleVoiceTrack`'s same-scene clamp), and the
     pipeline emits an advisory diagnostic when `padStart + decoded + padEnd` exceeds the fixed
     duration.
   - The top-level `audioSchema` / `AudioTrack` export and `VideoSpec.audio` are **removed**. No
     shipped example or test uses them; the dist README never documented them.
   - `Scene` in `types.ts` gains `SceneAudio`; the JSON schema regenerates via
     `pnpm --filter @claudevid/claude run generate-assets` (drift-checked by
     `generated-assets.test.ts`).
2. **Path resolution and existence (`@claudevid/cli`).** `parseSpec` stays pure (no filesystem).
   A new `resolveSceneAudioPaths(spec, specDir)` step in the CLI, run by `validate`, `render`,
   `preview` and `batch` immediately after `parseSpec`, resolves each `src` against the spec's
   directory, `realpath`s it, requires it to be an existing regular file, and requires containment
   under the spec directory or an explicit `--audio-root <dir>` flag. Failures are reported as
   JSON-pointer diagnostics in the same shape as parse failures, before any synthesis or decode
   runs. Absolute paths are accepted only when they pass the containment check.
3. **Decoder (`@claudevid/audio`).** New `decodeAudioFile(src, opts, spawnFn)` runs
   `ffmpeg -nostdin -i <src> -f s16le -acodec pcm_s16le -ac <channels> -ar <sampleRate> pipe:1`
   and returns `{ audio: Buffer, sampleRate }` — the shape `synthesize()` returns. Options:
   `sampleRate` (defaults to the new exported constant `VOICE_TRACK_SAMPLE_RATE = 24000` in
   `@claudevid/audio`, the single place Kokoro's rate is stated), `channels` (default 1, so the
   deferred music bed can reuse this decoder), `timeoutMs` (default 120 000), `maxSeconds`
   (default 600). The decode **fails closed**: `DecodeError` on non-zero exit, on spawn error, on
   timeout or byte-cap (child killed), when the decoded buffer is shorter than 0.25 s, and when the
   decoded sample count disagrees with `ffprobe`'s reported duration for the same file by more than
   0.1 s. Spawn is injectable, mirroring `probe.ts`/`mux.ts`. `DecodeError` carries a bounded
   stderr tail like `MuxError`; it is an abort path and is never fed to the model repair loop.
4. **Pipeline (`@claudevid/cli`).** Step A becomes "collect scene audio": for each scene, either
   synthesise its narration blocks (unchanged) or decode its resolved `audio.src` at
   `VOICE_TRACK_SAMPLE_RATE`. If any synthesised block ever reports a different rate the pipeline
   raises rather than adopting it (today's `assembleVoiceTrack` behaviour, now stated). The decoded
   block is stored with `offsetSeconds = padStart`; the scene's measured duration is
   `padStart + decoded + padEnd`. **Both pads are real silence in the assembled voice track**: the
   block occupies `[start + padStart, start + padStart + decoded)` and the rest of the window is
   zero-filled, so `padEnd` is genuinely quiet air. A cross-fade into the next scene overlaps the
   tail of this window; an advisory diagnostic is emitted when the next scene's
   `transition.duration` exceeds this scene's `padEnd`, because the next voice would then start
   over this scene's speech. Decoded blocks **do not participate in the synthesis cache**
   (`cache.ts` is keyed on narration text; a decode is a local file read and needs no cache).
5. **Captions.** `--captions` **fails closed** when any scene carries `audio`: the render stops
   before synthesis with a diagnostic naming the scenes. A new `--captions-allow-partial` flag
   renders with captions on narrated scenes only and writes the skipped scene ids to
   `<out>.captions-skipped.json` beside the MP4. The skip is owned by `render-pipeline.ts`'s
   `insertCaptionsLayers`, which receives the **full** scene list and skips `audio` scenes inline —
   scene indices and `SceneWindow` lookups stay stable because nothing is filtered.
6. **Docs.** `.claude/skills/video-generator/SKILL.md` gets an "External audio per scene" section
   (when to use it, spec-relative paths and `--audio-root`, mutual exclusion with `narration`, pads,
   the fail-closed captions rule). Prose says "normalised to the voice track's rate", not a number.
7. **Distribution.** `pnpm build`, `pnpm test`, `pnpm package`. Before `npm install -g` of the new
   tarball: copy the currently installed package to `dist-package/rollback/claudevid-0.1.0-prev.tgz`
   (rollback: `npm install -g <that path>`), and smoke-render `packages/claude/examples/tutorial.json`
   with the current global and the new build, asserting equal `ffprobe` durations. The load-bearing
   slice is items 1–5; items 6–7 can trail without affecting anyone who has not yet adopted the
   field, but this change ships them together because the consumer is waiting on the install.

## Scope

### In Scope
- `packages/core/src/schema.ts`, `types.ts`: `SceneAudio` schema/type; `src` protocol-prefix
  rejection; narration-xor-audio refinement; removal of `audioSchema`/`AudioTrack`/`VideoSpec.audio`.
- `packages/cli/src/scene-audio-paths.ts` (new): spec-relative resolution, existence, containment,
  `--audio-root`; wired into `validate`, `render`, `preview`, `batch`.
- `packages/audio/src/decode.ts` (new) + `VOICE_TRACK_SAMPLE_RATE` + exports: ffmpeg-backed decoder
  with injectable spawn, timeout, byte cap, minimum-length floor, ffprobe cross-check, `DecodeError`.
- `packages/cli/src/render-pipeline.ts`: Step A extension, `decodeAudioFn` seam, pads as silence,
  overlap-vs-`padEnd` and fixed-duration-overrun advisory diagnostics, captions fail-closed +
  `--captions-allow-partial` + skipped-ids sidecar; `commands/render.ts` flag parsing.
- Tests: `core/test/schema.test.ts` (accept; reject both; reject negative pad; reject `://` and
  protocol prefixes with the right JSON pointer; `audio.track` no longer accepted),
  `cli/test/scene-audio-paths.test.ts` (relative resolution, missing file, containment escape,
  `--audio-root`), `audio/test/decode.test.ts` (fake spawn: argv shape incl. `-nostdin`, stdout →
  buffer, non-zero exit, zero-byte stdout with exit 0 → `DecodeError`, timeout, byte cap; plus one
  **real-ffmpeg** test decoding a checked-in 1 s 44.1 kHz fixture and asserting sample count and
  rate, gated on ffmpeg presence like `mux.test.ts`), `cli/test/render-pipeline.test.ts` (fake
  decoder: auto duration = pads + decoded; placement at `startFrame/fps + padStart`; silence in the
  pad regions; mixed Kokoro + external scene; captions fail-closed; `--captions-allow-partial`
  skips and writes the sidecar; overlap > padEnd diagnostic).
- Regenerated schema (both copies) and prompt via `generate-assets`.
- Skill documentation; dist README.
- Build, test, package, rollback copy, smoke gate, global reinstall. Decode cost is measured once
  on the fixture during build and recorded in `verify-report.md`.

### Out of Scope
- A music bed / background track. `audio.track` is deleted here; a future proposal reintroduces
  whole-video audio under a role-named key and reuses `decodeAudioFile` (channels option) as its
  input path.
- Per-scene gain, fades, or ducking.
- Forced alignment / captions for external audio (would need a `transcript` field).
- Changing `image` layers' `src` resolution (still `process.cwd()`); a follow-up should move them
  to the same spec-relative rule.
- Any change to Kokoro synthesis, chunking, or the synthesis cache.

## Impact

- **Files affected:** ~16 — `schema.ts`, `types.ts`, `decode.ts`, `audio/index.ts`,
  `scene-audio-paths.ts`, `render-pipeline.ts`, `commands/render.ts` (+ `validate`/`preview`/`batch`
  wiring), five test files + one WAV fixture, generated schema (two copies) + prompt, `SKILL.md`.
- **Complexity:** medium
- **Risk:** low–medium — additive field; existing specs render identically. The one removal
  (`audio.track`) has no known consumer (grep above). Shared seam touched: `assembleVoiceTrack`,
  guarded by the single rate constant and existing tests. Decode is fail-closed on every path the
  panel named.

## Open Questions

1. **Pad defaults.** `padStart`/`padEnd` default to 0 in the schema; the 0.4 s / 0.6 s values are the
   academy consumer's convention (`academy-revideo-author.md` rule 9, "~1 s dead air"), applied by
   its own `academy_spec.py`, not by claudevid. Confirm no claudevid-side default is wanted.
2. **`--audio-root` name.** Alternatives: `--assets-root`, anticipating the image-layer follow-up.
3. **Fixture licensing.** The 1 s WAV fixture will be a generated sine tone, so no licence question;
   confirm a binary test fixture is acceptable in the repo.

### Party panel — upheld findings (verdict: CHANGES_REQUESTED, see party-report.md)

- (party-security) [BLOCK] `audio.src` is an unconstrained string handed to `ffmpeg -i`: a spec can name a URL, `pipe:`/`concat:` protocol, `/dev/*`, or any local file; needs schema-level validation, `realpath`, and containment under an allow-listed root — see party-report.md
- (party-security) [BLOCK] A decode that exits 0 with empty/truncated PCM yields a green render with a ~1 s silent scene; decoded length must be a checked value (floor + ffprobe cross-check) — see party-report.md
- (party-architect) [BLOCK] `--captions` skip names no owning module: does `insertCaptionsLayers` get a filtered scene list or an exclusion set, and which keeps indices stable? — see party-report.md
- (party-architect) [WARN] `padEnd` is specified only as a duration term; state whether it reserves silence in the voice track and what happens when `overlapFrames` exceeds it — see party-report.md
- (party-architect) [WARN] `audio` with a numeric `duration` parses but its overrun rule is unstated; `src` existence is checked on the wrong side of the parse/decode seam — see party-report.md
- (party-architect) [WARN] Decoded blocks bypass the synthesis cache while the cache is out of scope; say so explicitly or define their cache key — see party-report.md
- (party-architect) [NOTE] Add one real-ffmpeg fixture test asserting decoded sample count and rate — see party-report.md
- (party-security) [WARN] `--captions` with external-audio scenes reports success while producing a partially captioned video; fail closed by default with an explicit opt-in — see party-report.md
- (party-security) [WARN] The decode spawn has no timeout, no output cap, and buffers the whole stream in memory — see party-report.md
- (party-security) [WARN] The global CLI reinstall has no stated rollback or pre-install smoke gate — see party-report.md
- (party-security) [NOTE] Keep one exported sample-rate constant in `@claudevid/audio`; error, never adopt, when a synthesised block reports a different rate — see party-report.md
- (party-visionary) [WARN] The scene key `audio` is a permanent commitment while root-level `audio.track` is undecided; decide `audio.track` now or name the scene field by role — see party-report.md
- (party-visionary) [WARN] Copying the `process.cwd()` rule bakes machine-absolute paths into specs; resolve `src` relative to the spec file — see party-report.md
- (party-visionary) [WARN] A hard-coded 24 000 Hz at the decode call site duplicates what the synthesiser reports and is restated in prose docs — see party-report.md
- (party-visionary) [NOTE] Take channels as a decoder option now and name `decodeAudioFile` as the entry point for the deferred music bed — see party-report.md
- (party-ba) [WARN] The "never read anywhere" claim about `audio.track` cites no grep or test — see party-report.md
- (party-ba) [WARN] The Hearts Academy cloned-voice requirement is asserted without an artifact — see party-report.md
- (party-ba) [WARN] Relative-path handling depends on authors reading docs; no criterion for a relative `src` — see party-report.md
- (party-ba) [NOTE] The 0.4 s / 0.6 s pad defaults are asserted as universal without a source — see party-report.md
- (party-po) [WARN] The value of the change is asserted, not sized (videos on the workaround, drift frequency, drift cost) — see party-report.md
- (party-po) [NOTE] No cut line between the load-bearing slice (schema + decoder + pipeline) and docs/reinstall — see party-report.md
- (party-po) [NOTE] Per-scene ffmpeg decode adds an unmeasured per-render cost — see party-report.md

---

**To proceed:** Review this proposal and approve to begin planning.
