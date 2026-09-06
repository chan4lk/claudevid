# Proposal: FFmpeg VideoToolbox Encoder with Parallel Scene-Chunk Rendering

**Created:** 2026-09-06
**Status:** 🟡 Draft

**Depends on:** 001-videospec-core (serializable `Timeline`), 002-canvas-render-engine
(`renderFrame` into a reusable buffer).

## Problem

Getting frames out of the process and into a playable MP4 is where a fast renderer goes to die.
The requirement doc states the constraint plainly:

```
1920 * 1080 * 4 bytes * 30 fps ≈ 249 MB per second
30-minute video ≈ 448 GB of raw frame data through one pipe
```

The doc's reference implementation has a working backpressure hint and little else. Five things
break in practice:

1. **Sequential rendering leaves the machine idle.** An M3 has multiple performance cores; a
   single render loop uses one. The doc identifies parallel scene rendering + `concat` as the
   fix and does not build it — and it is the difference between the "under 15 minutes" target
   and the "under 5 minutes" aggressive target for a 30-minute video.
2. **FFmpeg failures are invisible.** The sample pipes stderr to `console.error` and rejects on
   non-zero exit. In reality FFmpeg exits non-zero for a dozen distinct reasons, and the user
   sees a wall of banner text plus `FFmpeg exited with code 1`. If VideoToolbox is unavailable
   — which happens on CI, in Docker, on Intel Macs, on Linux — the user is told nothing useful.
3. **Colour and timing are silently wrong.** Without `-fps_mode passthrough`/`-vsync 0`, FFmpeg
   will duplicate or drop frames to hit a target rate, desyncing audio from change 006. Without
   correct primaries/transfer/matrix tagging, the output looks washed out or oversaturated on
   playback, and it looks *plausible*, so nobody catches it until a viewer does.
4. **`concat` is only lossless if the cuts are keyframe-aligned.** Naive chunking produces
   visible glitches or a stream-copy failure at every seam. The doc gives the `concat` command
   and not the constraint that makes it work.
5. **Nothing is resumable.** Changing scene 43 of 200 re-renders all 200.

## Proposed Solution

Build `@claudevid/encoder-ffmpeg` — the process, pipe and concurrency layer.

**1. Capability probe, with actionable errors.**
At startup, probe the FFmpeg binary: presence, version, and which of
`h264_videotoolbox` / `hevc_videotoolbox` / `prores_ks` / `libx264` are available. Return a
typed `EncoderCapabilities`. A missing VideoToolbox encoder produces *"h264_videotoolbox not
available on this machine; falling back to libx264 (slower). Install FFmpeg with VideoToolbox
support or pass --encoder libx264 to silence this."* — not exit code 1.

**2. Correct single-pipe encoding.**
Raw RGBA on stdin with real backpressure (`write()` → `await once(stdin, 'drain')`),
`-fps_mode passthrough` so every frame we produce is exactly one frame in the output,
bt709 primaries/trc/colorspace tagging, `-pix_fmt yuv420p`, `-movflags +faststart`.
stderr is *parsed* — `frame=`, `fps=`, `speed=`, `time=` become typed progress events for the
CLI's progress bar in change 007 — and the last N lines are attached to a typed `EncodeError`
on failure.

**3. Parallel scene-chunk rendering — the speedup.**
Split the `Timeline` at scene boundaries into chunks of a target duration, render and encode each
chunk concurrently in a `worker_threads` pool sized to the machine's performance cores, then
join with `ffmpeg -f concat -c copy`.

The correctness conditions, which are the actual work:

- Each chunk starts on a **forced keyframe** (`-force_key_frames 0`, `-g` set to the chunk
  length) so stream-copy concatenation is lossless and seamless.
- Encoder parameters are byte-identical across chunks — any drift makes `concat -c copy` fail
  or produce a broken stream.
- Chunk boundaries must respect change 003's **overlapping scene transitions**: a cross-fade
  spanning two scenes cannot be cut between them. The splitter takes transition spans as
  atomic units.
- Each worker gets its own `Renderer` and raster cache (change 002 Open Question), so memory
  ceiling is per-worker × N — the pool size is bounded by RAM as well as cores.

**4. Chunk-level content-addressed resume.**
A chunk whose input hash (its slice of the timeline + render settings + asset hashes) matches an
existing artifact is skipped and reused. Iterating on scene 43 of 200 then costs one chunk, not
200. This is what makes the library usable for real editing loops rather than one-shot generation.

**5. Output profiles.**

| Profile | Codec | Use |
|---|---|---|
| `preview` | h264_videotoolbox, 720p, low bitrate | fast draft loop (change 007) |
| `final` | h264_videotoolbox ~12M, bt709, faststart | YouTube / general delivery |
| `hevc` | hevc_videotoolbox | smaller files, 4K delivery |
| `master` | prores_ks profile 3 (422 HQ) | editing intermediate |
| `web` | VP9/WebM (CPU) | web embed |

Plus vertical/short presets (1080×1920) for the `--vertical` flag.

**6. Process hygiene.** Deterministic temp directories, guaranteed cleanup on success and
failure, cancellation that propagates SIGTERM to every child, and no orphaned FFmpeg processes
after a Ctrl-C. A batch job that leaks FFmpeg processes will take the machine down.

**7. Benchmark harness.** `claudevid bench` renders a fixed reference spec and reports ms/frame
(p50/p95), render fps, encode fps, cache hit rate and total wall clock, against the doc's stated
targets (<15 / <10 / <5 minutes for 30-minute 1080p30). The performance claim in this project is
load-bearing; it should be a number in CI, not a sentence in a README.

## Scope

### In Scope

- `packages/encoder-ffmpeg/src/probe.ts` — binary + encoder capability detection, typed errors
- `packages/encoder-ffmpeg/src/pipe.ts` — raw frame pipe, backpressure, stderr parsing, progress
- `packages/encoder-ffmpeg/src/profiles.ts` — the profile table above, flag construction
- `packages/encoder-ffmpeg/src/chunk.ts` — timeline splitting, transition-aware boundaries, GOP alignment
- `packages/encoder-ffmpeg/src/pool.ts` — worker_threads pool, sizing policy, backpressure, cancellation
- `packages/encoder-ffmpeg/src/concat.ts` — concat list generation, stream-copy join, verification
- `packages/encoder-ffmpeg/src/cache.ts` — content-addressed chunk artifacts, resume
- `packages/encoder-ffmpeg/src/temp.ts` — temp dir lifecycle, cleanup, signal handling
- `tools/bench` — reference spec + reported metrics
- Tests: round-trip colour fidelity (known colour in → same colour out), concat seam frame-hash
  continuity, frame-count exactness, cancellation leaves no child processes

### Out of Scope

- **Audio of any kind** — voiceover, music, ducking, muxing all belong to change 006. This change
  produces silent video and exposes the seam 006 muxes into.
- Streaming/live output, RTMP
- Zero-copy VideoToolbox surface handoff (bypassing the raw pipe entirely) — a real future
  optimization, far too deep for v1
- Distributed/multi-machine rendering
- Bundling an FFmpeg binary (system FFmpeg is a documented prerequisite)

## Impact

- **Files affected:** ~20 new
- **Complexity:** large
- **Risk:** high — the highest-risk change in the set. Concat seams, colour management, and
  cross-machine FFmpeg variance are all classes of bug that produce output which *looks* fine in
  a spot check and is wrong in ways viewers notice.

## Open Questions

- **VideoToolbox quality.** `h264_videotoolbox` is meaningfully worse than `libx264` at equal
  bitrate, and crisp text and code on flat backgrounds is the worst case for it — ringing around
  glyph edges is exactly what a code walkthrough shows. Options: bias the default bitrate high
  (16–20M for 1080p), expose `--cpu-encode` for finals, or default finals to libx264 and previews
  to VideoToolbox. **Recommendation: high default bitrate + a documented `--cpu-encode` escape**,
  with a side-by-side quality check during design.
- **Default: chunked or single-pipe?** Chunking is faster but adds seam and disk risk. Threshold
  by duration (single pipe under ~2 minutes, chunked above)?
- **Worker pool sizing on Apple Silicon.** `os.cpus()` counts efficiency cores, which will drag
  the pool. Detect performance-core count, or default to a fraction and let `--concurrency`
  override?
- **Chunk memory ceiling.** N workers × a 512 MB raster cache each is not viable at N=8. Does
  the pool need a shared cache, a smaller per-worker ceiling, or dynamic sizing from available RAM?
- **Where does resume state live?** `.claudevid/cache/` in the project, or a user-level cache?
  Project-local is predictable and gitignorable; user-level dedupes across projects.
- **Non-macOS behaviour.** Do we support Linux/CI as a first-class fallback (libx264) or declare
  it best-effort? CI needs *something* that works for the tests above to run at all.

### Panel findings (adversarial review, round 2 — all upheld)

_Appended by the party panel. Verdict: CHANGES_REQUESTED (advisory; `party.block: false`)._

- **[BLOCK]** (party-architect) FFmpeg argument construction is split across three modules while the design's own correctness invariant requires a single owner — see party-report.md
- **[BLOCK]** (party-architect) The chunk cache key omits the encoder parameters the concat invariant depends on — see party-report.md
- **[BLOCK]** (party-architect) Two components are given contradictory lifecycle ownership of the same chunk files — see party-report.md
- **[BLOCK]** (party-architect) CLI surface is introduced here but the CLI package is neither in scope nor named as a co-change — see party-report.md
- **[BLOCK]** (party-architect) Output resolution gets a second source of truth in the profile table — see party-report.md
- **[WARN]** (party-architect) The progress-event contract is defined for one FFmpeg process and consumed under N — see party-report.md
- **[WARN]** (party-architect) Every named test requires a live FFmpeg with specific encoders and no stub seam is named — see party-report.md
- **[WARN]** (party-architect) The capability probe does not cover the codecs the profile table requires, and the fallback mapping is unspecified — see party-report.md
- **[NOTE]** (party-architect) Rebuttal to party-po's BLOCK: chunking cannot be cut cleanly because the artifact couples resume and the bench's own metric to it — see party-report.md
- **[WARN]** (party-ba) "Invisible failures" is named as problem #2 but no acceptance criterion tests actionable error output — see party-report.md
- **[WARN]** (party-ba) Resume claim ("costs one chunk, not 200") has no matching test; bench's "cache hit rate" has no pass/fail threshold — see party-report.md
- **[WARN]** (party-ba) Output quality for the stated target use case (code walkthroughs) has no acceptance criterion; only speed is gated — see party-report.md
- **[NOTE]** (party-ba) "a dozen distinct reasons" is an unsourced quantity — see party-report.md
- **[BLOCK]** (party-po) Parallel chunking/pool/concat/resume infrastructure is priced only against the aggressive target, never checked against whether the base target needs it at all — see party-report.md
- **[WARN]** (party-po) Output profile matrix has no per-profile value justification beyond the two named in the Problem section — see party-report.md
- **[NOTE]** (party-po) Benchmark harness and the extra profile set are a cut line the proposal doesn't name — see party-report.md
- **[WARN]** (party-po) Test suite's recurring CI cost is unstated for a suite that necessarily runs real FFmpeg encodes — see party-report.md

---

**To proceed:** Review this proposal and approve to begin planning.
