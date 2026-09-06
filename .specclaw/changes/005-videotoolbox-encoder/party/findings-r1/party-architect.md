### [BLOCK] party-architect — FFmpeg argument construction is split across three modules while the design's own correctness invariant requires a single owner
**Quotes:** > - `packages/encoder-ffmpeg/src/profiles.ts` — the profile table above, flag construction
**Quotes:** > `-fps_mode passthrough` so every frame we produce is exactly one frame in the output, bt709 primaries/trc/colorspace tagging, `-pix_fmt yuv420p`, `-movflags +faststart`.
**Quotes:** > - Each chunk starts on a **forced keyframe** (`-force_key_frames 0`, `-g` set to the chunk length) so stream-copy concatenation is lossless and seamless.
**Quotes:** > - Encoder parameters are byte-identical across chunks — any drift makes `concat -c copy` fail or produce a broken stream.
**Problem:** The artifact names `profiles.ts` as the owner of "flag construction", then specifies a second set of flags in the pipe layer (`-fps_mode`, colour tagging, `-pix_fmt`, `-movflags`) and a third set in the chunk layer (`-force_key_frames`, `-g`). Three modules each contribute to one argv. The proposal simultaneously states the invariant that makes chunking work — byte-identical encoder parameters across chunks — which is exactly the invariant that a three-way-split argv builder cannot enforce, because no single component sees the whole command line. The first flag added in `pipe.ts` for the single-pipe path and not mirrored in the chunk path produces a concat failure or a broken stream, which the proposal itself classifies as the highest-risk failure class.
**Fix:** Name one component that emits the complete argv for a given profile+mode, have `pipe.ts`, `chunk.ts` and `concat.ts` consume it rather than append to it, and state that the chunk path and single-pipe path differ only in inputs, not in flags.
**Status:** upheld

### [BLOCK] party-architect — The chunk cache key omits the encoder parameters the concat invariant depends on
**Quotes:** > A chunk whose input hash (its slice of the timeline + render settings + asset hashes) matches an existing artifact is skipped and reused.
**Quotes:** > - Encoder parameters are byte-identical across chunks — any drift makes `concat -c copy` fail or produce a broken stream.
**Quotes:** > At startup, probe the FFmpeg binary: presence, version, and which of `h264_videotoolbox` / `hevc_videotoolbox` / `prores_ks` / `libx264` are available.
**Problem:** The hash inputs are enumerated exhaustively — timeline slice, render settings, asset hashes — and none of them is the encoder profile, the resolved codec, the bitrate, or the FFmpeg/encoder version that the probe explicitly reads. A resume that hits stale artifacts encoded under a different profile, or by a different FFmpeg build after an upgrade, produces a chunk set that is not byte-identical in encoder parameters, which is the precise condition the proposal says makes `concat -c copy` fail or emit a broken stream. Worse, the failure mode is the silent one: the concat may succeed and the seam be wrong. Two implementers reading "render settings" will disagree about whether encoder flags are inside it.
**Fix:** State explicitly that the cache key covers the resolved encoder argv plus the probed FFmpeg/encoder version identity, or state that cached artifacts are invalidated wholesale when the probe result changes.
**Status:** upheld

### [BLOCK] party-architect — Two components are given contradictory lifecycle ownership of the same chunk files
**Quotes:** > - `packages/encoder-ffmpeg/src/cache.ts` — content-addressed chunk artifacts, resume
**Quotes:** > - `packages/encoder-ffmpeg/src/temp.ts` — temp dir lifecycle, cleanup, signal handling
**Quotes:** > **6. Process hygiene.** Deterministic temp directories, guaranteed cleanup on success and failure, cancellation that propagates SIGTERM to every child, and no orphaned FFmpeg processes after a Ctrl-C.
**Quotes:** > - **Where does resume state live?** `.claudevid/cache/` in the project, or a user-level cache?
**Problem:** Chunk artifacts are the output of the encode and the input to resume. `temp.ts` is specified to guarantee cleanup on both success and failure; `cache.ts` is specified to keep those same artifacts so that "iterating on scene 43 of 200 then costs one chunk, not 200". As written, the two modules land in the same commit with opposite mandates over the same files, and the location question is still open, so an implementer has no rule telling them which files are temp and which are cache. The likely outcome is either a resume feature that never hits (cleanup wins) or a leaked artifact directory that process hygiene was written to prevent (cache wins).
**Fix:** Draw the boundary in the artifact: name which paths `temp.ts` owns and deletes unconditionally, name which paths `cache.ts` owns and never deletes on the encode path, and state how a chunk artifact is promoted from one to the other.
**Status:** upheld

### [BLOCK] party-architect — CLI surface is introduced here but the CLI package is neither in scope nor named as a co-change
**Quotes:** > Install FFmpeg with VideoToolbox support or pass --encoder libx264 to silence this."*
**Quotes:** > Plus vertical/short presets (1080×1920) for the `--vertical` flag.
**Quotes:** > **7. Benchmark harness.** `claudevid bench` renders a fixed reference spec and reports ms/frame (p50/p95), render fps, encode fps, cache hit rate and total wall clock
**Quotes:** > - `tools/bench` — reference spec + reported metrics
**Problem:** The proposal introduces at least four user-facing CLI flags (`--encoder`, `--vertical`, `--cpu-encode`, `--concurrency`) and one new subcommand (`claudevid bench`), and its own text places the CLI in a different change ("the CLI's progress bar in change 007"). The In Scope list contains only `packages/encoder-ffmpeg/*` and `tools/bench`; no CLI argument parser, flag registration, or subcommand wiring appears anywhere. A merge of this change as scoped ships an error message instructing the user to pass a flag that does not exist and a benchmark that is reachable only as a tool directory, not as the documented `claudevid bench`. This is a co-change to a caller the artifact never names.
**Fix:** Either enumerate the CLI files that must change in this commit, or state that the encoder exposes these as library options only and that the flags and `bench` subcommand are wired in change 007 — and then remove the flag names from the shipped error text.
**Status:** upheld

### [BLOCK] party-architect — Output resolution gets a second source of truth in the profile table
**Quotes:** > **Depends on:** 001-videospec-core (serializable `Timeline`), 002-canvas-render-engine (`renderFrame` into a reusable buffer).
**Quotes:** > | `preview` | h264_videotoolbox, 720p, low bitrate | fast draft loop (change 007) |
**Quotes:** > Plus vertical/short presets (1080×1920) for the `--vertical` flag.
**Quotes:** > Raw RGBA on stdin with real backpressure (`write()` → `await once(stdin, 'drain')`),
**Problem:** The render engine named as a dependency produces frames into a buffer at some fixed dimension, and a raw-RGBA stdin pipe carries no dimensions at all — FFmpeg must be told the exact `WxH` of the incoming bytes or it misreads every frame. The profile table then independently declares dimensions (720p, 1080×1920), so the artifact now has two places that decide output resolution and no statement of which one wins. The two readings produce different systems: either the encoder scales (a filter chain that the profile table does not mention and that changes the raw-input geometry contract), or the renderer must be reconfigured per profile (a caller co-change into change 002 that is not named). An implementer must guess, and the guess is unrecoverable because the raw pipe fails loudly or silently depending on which they pick.
**Fix:** State that frame geometry is owned solely by the renderer and that profiles carry codec/bitrate only, or state that profiles drive a scale filter and specify how the raw-input geometry is derived independently of the profile.
**Status:** upheld

### [WARN] party-architect — The progress-event contract is defined for one FFmpeg process and consumed under N
**Quotes:** > stderr is *parsed* — `frame=`, `fps=`, `speed=`, `time=` become typed progress events for the CLI's progress bar in change 007
**Quotes:** > Split the `Timeline` at scene boundaries into chunks of a target duration, render and encode each chunk concurrently in a `worker_threads` pool sized to the machine's performance cores
**Quotes:** > - **Default: chunked or single-pipe?** Chunking is faster but adds seam and disk risk.
**Problem:** The progress contract is specified in terms of a single FFmpeg stderr stream, but the chunked path has one such stream per worker, and the artifact leaves the choice between the two paths open. Change 007 is a separate consumer of this event type, so two implementers must agree on it: does a `frame=` event carry a chunk-local or timeline-global frame index, does `fps=` aggregate across workers, is `time=` a chunk offset or a timeline position? Every answer is defensible from the text, and the consumer is in another change, which is exactly the case where an under-specified shared contract diverges.
**Fix:** Specify the progress event shape once, in timeline-global terms, including which fields are aggregated across workers and what the single-pipe path emits for the fields that only exist under chunking.
**Status:** upheld

### [WARN] party-architect — Every named test requires a live FFmpeg with specific encoders and no stub seam is named
**Quotes:** > - Tests: round-trip colour fidelity (known colour in → same colour out), concat seam frame-hash continuity, frame-count exactness, cancellation leaves no child processes
**Quotes:** > - **Non-macOS behaviour.** Do we support Linux/CI as a first-class fallback (libx264) or declare it best-effort? CI needs *something* that works for the tests above to run at all.
**Quotes:** > **Risk:** high — the highest-risk change in the set. Concat seams, colour management, and cross-machine FFmpeg variance are all classes of bug that produce output which *looks* fine in a spot check and is wrong in ways viewers notice.
**Problem:** Three separate modules in the scope list spawn FFmpeg (`probe.ts`, `pipe.ts`, `concat.ts`) and none is named as an injectable process seam, so the whole test list is integration-only against whatever binary the machine has. The artifact then concedes CI may have no viable encoder. The parts that are pure logic and could be tested deterministically — chunk boundary selection against transition spans, GOP/keyframe arithmetic, argv construction per profile, cache-key derivation, stderr line parsing — are not listed as having tests at all, and those are precisely the components whose bugs the artifact says produce plausible-looking wrong output. Without a spawn seam the listed tests become conditionally skipped and the risk the proposal names goes uncovered.
**Fix:** Name a single process-spawn abstraction that all three modules use and that tests can stub, and add unit-level tests for splitter boundaries, argv construction, cache-key derivation and stderr parsing that run with no FFmpeg present.
**Status:** upheld

### [WARN] party-architect — The capability probe does not cover the codecs the profile table requires, and the fallback mapping is unspecified
**Quotes:** > probe the FFmpeg binary: presence, version, and which of `h264_videotoolbox` / `hevc_videotoolbox` / `prores_ks` / `libx264` are available. Return a typed `EncoderCapabilities`.
**Quotes:** > | `web` | VP9/WebM (CPU) | web embed |
**Quotes:** > A missing VideoToolbox encoder produces *"h264_videotoolbox not available on this machine; falling back to libx264 (slower)."*
**Problem:** The probe enumerates exactly four encoders; the profile table names five codecs, and VP9 is not among the probed set, so the `web` profile has no capability check and fails at spawn time with the raw FFmpeg error the probe exists to prevent. Separately, the fallback rule is stated only for `h264_videotoolbox → libx264`; the table's `hevc`, `master` and `web` profiles have no stated fallback, so an implementer must invent whether an unavailable `prores_ks` is a hard error or a substitution. Two components share this — the probe produces `EncoderCapabilities` and the profile resolver consumes it — and the mapping between them is the contract that is missing.
**Fix:** Make the probed encoder set derive from the profile table rather than being a separate hand-written list, and specify per profile whether an unavailable codec falls back and to what, or errors.
**Status:** upheld
