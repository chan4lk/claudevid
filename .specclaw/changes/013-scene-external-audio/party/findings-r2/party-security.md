### [BLOCK] party-security — `audio.src` is an unconstrained string handed straight to `ffmpeg -i`, so a spec can make the renderer read any local file or fetch any URL and embed it in the output

**Quotes:**
> `sceneSchema` gains `audio?: { src: string (min 1); padStart?: number ≥ 0; padEnd?: number ≥ 0 }`
> New `decodeAudioFile(src, { sampleRate }, spawnFn)` runs `ffmpeg -i <src> -f s16le -acodec pcm_s16le -ac 1 -ar <sampleRate> pipe:1`
> ffmpeg is already a hard requirement of every render, so this adds no dependency and accepts any container/rate ffmpeg can read (WAV at 24 k or 44.1 k, MP3, FLAC).
> Resolving relative `src` paths against the spec file's directory. Image layers today resolve against `process.cwd()`; this change keeps the same rule and documents "use absolute paths".

**Problem:** The only stated validation on `src` is `min 1`. `ffmpeg -i` does not take filesystem paths — it takes a protocol URL, and the design explicitly advertises "any container ffmpeg can read". A spec (authored by Claude from a skill, not hand-typed by the operator) can therefore set `src` to `http://…`, `concat:`, `pipe:`, `/dev/…`, or any absolute path on the machine, and the renderer will read it and mux the result into a video the operator then uploads to YouTube. That is arbitrary local-file read and outbound network egress reached from a JSON field with no check, plus a data-exfiltration path via the published artifact. Round 1 sharpened rather than weakened this: `party-architect` independently observes that `src` is "validated as a non-empty string only", and `party-ba` and `party-visionary` both flag that the relative-path rule rests on prose ("documents 'use absolute paths'") with no guard and no stated behaviour on a bad path.

**Fix:** Validate `src` in the schema before it reaches spawn: reject any value containing `://` or a leading `pipe:`/`concat:`/`data:` protocol prefix, require it to resolve to an existing regular file, and `realpath` it and require containment under an allow-listed root (spec file's directory, or an explicit `--audio-root` flag) — failing closed with a JSON-pointer diagnostic when it does not. If remote sources are ever wanted, they should be an explicit opt-in flag, not the default surface of a free-form string.

**Status:** upheld

### [BLOCK] party-security — A decode that succeeds with empty or truncated PCM produces a green render with a silent one-second scene, indistinguishable from success

**Quotes:**
> The decoded block is stored with `offsetSeconds = padStart` and its scene's measured duration is `padStart + decoded + padEnd`.
> `audio/test/decode.test.ts` (fake spawn: argv shape, stdout → buffer, non-zero exit → `DecodeError`)
> Steps B, D and G need no change beyond the block source; `duration: "auto"` and cross-fade placement come for free.

**Problem:** The only named failure detection is ffmpeg's exit code. ffmpeg exits 0 in cases that yield little or no PCM on stdout — a container whose audio stream is empty, a stream that ends early, a truncated read of `pipe:1`, a source whose audio ffmpeg silently drops. In every such case `decoded ≈ 0`, the scene's `duration: "auto"` resolves to `padStart + padEnd` (1.0 s in the proposal's own example), the timeline compiler places it happily, the mux succeeds, and the render exits 0. The failure mode is a full-length video where one slide flashes past in a second with no voice, and nothing in the design distinguishes that from a correct run. `party-architect`'s NOTE that the only decoder tests compare argv to the same literal the implementation writes reinforces this: the byte-yield of the spawn is nowhere checked, so both the wrong-argv and the empty-stdout cases pass the listed suite.

**Fix:** Treat the decoded length as a checked value, not a measurement: raise `DecodeError` when the decoded buffer is empty or below a floor (e.g. < 0.25 s of PCM at the target rate), and cross-check the decoded sample count against `ffprobe`'s reported stream duration for the same file, failing closed on a mismatch beyond a small tolerance. Add the zero-byte-stdout-with-exit-0 case to `decode.test.ts`.

**Status:** upheld

### [WARN] party-security — ffmpeg stderr from an arbitrary source file is placed in a diagnostic that feeds Claude's repair loop

**Quotes:**
> `packages/audio/src/decode.ts` (+ export from `index.ts`): ffmpeg-backed decoder with injectable spawn; `DecodeError` carrying the ffmpeg stderr tail like `MuxError`.
> a `superRefine` issue at `/scenes/N` with a repair suggestion, so the diagnostic reaches Claude's repair loop like every other parse failure.

**Problem:** I joined two mechanisms the artifact keeps separate. The only quoted line placing a diagnostic into the model repair loop describes the `superRefine` *parse* issue; `DecodeError` is described only as an error carrying a stderr tail, with no quoted text routing it to the loop. `party-architect`'s round-1 WARN makes the distinction explicit — it treats parse-time checks as the ones "reaching the repair loop" and decode-time failures as "a `DecodeError` abort" — which is the reading the proposal's own text supports. With no quoted entry point from ffmpeg stderr into model-read context, this is a speculative path, and evidence discipline says drop it rather than hedge it.

**Fix:** n/a — withdrawn.

**Status:** withdrawn — the artifact routes only the `superRefine` parse diagnostic into the repair loop; no quoted line puts `DecodeError`'s stderr tail in front of the model, and `party-architect` reads decode failures as an abort path. No quoted entry point, so the finding does not stand.

### [WARN] party-security — `--captions` silently produces a partially-captioned video and still exits green

**Quotes:**
> `insertCaptionsLayers` requires reference text for forced alignment; an external audio scene has none, so `--captions` skips those scenes and prints one warning naming them.
> **`--captions` on a spec with external audio: skip with a warning (proposed) or hard error?**

**Problem:** The operator asked for captions and gets a video where some scenes have none, with a single stderr line as the only signal — buried in a render that already emits ffmpeg output, and with an exit code the proposal does not change. The output artifact is a normal MP4; nothing in it or beside it records that captioning was reduced in scope. For an accessibility feature on academy deliverables headed to YouTube, "quietly did less than asked, reported success" is the failure that gets shipped. `party-architect`'s BLOCK on the same clause raises the stakes: because the artifact does not say whether `insertCaptionsLayers` receives a filtered list or an exclusion set, the skip can also *misalign* captions on the Kokoro scenes that follow — a second silent wrong-output path behind the same green exit code.

**Fix:** Fail closed by default: with `--captions` and any external-audio scene present, error before rendering and name the scenes, with an explicit `--captions-allow-partial` opt-in for the skip behaviour. When the skip does run, exit non-zero or write the skipped scene ids into a machine-readable artifact beside the MP4 so the degradation survives the terminal scrollback.

**Status:** upheld

### [WARN] party-security — The decode spawn has no timeout, no output size cap, and buffers the whole stream in memory

**Quotes:**
> New `decodeAudioFile(src, { sampleRate }, spawnFn)` runs `ffmpeg -i <src> -f s16le -acodec pcm_s16le -ac 1 -ar <sampleRate> pipe:1` and returns `{ audio: Buffer, sampleRate }`
> `packages/cli/src/render-pipeline.ts`: Step A extension, `decodeAudioFn` seam in `RenderPipelineOptions`, captions skip + warning.

**Problem:** The decoder accumulates an unbounded `Buffer` from a subprocess reading a source the spec names. A long or endless input — a large archive-grade file, a `/dev/` character device, or a network stream given finding 1's surface — fills memory or hangs Step A forever with no wall-clock bound. There is no stated timeout, no maximum decoded-seconds limit, and no per-render aggregate cap, so one bad `src` takes down the render process rather than failing that scene. `party-po`'s NOTE on per-render decode cost observes the same unbounded spawn from the cost side; the failure-mode side is that nothing kills it.

**Fix:** Bound the spawn with a kill-after timeout and a maximum decoded byte count (derived from a `maxSceneSeconds` at the fixed 24 kHz rate); on exceeding either, kill the child and raise `DecodeError` naming the limit hit. Stream the PCM to a temp file rather than holding the full buffer if scene lengths are expected to be large.

**Status:** upheld

### [WARN] party-security — The scoped work overwrites the operator's globally installed CLI with no stated rollback

**Quotes:**
> `pnpm build`, `pnpm test`, `pnpm package` and a reinstall of the global `claudevid` from the new tarball so consumers pick the feature up.

**Problem:** This is an effect that leaves the change: the globally installed `claudevid` on the machine is replaced, affecting every other pipeline that shells out to it — including academy video builds unrelated to this feature. The proposal names no version pin, no retention of the prior tarball, and no verification step after install, so if the new build regresses an existing spec the operator has no stated path back to the working binary beyond rebuilding from an unspecified earlier commit. The self-assessed "existing specs parse and render identically" is asserted, not gated by a run against an existing spec. `party-po`'s NOTE proposes the reinstall could trail as a fast-follow, which is a scope argument; it does not supply the missing recovery path, so this stands either way.

**Fix:** State the recovery path in the proposal: keep the prior tarball (or record its exact version) before the global reinstall, and make the rollback command explicit. Gate the reinstall on a smoke render of one pre-existing, audio-free spec producing a duration-identical result to the current global build — narrowest grant being a local `pnpm link` for validation before any global replacement.

**Status:** upheld

### [NOTE] party-security — Rebuttal of party-visionary: deriving the decode rate from the synthesiser's reported rate replaces a fail-closed constant with an input-dependent one

**Quotes:**
> or decode its `audio.src` at **24 000 Hz** — Kokoro's native rate — so `assembleVoiceTrack`'s one-sample-rate rule holds when a spec mixes Kokoro and
>    external scenes.
> 2. **Decode rate: fixed 24 000 Hz, or "adopt the first block's rate"?** Fixed is simpler and
>    matches Kokoro; the only cost is downsampling 44.1 kHz sources, inaudible for speech.

**Problem:** `party-visionary`'s fix — "Derive the decode rate from the synthesiser's reported `sampleRate`" — is sound on the duplication lens but, read as a failure mode, it converts a constant the pipeline controls into a value that depends on what the run happens to contain. A spec with no narration blocks has no synthesiser-reported rate to derive from, and a future backend reporting a different rate makes the external scene's decode rate vary per spec while `assembleVoiceTrack` still enforces one rate across the track — the mismatch surfaces as wrong-pitch or wrong-length audio in a rendered MP4, not as an error. The fixed literal is the fail-closed choice precisely because it cannot be moved by spec content. The duplication objection is legitimate; the remedy should not be to make the rate data-derived.

**Fix:** Keep a single exported constant in `@claudevid/audio` that both the synthesiser and the decoder read (the second half of party-visionary's own fix), and if a synthesised block ever reports a rate other than that constant, raise an error rather than adopting it. That removes the duplication without making the track's sample rate a function of untrusted spec content.

**Status:** upheld
