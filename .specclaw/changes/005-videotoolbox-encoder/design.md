# Design: FFmpeg Encoder — Single-Pipe VideoToolbox/libx264, Argv-Unified

**Change:** 005-videotoolbox-encoder
**Created:** 2026-09-07

## Technical Approach

```
                         probe.ts
              (execFn seam; real child_process.spawn by default)
                             │
                             ▼
                    EncoderCapabilities
              { ffmpegPresent, ffmpegVersion?,
                h264_videotoolbox, libx264 }
                             │
              ┌──────────────┴───────────────┐
              ▼                               │
        profiles.ts                           │
   resolveProfile(name, capabilities, opts)    │
     - looks up { bitrateKbps } from the       │
       PROFILE_TABLE (preview | final)         │
     - picks codec: videotoolbox if available   │
       and not opts.cpuEncode, else libx264      │
     - throws FfmpegNotFoundError if !ffmpegPresent
     - returns { resolved: ResolvedProfile,
                 fallbackNotice? }
              │                               │
              ▼                               │
        ResolvedProfile                       │
      { codec, bitrateKbps }                  │
              │                               │
              ▼                               │
          argv.ts                             │
   buildArgv({ profile, geometry, inputPath,   │
               outputPath })                   │
     - THE sole owner of the complete FFmpeg    │
       argv. Raw-RGBA-stdin input flags +        │
       fps_mode/colour/pix_fmt/movflags +         │
       codec/bitrate flags. One array, one place. │
              │                                    │
              ▼                                    │
          pipe.ts                                  │
   createEncodePipe(opts: EncodeOptions)             │
     - spawn(ffmpegPath, buildArgv(...), ...)         │
     - write(frame) → stdin.write() → await drain      │
       if needed (real backpressure)                    │
     - stderr → parseProgressLine → ProgressEvent         │
     - non-zero exit → EncodeError{exitCode,stderrTail}    │
              │                                              │
              ▼                                              │
          temp.ts  ◄───────────────────────────────────────────┘
   createTempRun(baseDir?)
     - dir: <root>/claudevid-encode-<uuid>
     - registerChild(ffmpegChild)  — called by tools/bench / any caller
     - SIGINT/SIGTERM handler: SIGTERM the registered child, then cleanup()
     - cleanup(): idempotent, removes dir

              (only tools/bench wires the render stack in)
                             │
tools/bench/src/bench.ts:
  compileTimeline(spec) [core] → renderFrame(...) [renderer-canvas, per frame]
     → pipe.write(frameBuffer.data) → pipe.finish()
     → report render ms/frame p50/p95, render fps, encode fps (from ProgressEvent),
       wall clock, vs. documented targets
```

Five source modules in `packages/encoder-ffmpeg/src`, each with exactly one job, none of which
constructs FFmpeg flags except `argv.ts`:

- `probe.ts` — capability *detection* only. Never resolves a codec, never builds a command line.
- `profiles.ts` — codec/bitrate *resolution* only. Never touches geometry, never spawns anything.
- `argv.ts` — flag *construction* only. Pure function, no I/O, no spawning.
- `pipe.ts` — process *lifecycle* only (spawn, write, parse stderr, exit handling). Calls
  `argv.ts` for its flags and `profiles.ts` (via the caller-supplied `capabilities`/`cpuEncode`)
  for its codec — never invents either itself.
- `temp.ts` — filesystem/process-hygiene lifecycle only. Owns directories and signal handling;
  never touches FFmpeg flags or stdin.

`tools/bench` is the only consumer that also imports `@claudevid/core`/`@claudevid/renderer-
canvas` — the core encoder package stays dependency-free of the render stack (NFR3).

## Grounding sources

- `packages/renderer-canvas/src/frame-buffer.ts` — `FrameBuffer = { width, height, data:
  Buffer }`, `data.length === width*height*4`. This is the exact byte layout `pipe.ts`'s
  `write(frame: Buffer)` expects and `argv.ts`'s `-pix_fmt rgba -s WxH` input declaration
  assumes — no transformation happens between a rendered frame and what gets piped to FFmpeg's
  stdin.
- `.specclaw/changes/002-canvas-render-engine/spec.md` (AC2 + Notes) — `canvas.data()` returns
  RGBA (matching FFmpeg's `-pix_fmt rgba`) and premultiplied alpha is a non-issue for the final
  composited frame because v1 assumes it's always fully opaque. This is the empirical grounding
  for `argv.ts` declaring `-pix_fmt rgba` on the input side with no premultiply-correction step
  anywhere in this package.
- `packages/core/src/timeline.ts` — `Timeline.frameCount`/`activeAt` is "the only timing
  authority in the system." `tools/bench` reads `Timeline.frameCount` to know how many frames
  to render/encode; the core encoder package itself has no timing authority of its own (it
  encodes exactly the frames it's given, in the order given).
- `packages/core/src/types.ts` — `VideoSpec.width`/`height`/`fps` are the sole source of frame
  geometry `tools/bench` passes into `argv.ts`'s `ArgvInput.geometry` — grounds FR3's "profiles
  never carry dimensions" statement in an actual existing type rather than an assumption.
- `party-report.md` (this change's own adversarial review) — the six BLOCK findings and the
  fixes each maps to: argv split → `argv.ts` sole ownership (FR2); chunk cache-key gap → moot,
  no `cache.ts` in v1; `temp.ts`/`cache.ts` lifecycle contradiction → moot, only `temp.ts`
  exists; CLI scope → `tools/bench` is a standalone script, not a subcommand (FR11); output-
  resolution two-sources-of-truth → `profiles.ts` carries codec+bitrate only (FR3); chunking
  priced only against the aggressive target → this entire v1 scope cut (spec.md Overview).
- `GOALS.md`'s "005 — FFmpeg VideoToolbox Encoder..." section — this repo's own distilled
  backlog restating the panel's BLOCK findings as a checklist; used to cross-check that every
  item under "Resolve before building" has a corresponding FR/section in this spec/design (see
  spec.md's "Panel resolution points, located").
- This sandbox's live FFmpeg (`ffmpeg -version` → `N-124098-ge717604a29`, x86_64 Linux,
  `--enable-libx264`, no VideoToolbox) — used directly during planning to run the indicative
  single-pipe smoke bench (spec.md Notes) and to confirm the exact shape of `-encoders` output
  `probe.ts`'s regex needs to match (`ffmpeg -encoders 2>&1 | grep -i x264` →
  `V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)`).

## Architecture

```
packages/encoder-ffmpeg/
  package.json                # deps: none internal (Node built-ins only)
  tsup.config.ts
  vitest.config.ts
  tsconfig.json
  src/
    types.ts                  # FrameGeometry, ResolvedProfile, EncoderCapabilities,
                               # ProgressEvent, ArgvInput — shared shapes, no logic
    probe.ts                  # probe(execFn?), EncoderCapabilities, FfmpegNotFoundError-adjacent
    profiles.ts                # PROFILE_TABLE, resolveProfile()
    argv.ts                     # buildArgv() — sole flag owner
    pipe.ts                      # createEncodePipe(), EncodeError, parseProgressLine()
    temp.ts                       # createTempRun()
    index.ts                       # public exports
  test/
    probe.test.ts               # AC1, AC2 — injected execFn, no live ffmpeg
    profiles.test.ts             # AC5, AC6 — resolveProfile logic, no live ffmpeg
    argv.test.ts                  # AC3, AC4 — exact-array pins, no live ffmpeg
    progress-parse.test.ts         # AC7 — parseProgressLine, no live ffmpeg
    temp.test.ts                    # AC10 — dir lifecycle + signal handling, dummy child
    pipe.live.test.ts                 # AC8, AC9, AC11, AC12 — real small-clip FFmpeg encodes
                                        # (isolated file so a CI runner without FFmpeg can skip
                                        # this one file specifically — see "CI cost budget")

tools/bench/
  package.json                # deps: @claudevid/core, @claudevid/renderer-canvas,
                               # @claudevid/encoder-ffmpeg
  src/
    reference-spec.ts         # the fixed VideoSpec bench renders against
    bench.ts                  # render loop + pipe wiring + stats reporting (FR11)
  test/
    bench-args.test.ts        # CLI-argument-only checks, mirrors motion-preview's own tier
                               # (not a rendering test — not part of the fast suite)
```

### `probe.ts`

```ts
export interface EncoderCapabilities {
  ffmpegPresent: boolean;
  ffmpegVersion?: string;
  h264_videotoolbox: boolean;
  libx264: boolean;
}

// The injectable seam (resolution point 4): defaults to the real child_process.spawn so
// production code never has to pass anything, but every test passes a fake.
export async function probe(
  execFn: typeof import("node:child_process").spawn = spawn
): Promise<EncoderCapabilities> {
  const versionResult = await runCapture(execFn, ["-version"]);
  if (!versionResult.ok) {
    return { ffmpegPresent: false, h264_videotoolbox: false, libx264: false };
  }
  const ffmpegVersion = parseVersionLine(versionResult.stdout);   // first line, e.g. "ffmpeg version N-..."
  const encodersResult = await runCapture(execFn, ["-hide_banner", "-encoders"]);
  const stdout = encodersResult.ok ? encodersResult.stdout : "";
  return {
    ffmpegPresent: true,
    ffmpegVersion,
    h264_videotoolbox: /\bh264_videotoolbox\b/.test(stdout),
    libx264: /\blibx264\b/.test(stdout),
  };
}
```

`runCapture` wraps `execFn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] })`, collects
stdout, and resolves `{ ok: false }` on a spawn `error` event (covers both `ENOENT` — binary
missing — and any other spawn failure) rather than letting it throw uncaught. A test's fake
`execFn` returns a minimal fake `ChildProcess`-shaped `EventEmitter` that either emits `error`
(AC1) or emits `data` on a fake stdout stream with canned encoder-list text (AC2) — no real
process is ever spawned in these tests.

### `profiles.ts`

```ts
export const PROFILE_TABLE = {
  preview: { bitrateKbps: 4000 },
  final:   { bitrateKbps: 18000 },
} as const;
export type ProfileName = keyof typeof PROFILE_TABLE;

export class FfmpegNotFoundError extends Error {
  constructor() {
    super("FFmpeg not found on PATH. Install FFmpeg (https://ffmpeg.org/download.html) and " +
          "ensure it is on PATH, or pass an explicit ffmpegPath.");
    this.name = "FfmpegNotFoundError";
  }
}

export function resolveProfile(
  name: ProfileName,
  capabilities: EncoderCapabilities,
  opts: { cpuEncode?: boolean } = {}
): { resolved: ResolvedProfile; fallbackNotice?: string } {
  if (!capabilities.ffmpegPresent) throw new FfmpegNotFoundError();
  const bitrateKbps = PROFILE_TABLE[name].bitrateKbps;
  const wantsVideotoolbox = !opts.cpuEncode;
  if (wantsVideotoolbox && capabilities.h264_videotoolbox) {
    return { resolved: { codec: "h264_videotoolbox", bitrateKbps } };
  }
  const resolved: ResolvedProfile = { codec: "libx264", bitrateKbps };
  if (wantsVideotoolbox) {
    // VideoToolbox was wanted but unavailable — this is the fallback case, notice fires.
    return {
      resolved,
      fallbackNotice:
        "h264_videotoolbox not available on this machine; falling back to libx264 (slower). " +
        "Install FFmpeg with VideoToolbox support or pass { cpuEncode: true } to silence this.",
    };
  }
  // cpuEncode explicitly requested — libx264 chosen on purpose, no notice.
  if (!capabilities.libx264) {
    throw new Error(
      "cpuEncode was requested but libx264 is not available in this FFmpeg build " +
      `(h264_videotoolbox: ${capabilities.h264_videotoolbox}, libx264: false).`
    );
  }
  return { resolved };
}
```

### `argv.ts`

```ts
export interface FrameGeometry { width: number; height: number; fps: number }
export interface ResolvedProfile { codec: "h264_videotoolbox" | "libx264"; bitrateKbps: number }
export interface ArgvInput {
  profile: ResolvedProfile;
  geometry: FrameGeometry;
  inputPath: string;   // "-" for the stdin raw-RGBA pipe
  outputPath: string;
}

export function buildArgv({ profile, geometry, inputPath, outputPath }: ArgvInput): string[] {
  return [
    "-y",
    "-f", "rawvideo",
    "-pix_fmt", "rgba",
    "-s", `${geometry.width}x${geometry.height}`,
    "-r", `${geometry.fps}`,
    "-i", inputPath,
    "-fps_mode", "passthrough",
    "-pix_fmt", "yuv420p",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-colorspace", "bt709",
    "-c:v", profile.codec,
    "-b:v", `${profile.bitrateKbps}k`,
    "-movflags", "+faststart",
    outputPath,
  ];
}
```

No branch, no conditional flag, no profile-name lookup inside this function — it is a pure
data-to-array mapping over exactly the four fields of `ArgvInput`. Any future caller (a
chunking follow-on's per-chunk encode, for instance) reuses this unchanged; only `inputPath`/
`outputPath` would differ per chunk, never the flag *shape*.

### `pipe.ts`

```ts
export class EncodeError extends Error {
  constructor(message: string, public readonly exitCode: number | null, public readonly stderrTail: string[]) {
    super(message);
    this.name = "EncodeError";
  }
}

export interface ProgressEvent { frame: number; fps?: number; speedX?: number; timeSeconds?: number }

const PROGRESS_RE =
  /frame=\s*(\d+)\s+fps=\s*([\d.]+).*?time=(\d{2}):(\d{2}):(\d{2})\.(\d{2}).*?speed=\s*([\d.]+)x/;

export function parseProgressLine(line: string): ProgressEvent | null {
  const m = PROGRESS_RE.exec(line);
  if (!m) return null;
  const [, frame, fps, hh, mm, ss, cs, speedX] = m;
  const timeSeconds = Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(cs) / 100;
  return { frame: Number(frame), fps: Number(fps), speedX: Number(speedX), timeSeconds };
}

export interface EncodeOptions {
  profileName: "preview" | "final";
  geometry: FrameGeometry;
  outputPath: string;
  capabilities: EncoderCapabilities;   // caller-supplied — pipe.ts never calls probe() itself
  cpuEncode?: boolean;
  ffmpegPath?: string;                 // default "ffmpeg"
  tempRun?: TempRun;                   // if supplied, the spawned child is registered on it
}

export interface EncodePipe {
  write(frame: Buffer): Promise<void>;
  finish(): Promise<void>;
  cancel(): Promise<void>;
  onProgress(cb: (e: ProgressEvent) => void): void;
}

export function createEncodePipe(opts: EncodeOptions): EncodePipe {
  const { resolved, fallbackNotice } = resolveProfile(opts.profileName, opts.capabilities, { cpuEncode: opts.cpuEncode });
  if (fallbackNotice) console.warn(fallbackNotice);   // visible, not swallowed (proposal problem #2)
  const argv = buildArgv({ profile: resolved, geometry: opts.geometry, inputPath: "-", outputPath: opts.outputPath });
  const child = spawn(opts.ffmpegPath ?? "ffmpeg", argv, { stdio: ["pipe", "ignore", "pipe"] });
  opts.tempRun?.registerChild(child);

  const stderrTail: string[] = [];               // ring buffer, last 20 lines
  const progressCbs: ((e: ProgressEvent) => void)[] = [];
  let finished = false;

  // stderr: line-buffer, feed every line through parseProgressLine; non-matching lines
  // (banner, warnings) still get appended to stderrTail for EncodeError's evidence.
  readLines(child.stderr!, (line) => {
    pushRing(stderrTail, line, 20);
    const evt = parseProgressLine(line);
    if (evt) progressCbs.forEach((cb) => cb(evt));
  });

  return {
    async write(frame) {
      if (finished) throw new Error("EncodePipe already finished");
      const ok = child.stdin!.write(frame);
      if (!ok) await once(child.stdin!, "drain");
    },
    async finish() {
      if (finished) throw new Error("EncodePipe already finished");
      finished = true;
      child.stdin!.end();
      const [code] = await once(child, "exit");
      if (code !== 0) throw new EncodeError(`ffmpeg exited with code ${code}: ${stderrTail[stderrTail.length - 1] ?? ""}`, code, [...stderrTail]);
    },
    async cancel() {
      if (finished) return;
      finished = true;
      child.kill("SIGTERM");
      await once(child, "exit");
    },
    onProgress(cb) { progressCbs.push(cb); },
  };
}
```

### `temp.ts`

```ts
export interface TempRun {
  dir: string;
  cleanup(): Promise<void>;
  registerChild(child: ChildProcess): void;
}

export function createTempRun(baseDir: string = os.tmpdir()): TempRun {
  const dir = path.join(baseDir, `claudevid-encode-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  let children: ChildProcess[] = [];
  let cleaned = false;

  const onSignal = async () => {
    await cleanup();
    process.exit(0);  // re-raise-equivalent: this package owns exit here since it installed the handler
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    for (const child of children) if (!child.killed) child.kill("SIGTERM");
    await fs.promises.rm(dir, { recursive: true, force: true });
  }

  return {
    dir,
    cleanup,
    registerChild(child) { children.push(child); },
  };
}
```

### `tools/bench/src/bench.ts`

```ts
async function main() {
  const spec = referenceSpec();               // fixed VideoSpec, small default duration
  const timeline = compileTimeline(spec);
  const capabilities = await probe();
  const renderer = createRenderer(spec.width, spec.height);
  const frame = createFrameBuffer(spec.width, spec.height);
  const tempRun = createTempRun();
  const pipe = createEncodePipe({
    profileName: "final",
    geometry: { width: spec.width, height: spec.height, fps: spec.fps },
    outputPath: path.join(tempRun.dir, "bench-out.mp4"),
    capabilities,
    tempRun,
  });

  const renderMsSamples: number[] = [];
  const t0 = performance.now();
  for (let f = 0; f < timeline.frameCount; f++) {
    const rt0 = performance.now();
    await renderFrame(timeline, f, frame);
    renderMsSamples.push(performance.now() - rt0);
    await pipe.write(frame.data);
  }
  await pipe.finish();
  const wallMs = performance.now() - t0;

  report({ renderMsSamples, wallMs, frameCount: timeline.frameCount, fps: spec.fps });
  await tempRun.cleanup();
}
```

`report()` prints p50/p95 of `renderMsSamples`, `frameCount / (sum(renderMsSamples)/1000)` as
render fps, `frameCount / (encodeMs/1000)` as encode fps (derived from the last `ProgressEvent`
observed via `pipe.onProgress`), total `wallMs`, and each against the documented `<15/<10/<5`
minute targets scaled to the reference spec's own duration (not literally 30 minutes unless the
reference spec is configured for it — AC13 only requires a short default).

## File Changes Map

| File | Action | Description |
|------|--------|-------------|
| `packages/encoder-ffmpeg/package.json` | create | private, no internal deps, Node built-ins only |
| `packages/encoder-ffmpeg/tsup.config.ts` | create | ESM build |
| `packages/encoder-ffmpeg/vitest.config.ts` | create | test runner |
| `packages/encoder-ffmpeg/tsconfig.json` | create | extends root base |
| `packages/encoder-ffmpeg/src/types.ts` | create | `FrameGeometry`, `ResolvedProfile`, `EncoderCapabilities`, `ProgressEvent`, `ArgvInput` |
| `packages/encoder-ffmpeg/src/probe.ts` | create | `probe(execFn?)`, injectable spawn seam (FR1) |
| `packages/encoder-ffmpeg/src/profiles.ts` | create | `PROFILE_TABLE`, `resolveProfile`, `FfmpegNotFoundError` (FR3/FR4) |
| `packages/encoder-ffmpeg/src/argv.ts` | create | `buildArgv` — sole flag owner (FR2) |
| `packages/encoder-ffmpeg/src/pipe.ts` | create | `createEncodePipe`, `EncodeError`, `parseProgressLine` (FR5/FR8/FR9) |
| `packages/encoder-ffmpeg/src/temp.ts` | create | `createTempRun` (FR10) |
| `packages/encoder-ffmpeg/src/index.ts` | create | public exports |
| `packages/encoder-ffmpeg/test/probe.test.ts` | create | AC1, AC2 |
| `packages/encoder-ffmpeg/test/profiles.test.ts` | create | AC5, AC6 |
| `packages/encoder-ffmpeg/test/argv.test.ts` | create | AC3, AC4 |
| `packages/encoder-ffmpeg/test/progress-parse.test.ts` | create | AC7 |
| `packages/encoder-ffmpeg/test/temp.test.ts` | create | AC10 |
| `packages/encoder-ffmpeg/test/pipe.live.test.ts` | create | AC8, AC9, AC11, AC12 (real FFmpeg, isolated file) |
| `tools/bench/package.json` | create | deps: core, renderer-canvas, encoder-ffmpeg |
| `tools/bench/src/reference-spec.ts` | create | fixed reference `VideoSpec` |
| `tools/bench/src/bench.ts` | create | render+encode loop, stats reporting (FR11) |
| `tools/bench/test/bench-args.test.ts` | create | CLI-argument-only checks, not part of fast rendering tier |

## Data Model Changes

New types, all in `@claudevid/encoder-ffmpeg` (no changes to `@claudevid/core`/`@claudevid/
motion`/`@claudevid/renderer-canvas` types — this package is purely additive and dependency-
free of the render stack per NFR3): `FrameGeometry`, `ResolvedProfile`, `EncoderCapabilities`,
`ProgressEvent`, `ArgvInput`, `EncodeOptions`, `EncodePipe`, `TempRun`, `EncodeError` (class),
`FfmpegNotFoundError` (class).

## API Changes

New package `@claudevid/encoder-ffmpeg` exporting: `probe`, `resolveProfile`, `PROFILE_TABLE`,
`buildArgv`, `createEncodePipe`, `parseProgressLine`, `createTempRun`, `EncodeError`,
`FfmpegNotFoundError`, plus the types above. No existing package's exports change.

## Key Decisions

1. **D1 — argv.ts takes a fully-resolved `ResolvedProfile`, never a profile *name*.** This
   keeps `buildArgv` pure and free of any dependency on `profiles.ts` or `EncoderCapabilities`
   — it only ever sees the two scalars (`codec`, `bitrateKbps`) it needs, which is what makes
   AC3/AC4's exact-array pin possible without also having to fake capability-probing inside an
   argv test. `pipe.ts` is the one place that chains `resolveProfile` → `buildArgv`.
2. **D2 — `pipe.ts` accepts `capabilities` as a parameter rather than calling `probe()`
   internally.** Probing FFmpeg is an I/O-bound, cacheable operation a caller (`tools/bench`,
   eventually 007's CLI) reasonably wants to do once and reuse across multiple encodes in the
   same process. Baking a `probe()` call into every `createEncodePipe` invocation would make
   every encode pay a redundant `ffmpeg -encoders` spawn and would also make `pipe.ts`
   untestable without the same live-FFmpeg dependency `probe.ts`'s own seam exists to avoid.
3. **D3 — `console.warn` for the fallback notice inside `pipe.ts`, not a required callback.**
   The proposal's problem #2 asked for the message to be *visible*, not necessarily
   structured — `resolveProfile`'s returned `fallbackNotice` is the structured, testable form
   (AC5); `pipe.ts` additionally surfaces it via `console.warn` as a pragmatic default so a
   caller that ignores the return value still sees it, without inventing a required logging
   callback parameter this v1 has no second consumer for. A future CLI (007) can intercept this
   more richly if needed; nothing here blocks that.
4. **D4 — `EncodePipe.finish()`/`cancel()` are terminal and idempotent-by-rejection, not
   silently idempotent.** Unlike `TempRun.cleanup()` (D-adjacent, intentionally idempotent
   because signal handlers and explicit callers can race), a second `write()`/`finish()` call
   on an already-finished `EncodePipe` throws rather than silently no-op-ing — this is a
   programmer-error signal (the caller's own state machine is wrong), not a race the package
   needs to absorb gracefully the way OS signals are.
5. **D5 — SSIM over PSNR for the quality gate, and 0.92 chosen as a stated judgment call, not
   derived.** See spec.md FR7 for the reasoning; recorded here as a decision, not re-argued.
6. **D6 — `temp.ts`'s signal handler calls `process.exit(0)` after cleanup.** Node does not run
   pending I/O callbacks or unresolved promises past a fired `SIGINT`/`SIGTERM` by default in
   many configurations, and this package's whole point in the signal-handling path is
   guaranteed cleanup before the process actually goes away — an explicit `exit(0)` after
   `await cleanup()` is more predictable than relying on the default disposition re-raising
   itself, at the cost of always exiting `0` on a signal (accepted: a `SIGINT`-cancelled encode
   is not a *failure* the exit code needs to distinguish in v1; the caller already knows it
   asked for cancellation).
7. **D7 — `tools/bench` is a new package, not a script inside `packages/encoder-ffmpeg`.**
   Mirrors `003`'s `tools/motion-preview` precedent exactly: a tool that exercises the real
   pipeline end-to-end belongs in `tools/*` (its own `pnpm-workspace.yaml` package glob already
   covers this), not inside the library package it's benchmarking, keeping the library's own
   `package.json` free of the render-stack dependencies only the bench tool needs.

## Risks & Mitigations

- **Risk: the indicative sandbox bench number (spec.md Notes) gets mistaken for a real gate
  result.** *Mitigation:* spec.md states explicitly, twice, that it is non-final/non-macOS/
  encode-only and that the actual gate decision is deferred to a real 30-minute run on real
  hardware; AC13 is scoped to "the harness runs and reports numbers," not "the numbers clear
  the target."
- **Risk: `pipe.live.test.ts`'s real-FFmpeg tests are flaky or slow on a CI runner with a
  different FFmpeg build than this sandbox's.** *Mitigation:* every live test forces `cpuEncode:
  true` (libx264 is present on effectively every FFmpeg build, unlike VideoToolbox) and uses
  clips capped at a few seconds/small resolution (NFR4); the file is isolated so a CI
  configuration without FFmpeg at all can skip exactly this one file without losing the rest of
  the suite's coverage.
- **Risk: the SSIM floor (0.92) turns out to be wrong in either direction once real VideoToolbox
  hardware is available** (too loose to catch real ringing, or too strict for VideoToolbox
  specifically at the chosen bitrate). *Mitigation:* the floor is applied against whatever codec
  `resolveProfile` actually picks in the test environment (libx264 in CI, VideoToolbox on real
  macOS) — CI's libx264 run is a strictly *higher*-quality bar than VideoToolbox would produce
  at the same bitrate, so passing in CI doesn't prove VideoToolbox passes; this is recorded
  explicitly rather than silently assumed, and revisiting the floor with a real VideoToolbox
  sample is a natural task for whoever runs the deferred bench on real hardware.
- **Risk: `os.tmpdir()`-based temp dirs accumulate if a process is killed with `SIGKILL`
  (unblockable, unlike `SIGINT`/`SIGTERM`).** *Mitigation:* accepted or v1 — the proposal's own
  process-hygiene goal is about graceful shutdown paths (`Ctrl-C`, normal termination);
  `SIGKILL` survival was never a stated requirement and adding it (e.g., a startup sweep of
  stale `claudevid-encode-*` directories) is a reasonable, separately-scoped follow-on, not
  bundled into this change's temp-dir contract.
