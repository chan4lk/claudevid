# Spec: FFmpeg Encoder — Single-Pipe VideoToolbox/libx264, Argv-Unified

**Change:** 005-videotoolbox-encoder
**Created:** 2026-09-07
**Status:** 🟡 Draft

## Overview

`@claudevid/encoder-ffmpeg` turns a stream of raw RGBA `FrameBuffer`s (from
`@claudevid/renderer-canvas`, `packages/renderer-canvas/src/frame-buffer.ts`) into an MP4 by
piping them into a single spawned FFmpeg process — one owner for the complete FFmpeg command
line, correct backpressure, actionable failure messages, and process hygiene that leaves no
orphaned children behind.

**This is a scope-cut v1.** The original proposal's parallel scene-chunk rendering pipeline
(`chunk.ts`/`pool.ts`/`concat.ts`/`cache.ts` — timeline splitting, a `worker_threads` pool,
keyframe-aligned `concat -c copy`, content-addressed resume) is **entirely deferred**, per the
party panel's upheld `party-po` BLOCK finding: that infrastructure was priced only against the
proposal's aggressive `<5min` target and never checked against whether the primary `<15min`
target needs it at all (see `party-report.md`, `GOALS.md`'s 005 section). This spec adopts the
panel's own fix: ship the corrected single-pipe path first, bench it against a real render, and
gate the entire chunking apparatus on that number failing to clear `<15min` — not build it
speculatively. See "Bench finding" in Notes for the (necessarily deferred, see below) status of
that gate.

Five things the single-pipe path fixes that the requirement doc's reference implementation
didn't (numbering matches `proposal.md`'s Problem section):
1. **Capability probe with actionable errors** (`probe.ts`) — a missing `h264_videotoolbox`
   produces a typed, human-readable fallback notice, not a raw non-zero exit code.
2. **Failures are visible** (`pipe.ts`'s `EncodeError`) — the last N stderr lines and a
   generated message are attached to a typed error, not left in a wall of banner text.
3. **Colour and timing are correct** (`argv.ts`) — `-fps_mode passthrough`, bt709 tagging,
   `-pix_fmt yuv420p`, `-movflags +faststart`, all emitted by the one function that owns the
   complete argv.
4. *(Concat keyframe-alignment — moot; there is no concat in v1. See "Deferred" below.)*
5. *(Chunk-level resume — moot; there is no chunking in v1. See "Deferred" below.)*

## Requirements

### Functional Requirements

- **FR1 — `probe.ts`: capability detection, injectable spawn seam.** `probe(execFn?:
  typeof child_process.spawn): Promise<EncoderCapabilities>` where `EncoderCapabilities =
  { ffmpegPresent: boolean; ffmpegVersion?: string; h264_videotoolbox: boolean; libx264:
  boolean }`. Probes exactly the two codecs `preview`/`final` need — **not** the original
  proposal's four-codec list (`hevc_videotoolbox`/`prores_ks` are cut along with the profiles
  that would have used them; see "Deferred" below), which also resolves the party-architect
  WARN that the probed set could drift from the profile table: with only two profiles and two
  codecs, the set is by construction exhaustive, not hand-maintained against a larger table.
  `execFn` defaults to `child_process.spawn` and is the **named test seam** (resolution point 4,
  below): a test passes a fake `execFn` that returns canned `ffmpeg -version`/`ffmpeg -encoders`
  stdout (or an `ENOENT` spawn error) so every capability-detection branch — FFmpeg entirely
  absent, present but no VideoToolbox, present with both — is unit-testable with zero live
  FFmpeg or macOS hardware.
- **FR2 — `argv.ts`: sole owner of the complete FFmpeg argv (resolution point 1).**
  `buildArgv(input: ArgvInput): string[]` is the **only** place in this package that constructs
  FFmpeg command-line flags. `pipe.ts` calls it and appends nothing of its own — this directly
  resolves the party-architect BLOCK ("argument construction split across three modules... no
  single component sees the whole command line"). Signature:
  ```ts
  interface FrameGeometry { width: number; height: number; fps: number }
  interface ResolvedProfile { codec: "h264_videotoolbox" | "libx264"; bitrateKbps: number }
  interface ArgvInput {
    profile: ResolvedProfile;
    geometry: FrameGeometry;
    inputPath: string;   // "-" for the stdin raw-RGBA pipe — this package's only caller in v1
    outputPath: string;
  }
  function buildArgv(input: ArgvInput): string[]
  ```
  For `{ profile: { codec: "libx264", bitrateKbps: 18000 }, geometry: { width: 1920, height:
  1080, fps: 30 }, inputPath: "-", outputPath: "out.mp4" }` (the `final` profile at 1080p30,
  falling back to `libx264`), `buildArgv` returns **exactly**:
  ```
  ["-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "1920x1080", "-r", "30", "-i", "-",
   "-fps_mode", "passthrough", "-pix_fmt", "yuv420p",
   "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
   "-c:v", "libx264", "-b:v", "18000k", "-movflags", "+faststart", "out.mp4"]
  ```
  This is a mechanically-pinned contract (AC3): the input side declares raw RGBA geometry
  matching `FrameBuffer`'s byte layout exactly (`packages/renderer-canvas/src/frame-buffer.ts`
  — `width * height * 4` bytes, RGBA per `002`'s empirically-verified byte order, see
  Grounding); the output side carries every correctness flag from problem #3 in one place.
- **FR3 — `profiles.ts`: `preview`/`final` only, codec+bitrate, never dimensions (resolution
  point covering the output-resolution BLOCK).** `hevc`/`master`/`web`/vertical presets are cut
  (party-po WARN: no stated value beyond "the table exists" — see "Deferred" below).
  ```ts
  const PROFILE_TABLE = {
    preview: { bitrateKbps: 4000 },   // fast draft loop (change 007)
    final:   { bitrateKbps: 18000 },  // YouTube / general delivery — high end of the
                                        // recommended 16–20M range, see FR6
  } as const;

  function resolveProfile(
    name: "preview" | "final",
    capabilities: EncoderCapabilities,
    opts?: { cpuEncode?: boolean }
  ): { resolved: ResolvedProfile; fallbackNotice?: string }
  ```
  `resolveProfile` never reads or produces `width`/`height` — **frame geometry is owned solely
  by the caller/renderer**, derived from `VideoSpec.width`/`VideoSpec.height` (`001`'s schema),
  and passed into `buildArgv` as `ArgvInput.geometry`, never read from the profile table. This
  is the explicit statement the party-architect BLOCK asked for: there is exactly one source of
  truth for output resolution, and it is not `profiles.ts`.
- **FR4 — Codec resolution and the actionable fallback message (resolves proposal problem #2 /
  party-ba WARN).** `resolveProfile`'s codec logic: if `opts.cpuEncode` is not set and
  `capabilities.h264_videotoolbox` is true, `resolved.codec = "h264_videotoolbox"` and
  `fallbackNotice` is absent. Otherwise `resolved.codec = "libx264"`; if the reason was an
  *unavailable* VideoToolbox (not an explicit `cpuEncode` request), `fallbackNotice` is set to
  exactly the message the original proposal specified: `"h264_videotoolbox not available on
  this machine; falling back to libx264 (slower). Install FFmpeg with VideoToolbox support or
  pass { cpuEncode: true } to silence this."` If `capabilities.ffmpegPresent` is `false`,
  `resolveProfile` throws a typed `FfmpegNotFoundError` with an actionable message (install
  instructions) instead of `buildArgv` ever being called with an unresolved codec. AC5/AC6
  verify this message is produced, not just a raw exit code — the specific test the party-ba
  WARN said was missing.
- **FR5 — `pipe.ts`: single-pipe raw-RGBA encode with real backpressure.**
  `createEncodePipe(opts: EncodeOptions): EncodePipe` spawns FFmpeg with `argv.ts`'s output and
  exposes:
  ```ts
  interface EncodePipe {
    write(frame: Buffer): Promise<void>;  // frame.length === width*height*4, matches FrameBuffer.data
    finish(): Promise<void>;              // closes stdin, resolves once ffmpeg exits 0
    cancel(): Promise<void>;              // SIGTERMs the child, resolves once it has exited
    onProgress(cb: (e: ProgressEvent) => void): void;
  }
  ```
  `write()` calls `stdin.write(frame)`; if that returns `false`, `write()` does not resolve
  until `await once(stdin, "drain")` — this is the actual backpressure fix, not a hint. A
  `write()`/`finish()` call after `finish()`/`cancel()` has already been called throws
  synchronously (Edge Cases).
- **FR6 — Quality gate library option, not a CLI flag.** `EncodeOptions` carries `cpuEncode?:
  boolean` (FR4's escape hatch). Wiring a `--cpu-encode` CLI flag is change 007's job — this
  change ships the library option only, per the proposal's own Open Question recommendation
  ("high default bitrate + a documented `--cpu-encode` escape"), adopted here as: `final`'s
  default bitrate is `18000` kbps (top of the 16–20M/1080p range the proposal recommended,
  chosen because VideoToolbox's known weakness is ringing on flat-background text — the
  library's stated primary content type — so the default should sit at the range's
  quality-favoring end, not its middle) plus the `cpuEncode` library escape.
- **FR7 — Quality gate acceptance test, falsifiable (resolves party-ba WARN).** A
  falsifiable, numeric floor on a text-heavy reference frame: **SSIM ≥ 0.92**, measured via
  FFmpeg's own `-lavfi ssim` filter comparing the encoded-then-decoded frame against the
  source, on a synthetic high-contrast text/flat-background pattern (a simple generated pattern
  is sufficient for this test — wiring the full `@claudevid/layer-code` pipeline is not required
  to exercise the encoder's compression behavior). **0.92 is a judgment call, documented as
  one**: SSIM ≥ 0.95 is commonly cited as "visually indistinguishable"; 0.92 is chosen as the
  looser "acceptable for code walkthroughs" bar the proposal's own Open Question language used,
  giving VideoToolbox's known text-ringing weakness room to pass at the chosen default bitrate
  (FR6) without demanding master-quality output from a fast preview-oriented codec path. PSNR
  was considered and rejected as the metric because it is not perceptually weighted and would
  either over- or under-penalize the specific ringing-around-glyphs artifact this gate exists
  to catch.
- **FR8 — `EncodeError`: typed, actionable, carries evidence.** On a non-zero FFmpeg exit,
  `pipe.ts` rejects with `EncodeError extends Error { exitCode: number | null; stderrTail:
  string[] }` where `stderrTail` is the last 20 lines of stderr (enough to show the actual
  FFmpeg error line past the banner, bounded so a pathological error flood doesn't balloon
  memory) and `message` is a generated summary (exit code + first line of `stderrTail`), not a
  bare `"FFmpeg exited with code 1"`.
- **FR9 — Progress event contract, timeline-global, defined once (resolution point 3).**
  ```ts
  interface ProgressEvent { frame: number; fps?: number; speedX?: number; timeSeconds?: number }
  ```
  `frame` is FFmpeg's own `frame=` counter from stderr — **because v1 has exactly one FFmpeg
  process per encode (no chunking), this counter already IS the timeline-global frame index
  directly**, with no aggregation or offset math needed. This is stated explicitly so a future
  chunking follow-on has a contract to *extend* (e.g., `chunkStartFrame + localFrame`) rather
  than invent from scratch — the ambiguity the party-architect WARN raised ("chunk-local or
  timeline-global? does `fps=` aggregate across workers?") does not arise in v1 because there is
  only one stream, and the single-process case is the base the multi-process case must reduce
  to. `pipe.ts` exports a pure `parseProgressLine(line: string): ProgressEvent | null` used
  internally and tested standalone (no FFmpeg process required — AC7).
- **FR10 — `temp.ts`: sole owner of the encode's temp/output files, deterministic naming.**
  `createTempRun(baseDir?: string): TempRun` where
  ```ts
  interface TempRun {
    dir: string;                          // <baseDir ?? os.tmpdir()>/claudevid-encode-<uuid>
    cleanup(): Promise<void>;             // idempotent; removes dir, unregisters signal handlers
    registerChild(child: ChildProcess): void;  // so a signal can SIGTERM it before cleanup
  }
  ```
  "Deterministic" means a **predictable, documented naming scheme** (`claudevid-encode-<uuid>`
  under a fixed root), not a literal fixed path — a literal fixed path would collide across
  concurrent encodes, which this package must not preclude. `createTempRun` installs `SIGINT`/
  `SIGTERM` handlers at construction that call `cleanup()` (which SIGTERMs any registered child
  first, then removes the directory) exactly once, then re-raises the signal's default
  disposition; `cleanup()` is safe to call a second time (no-op) if already cleaned up. **There
  is no `cache.ts` in v1** — chunking/resume is cut (FR-Deferred below), so the party-architect
  BLOCK about `temp.ts`/`cache.ts` having contradictory lifecycle ownership over the same files
  is **moot by construction**: `temp.ts` is the only module that ever owns an encode's on-disk
  artifacts, and it always deletes them. This is stated explicitly per the panel's own
  instruction, so a reader sees a deliberate scope cut, not an oversight.
- **FR11 — `tools/bench`: standalone script, not a CLI subcommand (resolution point covering
  the CLI-scope BLOCK).** `tools/bench` (package `@claudevid/bench`, mirroring `003`'s
  `tools/motion-preview` standalone-tool convention — not a `claudevid bench` subcommand; the
  CLI package is out of scope for this change and wiring is deferred to `007`) renders a fixed
  reference `VideoSpec` through the real pipeline — `compileTimeline` (`@claudevid/core`) →
  `renderFrame` (`@claudevid/renderer-canvas`) → this change's `pipe.ts` — and reports:
  render ms/frame p50/p95, render fps, encode fps (from `ProgressEvent`s), and total wall
  clock, against the doc's stated targets (`<15min` primary, `<10min`/`<5min` aggressive, for a
  30-minute 1080p30 video). Invoked directly (`pnpm --filter @claudevid/bench bench`), never
  through a `claudevid` CLI entry point that doesn't exist in this repo yet.
- **FR12 — Non-macOS/CI fallback is automatic, no special-casing (resolution point 6).**
  `libx264` is the CI/Linux/non-macOS fallback path. This falls directly out of FR1 + FR4: on a
  machine without VideoToolbox, `probe()` reports `h264_videotoolbox: false`, and
  `resolveProfile` (FR4) picks `libx264` and emits the fallback notice — no environment
  detection, no `process.platform` branch anywhere in this package. The sandbox this plan was
  authored in is exactly this case (see Notes' Bench finding) and is treated as the reference
  non-macOS path, not a special case requiring its own code.

### Non-Functional Requirements

- **NFR1 — No orphaned FFmpeg processes.** After `cancel()`, after `finish()` (success or
  failure), and after a `SIGINT`/`SIGTERM` mid-encode, zero FFmpeg child processes remain
  running (AC9/AC10) — `temp.ts`'s `registerChild` + signal handler is the single mechanism
  responsible for this across every exit path.
- **NFR2 — `buildArgv` and `resolveProfile` are pure.** Same inputs → same outputs, no I/O, no
  wall-clock/random dependency — this is what makes FR2/FR3's contract mechanically pinnable
  (AC3/AC4) with no FFmpeg process involved.
- **NFR3 — No regression to 001–004's existing public APIs or test suites.** This package adds
  no dependency edge into `@claudevid/core`, `@claudevid/motion`, or `@claudevid/renderer-
  canvas` from its core modules (`probe.ts`/`argv.ts`/`pipe.ts`/`profiles.ts`/`temp.ts` depend
  only on Node built-ins); only `tools/bench` imports the render stack, and only additively.
- **NFR4 — CI cost is bounded and stated (resolution point 5).** See "CI cost budget" in Notes
  — this is a hard requirement on the test suite's shape, not just documentation: every test
  that spawns a real FFmpeg process operates on a synthetic clip capped at a few seconds of
  frames at a small resolution, never the 30-minute bench reference.

## Acceptance Criteria

- **AC1:** `probe()` given an injected `execFn` that simulates FFmpeg entirely absent (spawn
  rejects with `ENOENT`) returns `{ ffmpegPresent: false, h264_videotoolbox: false, libx264:
  false }` without throwing (FR1).
- **AC2:** `probe()` given an injected `execFn` that returns canned `ffmpeg -encoders` output
  containing a `libx264` line but no `h264_videotoolbox` line returns `{ ffmpegPresent: true,
  h264_videotoolbox: false, libx264: true }` (FR1) — no live FFmpeg process spawned.
- **AC3:** `buildArgv({ profile: { codec: "libx264", bitrateKbps: 18000 }, geometry: { width:
  1920, height: 1080, fps: 30 }, inputPath: "-", outputPath: "out.mp4" })` returns the exact
  argv array pinned in FR2, element-for-element (FR2/NFR2).
  **AC4:** `buildArgv` for the `preview` profile (`{ codec: "libx264", bitrateKbps: 4000 }`) at
  `1280x720/30fps` differs from AC3's array only in `-s`/`-b:v`/`-c:v` (when codec differs) and
  `outputPath` — no `-vf scale` or any other resolution-transform flag appears anywhere in the
  array for either profile (FR3's "profiles never carry dimensions" contract, verified
  structurally).
- **AC5:** `resolveProfile("final", { ffmpegPresent: true, h264_videotoolbox: false, libx264:
  true })` (no `cpuEncode`) returns `resolved.codec === "libx264"` and a `fallbackNotice`
  containing both the literal substring `"h264_videotoolbox"` and `"libx264"` (FR4 — the
  actionable-message test the party-ba WARN said was missing).
- **AC6:** `resolveProfile("final", { ffmpegPresent: false, ... })` throws `FfmpegNotFoundError`
  with an actionable (non-empty, install-referencing) message rather than letting a downstream
  `spawn` call fail with a raw `ENOENT` (FR4).
- **AC7:** `parseProgressLine("frame=  120 fps= 30 q=-1.0 size=    512kB time=00:00:04.00
  bitrate= 1024.0kbits/s speed=1.0x")` returns `{ frame: 120, fps: 30, speedX: 1.0, timeSeconds:
  4 }` (FR9) — a pure function test, no FFmpeg process involved.
- **AC8:** A real encode via `createEncodePipe` of a 30-frame, 320×240 synthetic clip (`final`
  profile, `libx264` forced via `cpuEncode: true` for CI-portability) emits a strictly
  increasing sequence of `ProgressEvent.frame` values whose last emitted value equals `30`
  (FR9's timeline-global-index contract, single-pipe path) — one of this suite's live-FFmpeg
  tests (bounded, see NFR4).
- **AC9:** Calling `cancel()` mid-encode on a real (small synthetic clip) `EncodePipe` resolves,
  and a process-table check afterward finds zero live processes matching the spawned FFmpeg's
  PID (NFR1) — live-FFmpeg test, bounded clip.
- **AC10:** `createTempRun()`'s directory exists on disk immediately after creation; calling
  `cleanup()` removes it; a child process that creates a `TempRun`, registers a long-running
  dummy child, and receives `SIGTERM` from its parent still results in the directory being
  removed and the dummy child being terminated before the test's timeout (FR10/NFR1) — no live
  FFmpeg needed for this test (a dummy long-running child process stands in for FFmpeg).
- **AC11:** A round-trip colour test: encode a single 64×64 frame of known solid RGBA
  `[255,0,0,255]` through `createEncodePipe` at the `final` profile, decode the single output
  frame back via FFmpeg, and assert the decoded pixel is within a small numeric tolerance
  (accounting for lossy compression and RGB↔YUV rounding) of pure red — proposal problem #3's
  colour-correctness claim, live-FFmpeg, one-frame clip (bounded per NFR4).
- **AC12:** The SSIM quality gate (FR7): a synthetic high-contrast text-pattern frame encoded
  via `createEncodePipe` at the `final` profile's default bitrate (`18000` kbps) and decoded
  back scores `SSIM >= 0.92` against the source frame, measured via FFmpeg's `-lavfi ssim`
  filter — live-FFmpeg, single-frame or short clip (bounded per NFR4).
- **AC13:** `tools/bench`, run against a short reference `VideoSpec` (a fixed, small duration —
  e.g. 10 seconds at 1080p30 — **not** the 30-minute target duration, per the Notes' deferral),
  completes without crashing and prints render ms/frame p50/p95, render fps, encode fps, and
  total wall clock in the documented format (FR11) — the bench-harness-itself AC; the actual
  `<15min`-on-a-30-minute-reference gate decision is explicitly deferred (see Notes).
- **AC14:** `pnpm --filter @claudevid/encoder-ffmpeg build` and `... test` succeed standalone
  from a clean checkout, and `pnpm -r run build && pnpm -r run test` (the whole workspace)
  still passes — this change does not regress 001–004's existing suites (NFR3).

## Edge Cases

- `ffmpeg` entirely absent from `PATH`: `probe()` reports `ffmpegPresent: false` (AC1);
  `resolveProfile` throws the actionable `FfmpegNotFoundError` (AC6) before any `spawn` for an
  actual encode is attempted — never a raw `ENOENT` surfacing from deep inside `pipe.ts`.
- `cpuEncode: true` requested but `libx264` is also unavailable (a pathologically minimal FFmpeg
  build): `resolveProfile` throws a typed error naming both requested and available codecs,
  rather than silently ignoring the explicit `cpuEncode` request and picking VideoToolbox
  anyway (an explicit caller request is never silently overridden).
- `finish()` called having never called `write()` (zero frames): FFmpeg is given a valid,
  zero-duration input stream; `pipe.ts` lets FFmpeg's own behavior stand (an essentially-empty
  MP4 or FFmpeg's own error) rather than special-casing zero-frame encodes — this is not a
  contract this package makes stronger promises about in v1.
- `write()` or `finish()` called after `finish()`/`cancel()` has already resolved: throws
  synchronously (`Error("EncodePipe already finished")`) rather than hanging or silently
  no-op-ing (FR5).
- `outputPath`'s parent directory does not exist: `pipe.ts` does not create it — the caller
  (in v1, `tools/bench`, or `temp.ts`'s own `TempRun.dir`) is responsible for ensuring the
  output directory exists before calling `createEncodePipe`; FFmpeg's own file-open error
  surfaces via `EncodeError` (FR8) if it doesn't.
- `SIGINT`/`SIGTERM` arrives with a `TempRun` created but no child ever registered (idle):
  `cleanup()` still runs exactly once and removes the directory — no error from an absent
  child to kill.
- A `TempRun`'s `cleanup()` is called twice (once explicitly by the caller, once by the signal
  handler racing it): idempotent — the second call is a no-op, not a thrown "already removed"
  error (FR10).

## Dependencies

- **Depends on:** `001-videospec-core` (`VideoSpec.width`/`height`/`fps` — the sole source of
  `tools/bench`'s frame geometry, per FR3's resolution-ownership statement; `compileTimeline`,
  used only by `tools/bench`, not by the core encoder modules). `002-canvas-render-engine`
  (`renderFrame`, `FrameBuffer` — `packages/renderer-canvas/src/frame-buffer.ts`'s `{ width,
  height, data: Buffer }` RGBA shape is exactly what `pipe.ts`'s `write(frame: Buffer)` expects
  and what `argv.ts`'s `-pix_fmt rgba` input declaration assumes; used only by `tools/bench`).
  System FFmpeg is an external, documented prerequisite (not bundled — unchanged from the
  original proposal's Out of Scope list).
- **Depended on by:** `006` (audio muxing — mixes into this change's silent video output; this
  change's job ends at a silent MP4, the seam 006 muxes into, unchanged from the proposal).
  `007` (CLI/Claude skill — wires `--encoder`/`--cpu-encode` flags to this package's
  `EncodeOptions.cpuEncode`, wires `claudevid bench` to invoke `tools/bench`'s logic, consumes
  `ProgressEvent` for a progress bar — none of this wiring exists yet, deliberately, per FR11).
  A future chunking follow-on (see Notes) depends on this change's `argv.ts`/`profiles.ts`
  being the stable, single-owner contract it extends rather than reworks.

## Notes

### Bench finding

**Bench not run against the 30-minute reference during planning** — a 30-minute 1080p30 render
is far too slow to execute inside a planning pass, and this sandbox has no macOS/VideoToolbox
hardware to produce a representative number even if it were fast (see below). The acceptance
criterion for `tools/bench` itself (AC13) is that the harness runs and reports numbers in the
documented format; **the actual `<15min` primary-target gate decision — whether the chunking/
pool/concat/resume follow-on needs to be built at all — is deferred to whoever runs `tools/
bench` against the real 30-minute reference on real Apple Silicon hardware.** That decision
belongs to whoever picks up the follow-on, not to this planning pass.

**An indicative, non-final, non-macOS data point was gathered**, per this plan's own testing
instruction, to sanity-check that the single-pipe path isn't obviously doomed: this sandbox has
FFmpeg (`N-124098-ge717604a29`, x86_64 Linux build) with `libx264`/`libx264rgb` available and
**no** `h264_videotoolbox` (expected — this is exactly the non-macOS fallback path FR12
describes, not an exception to it). A smoke test piped 300 frames of `1920x1080` synthetic
(`lavfi testsrc`) RGBA through a second FFmpeg process configured with this spec's exact argv
shape (`-fps_mode passthrough -pix_fmt yuv420p`, `libx264`, `-b:v 16M`, `-movflags +faststart`)
end to end: **wall clock 2.71s for 10s of reference video, encoder-reported throughput ~117
fps / 3.87x realtime.** Scaled naively to a 30-minute (54,000-frame) reference, that throughput
alone would land around 7–8 minutes — comfortably inside the `<15min` primary target — **but
this number measures encode throughput only**, with `lavfi`-synthesized frames requiring no
render cost and no real backpressure stall from a renderer. `002`'s own budget (10–20ms/frame
at 1080p) is the dominant term the real bench run needs to account for: at 20ms/frame, serial
rendering alone costs `54000 * 0.02s ≈ 18 minutes` — already over the primary target *before*
encoding, independent of whatever this change's encode throughput turns out to be. This is
exactly why `tools/bench` measures render fps and encode fps **separately** (FR11) and why the
gate decision is a real-hardware, real-pipeline question this indicative number cannot answer.
Recorded here as a directional signal only: FFmpeg's encode side is not obviously the
bottleneck; whether the combined render+encode pipeline clears `<15min` is unknown until
someone runs the real bench.

### Panel resolution points, located

Cross-referencing the eight points the plan's brief required this spec to resolve explicitly:

1. **argv.ts as sole owner** — FR2.
2. **Quality gate** (`cpuEncode` library option, default bitrate, SSIM floor) — FR6/FR7, AC12.
3. **Progress event contract, timeline-global** — FR9.
4. **Test seam for `probe.ts`** — FR1 (injectable `execFn`), AC1/AC2.
5. **CI cost statement** — NFR4, "CI cost budget" below.
6. **Non-macOS/CI fallback** — FR12.
7. **Where resume state lives** — moot; stated explicitly in "Deferred" below.
8. **Worker pool sizing on Apple Silicon** — moot; stated explicitly in "Deferred" below.

### CI cost budget (resolution point 5)

**Zero-FFmpeg-required (run on every PR, no FFmpeg binary needed):** argv construction (AC3/
AC4), `resolveProfile` codec/fallback-message logic (AC5/AC6), `probe.ts` capability-detection
branches via the injected `execFn` seam (AC1/AC2), stderr `parseProgressLine` (AC7), `temp.ts`
directory lifecycle including the signal-handler test using a dummy long-running child in place
of FFmpeg (AC10). These are the majority of this suite and run in well under a second combined.

**FFmpeg-required (run on every PR, but each test is capped small):** the colour round-trip
(AC11, single 64×64 frame), the SSIM quality gate (AC12, single frame or a handful), progress-
event sequencing (AC8, 30 frames at 320×240), cancellation leaving no orphaned process (AC9,
same small clip). **Each of these uses a synthetic reference clip of at most a few seconds at a
small resolution — never the 30-minute bench target** — so the whole FFmpeg-dependent slice of
the suite is expected to run in low single-digit seconds total, not minutes.

**Excluded from per-PR CI:** `tools/bench`'s full run against its documented reference spec is
**not** part of `pnpm -r run test`. It is a manually/nightly-run tool (mirroring `003`'s
`tools/motion-preview` precedent of a tool with its own narrow CLI-argument tests but no
rendering in the fast tier). AC13 only requires that the harness runs and reports numbers in
the documented format for a *short* reference spec — not the full 30-minute target duration —
even that abbreviated run is not gated into the fast per-PR suite.

### Deferred to follow-on (out of scope for 005 v1)

`chunk.ts` (transition-aware timeline splitting, keyframe-aligned chunk boundaries), `pool.ts`
(`worker_threads` pool, performance-core sizing), `concat.ts` (stream-copy join, seam
verification), `cache.ts` (content-addressed chunk resume) — **all deferred**, gated on whether
`tools/bench`'s single-pipe number, run against the real 30-minute 1080p30 reference on real
Apple Silicon hardware, fails to clear the primary `<15min` target. If/when that follow-on is
built:
- **Chunk-level resume (proposal problem #5, "changing scene 43 of 200 re-renders all 200")
  goes with it** — there is no resume mechanism of any kind in v1; this is a deliberate,
  explicitly-stated scope cut, not an oversight (per the party-architect NOTE that grouping
  chunking/resume as one gated block means problem #5 stays unaddressed in the gated variant —
  stated here so that's explicit rather than incidental).
- **Where resume state lives** (`.claudevid/cache/` project-local vs. user-level) — moot for
  v1; there is no resume state to place anywhere. Revisit when the follow-on is scoped.
- **Worker pool sizing on Apple Silicon** (performance-core detection vs. `os.cpus()` vs. a
  `--concurrency` override) — moot for v1; there is no pool. Revisit when the follow-on is
  scoped.
- The `hevc`/`master`/`web` profiles and vertical/short presets (party-po WARN: no stated value
  beyond "the table exists") are a **separate, smaller** follow-on — additive to `profiles.ts`
  once a real caller needs 4K delivery, a ProRes editing intermediate, or web embed, independent
  of whether the chunking gate ever fires.
- `003`'s forward-compatibility note (`.specclaw/changes/003-motion-system/spec.md`'s Notes:
  *"The `min`-guarded transition-overlap arithmetic in FR12 is the piece 005 (encoder) will need
  to read before it can decide whether chunk boundaries may fall inside a transition's overlap
  window"*) is **not consumed by v1** (there are no chunk boundaries to place) but is recorded
  here so the eventual `chunk.ts` implementer finds it without re-deriving it from scratch.
