### [BLOCK] party-security — `audio.src` is an unconstrained string handed straight to `ffmpeg -i`, so a spec can make the renderer read any local file or fetch any URL and embed it in the output

**Quotes:**
> `sceneSchema` gains `audio?: { src: string (min 1); padStart?: number ≥ 0; padEnd?: number ≥ 0 }`
> New `decodeAudioFile(src, { sampleRate }, spawnFn)` runs `ffmpeg -i <src> -f s16le -acodec pcm_s16le -ac 1 -ar <sampleRate> pipe:1`
> ffmpeg is already a hard requirement of every render, so this adds no dependency and accepts any container/rate ffmpeg can read (WAV at 24 k or 44.1 k, MP3, FLAC).
> Resolving relative `src` paths against the spec file's directory. Image layers today resolve against `process.cwd()`; this change keeps the same rule and documents "use absolute paths".

**Problem:** The only stated validation on `src` is `min 1`. `ffmpeg -i` does not take filesystem paths — it takes a protocol URL, and the design explicitly advertises "any container ffmpeg can read". A spec (which in this pipeline is authored by Claude from a skill, not hand-typed by the operator) can therefore set `src` to `http://…`, `concat:`, `pipe:`, `/dev/…`, or any absolute path on the machine, and the renderer will read it and mux the result into a video the operator then uploads to YouTube. That is arbitrary local-file read and outbound network egress reached from a JSON field with no check, plus a data-exfiltration path via the published artifact. The relative-path rule makes it worse in the quiet direction: a relative `src` silently resolves against whatever `process.cwd()` happened to be, so the same spec decodes a different file depending on invocation directory, and "documents 'use absolute paths'" is a comment, not a guard.

**Fix:** Validate `src` in the schema before it reaches spawn: reject any value containing `://` or a leading `pipe:`/`concat:`/`data:` protocol prefix, require it to resolve to an existing regular file, and `realpath` it and require containment under an allow-listed root (spec file's directory, or an explicit `--audio-root` flag) — failing closed with a JSON-pointer diagnostic when it does not. If remote sources are ever wanted, they should be an explicit opt-in flag, not the default surface of a free-form string.

**Status:** upheld

### [BLOCK] party-security — A decode that succeeds with empty or truncated PCM produces a green render with a silent one-second scene, indistinguishable from success

**Quotes:**
> The decoded block is stored with `offsetSeconds = padStart` and its scene's measured duration is `padStart + decoded + padEnd`.
> `audio/test/decode.test.ts` (fake spawn: argv shape, stdout → buffer, non-zero exit → `DecodeError`)
> Steps B, D and G need no change beyond the block source; `duration: "auto"` and cross-fade placement come for free.

**Problem:** The only named failure detection is ffmpeg's exit code. ffmpeg exits 0 in cases that yield little or no PCM on stdout — a container whose audio stream is empty, a stream that ends early, a truncated read of `pipe:1`, a source whose audio ffmpeg silently drops. In every such case `decoded ≈ 0`, the scene's `duration: "auto"` resolves to `padStart + padEnd` (1.0 s in the proposal's own example), the timeline compiler places it happily, the mux succeeds, and the render exits 0. The failure mode is a full-length video where one slide flashes past in a second with no voice, and nothing in the design distinguishes that from a correct run — the artifact is a valid MP4 and there is no warning, no non-zero exit, no recorded state. Because `duration: "auto"` hands timeline control to the decoded length, a partial decode also silently shortens the whole video. The listed tests cover only `stdout → buffer` and `non-zero exit → DecodeError`, so this path is untested by construction.

**Fix:** Treat the decoded length as a checked value, not a measurement: raise `DecodeError` when the decoded buffer is empty or below a floor (e.g. < 0.25 s of PCM at the target rate), and cross-check the decoded sample count against `ffprobe`'s reported stream duration for the same file, failing closed on a mismatch beyond a small tolerance. Add the zero-byte-stdout-with-exit-0 case to `decode.test.ts`.

**Status:** upheld

### [WARN] party-security — ffmpeg stderr from an arbitrary source file is placed in a diagnostic that feeds Claude's repair loop

**Quotes:**
> `packages/audio/src/decode.ts` (+ export from `index.ts`): ffmpeg-backed decoder with injectable spawn; `DecodeError` carrying the ffmpeg stderr tail like `MuxError`.
> a `superRefine` issue at `/scenes/N` with a repair suggestion, so the diagnostic reaches Claude's repair loop like every other parse failure.

**Problem:** ffmpeg's stderr tail is not program-authored text — it echoes container metadata, stream titles, and (for the network sources finding 1 leaves reachable) remote server output, all drawn from the file named by `src`. The proposal routes parse/decode diagnostics into a model repair loop. That is attacker-influenceable content crossing into a position where a model reads it as instruction-adjacent context, and the loop's remedy is for the model to rewrite the very `src` field that caused the failure — so the party whose output is being validated also authors the fix that makes the gate pass. Unlike the `superRefine` case, the stderr tail has no bounded vocabulary.

**Fix:** Before embedding, truncate the stderr tail to a fixed byte budget, strip control characters, and wrap it in an explicitly-marked untrusted delimiter block in the diagnostic. Keep the repair suggestion itself program-authored (a fixed string keyed to the error class), and do not let decode-error text be the thing the loop reasons from when choosing a new `src`.

**Status:** upheld

### [WARN] party-security — `--captions` silently produces a partially-captioned video and still exits green

**Quotes:**
> `insertCaptionsLayers` requires reference text for forced alignment; an external audio scene has none, so `--captions` skips those scenes and prints one warning naming them.
> **`--captions` on a spec with external audio: skip with a warning (proposed) or hard error?**

**Problem:** The operator asked for captions and gets a video where some scenes have none, with a single stderr line as the only signal — buried in a render that already emits ffmpeg output, and with an exit code the proposal does not change. The output artifact is a normal MP4; nothing in it or beside it records that captioning was reduced in scope. For an accessibility feature on academy deliverables headed to YouTube, "quietly did less than asked, reported success" is the failure that gets shipped. This is the degraded-scope-with-green-result shape, and the proposal itself flags it as unresolved.

**Fix:** Fail closed by default: with `--captions` and any external-audio scene present, error before rendering and name the scenes, with an explicit `--captions-allow-partial` opt-in for the skip behaviour. When the skip does run, exit non-zero or write the skipped scene ids into a machine-readable artifact beside the MP4 so the degradation survives the terminal scrollback.

**Status:** upheld

### [WARN] party-security — The decode spawn has no timeout, no output size cap, and buffers the whole stream in memory

**Quotes:**
> New `decodeAudioFile(src, { sampleRate }, spawnFn)` runs `ffmpeg -i <src> -f s16le -acodec pcm_s16le -ac 1 -ar <sampleRate> pipe:1` and returns `{ audio: Buffer, sampleRate }`
> `packages/cli/src/render-pipeline.ts`: Step A extension, `decodeAudioFn` seam in `RenderPipelineOptions`, captions skip + warning.

**Problem:** The decoder accumulates an unbounded `Buffer` from a subprocess reading a source the spec names. A long or endless input — a large archive-grade file, a `/dev/` character device, or a network stream given finding 1's surface — fills memory or hangs Step A forever with no wall-clock bound. There is no stated timeout, no maximum decoded-seconds limit, and no per-render aggregate cap, so one bad `src` takes down the render process rather than failing that scene.

**Fix:** Bound the spawn with a kill-after timeout and a maximum decoded byte count (derived from a `maxSceneSeconds` at the fixed 24 kHz rate); on exceeding either, kill the child and raise `DecodeError` naming the limit hit. Stream the PCM to a temp file rather than holding the full buffer if scene lengths are expected to be large.

**Status:** upheld

### [WARN] party-security — The scoped work overwrites the operator's globally installed CLI with no stated rollback

**Quotes:**
> `pnpm build`, `pnpm test`, `pnpm package` and a reinstall of the global `claudevid` from the new tarball so consumers pick the feature up.

**Problem:** This is an effect that leaves the change: the globally installed `claudevid` on the machine is replaced, affecting every other pipeline that shells out to it — including academy video builds unrelated to this feature. The proposal names no version pin, no retention of the prior tarball, and no verification step after install, so if the new build regresses an existing spec the operator has no stated path back to the working binary beyond rebuilding from an unspecified earlier commit. The self-assessed "existing specs parse and render identically" is asserted, not gated by a run against an existing spec.

**Fix:** State the recovery path in the proposal: keep the prior tarball (or record its exact version) before the global reinstall, and make the rollback command explicit. Gate the reinstall on a smoke render of one pre-existing, audio-free spec producing a byte-identical or duration-identical result to the current global build — narrowest grant being a local `pnpm link` for validation before any global replacement.

**Status:** upheld
