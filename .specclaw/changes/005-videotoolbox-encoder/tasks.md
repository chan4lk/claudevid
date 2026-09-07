# Tasks: FFmpeg Encoder — Single-Pipe VideoToolbox/libx264, Argv-Unified

**Change:** 005-videotoolbox-encoder
**Created:** 2026-09-07
**Total Tasks:** 9

## Summary

9 tasks across 4 waves. Wave 1 scaffolds the package and its shared types plus the two
zero-FFmpeg-dependency modules (`probe.ts`, `argv.ts`) that everything else builds on. Wave 2
builds `profiles.ts` (which depends on `probe.ts`'s `EncoderCapabilities` shape and
`argv.ts`'s `ResolvedProfile` shape) and `temp.ts` (independent of profiles/argv, only depends
on Wave 1's scaffolding). Wave 3 builds `pipe.ts` — the module that chains everything from
Waves 1–2 together — plus its full test suite split into a zero-FFmpeg file and an isolated
live-FFmpeg file. Wave 4 builds `tools/bench` (the only consumer that also touches
`@claudevid/core`/`@claudevid/renderer-canvas`) and runs the full-workspace regression pass.
This is a much smaller scope than 003/004: 5 source files + types + tools/bench, no
`worker_threads`, no chunking, no cache — the scope cut documented in spec.md's Overview and
Notes.

## Tasks

### Wave 1 — Package scaffolding, shared types, probe.ts, argv.ts

- [x] `T1` — Package scaffolding + shared types
  - Files: `packages/encoder-ffmpeg/package.json`, `tsup.config.ts`, `vitest.config.ts`, `tsconfig.json`, `src/types.ts`, `src/index.ts` (stub)
  - Estimate: small
  - Kind: config
  - Notes: Mirror `packages/renderer-canvas`'s package.json/tsup/vitest config shape (private,
    ESM, `main`/`types`/`exports` pointing at `dist/`). **No internal `@claudevid/*` dependency**
    — this package depends only on Node built-ins (design.md NFR3/Architecture). `src/types.ts`
    defines `FrameGeometry`, `ResolvedProfile`, `EncoderCapabilities`, `ProgressEvent`,
    `ArgvInput` per spec.md FR1-FR3/FR9 — plain interfaces, no logic.

- [x] `T2` — `probe.ts`: capability detection with injectable spawn seam
  - Files: `packages/encoder-ffmpeg/src/probe.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T1
  - Notes: `probe(execFn = child_process.spawn): Promise<EncoderCapabilities>` per spec.md FR1 /
    design.md's `probe.ts` section. Runs `ffmpeg -version` (presence/version) then `ffmpeg
    -hide_banner -encoders` (regex-matches `\bh264_videotoolbox\b` / `\blibx264\b` — **only**
    these two codecs, not the original four-codec list). A spawn `error` event (covers `ENOENT`)
    resolves `{ ffmpegPresent: false, h264_videotoolbox: false, libx264: false }` rather than
    throwing. `execFn` is the named test seam — must default to the real `spawn` so production
    call sites pass nothing.

- [x] `T3` — `argv.ts`: sole owner of the complete FFmpeg argv
  - Files: `packages/encoder-ffmpeg/src/argv.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T1
  - Notes: `buildArgv(input: ArgvInput): string[]` per spec.md FR2 / design.md's `argv.ts`
    section — a pure, branchless mapping from the 4-field `ArgvInput` to the exact flag array
    pinned in spec.md FR2 (raw-RGBA-stdin input flags, `-fps_mode passthrough`, bt709 tagging,
    `-pix_fmt yuv420p`, codec/bitrate, `-movflags +faststart`). No other file in this package
    may construct an FFmpeg flag — `pipe.ts` (T6) must call this and append nothing of its own.

- [x] `T4` — Zero-FFmpeg unit tests for T2/T3
  - Files: `packages/encoder-ffmpeg/test/probe.test.ts`, `packages/encoder-ffmpeg/test/argv.test.ts`
  - Estimate: medium
  - Kind: test
  - Depends: T2, T3
  - Notes: Covers AC1, AC2 (probe, via a fake `execFn` returning a fake `ChildProcess`-shaped
    `EventEmitter` — no real process spawned) and AC3, AC4 (argv, exact-array assertions for
    both the `final`/1080p and `preview`/720p cases, plus the structural check that no
    `-vf scale` or other resolution-transform flag ever appears). Zero FFmpeg binary required
    to run this file (spec.md NFR4 / CI cost budget).

### Wave 2 — profiles.ts, temp.ts

- [x] `T5` — `profiles.ts`: profile table + codec resolution + actionable fallback
  - Files: `packages/encoder-ffmpeg/src/profiles.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T2, T3
  - Notes: `PROFILE_TABLE` per spec.md FR3 (`preview: 4000` kbps, `final: 18000` kbps — codec +
    bitrate **only**, never dimensions). `resolveProfile(name, capabilities, opts)` per FR4 /
    design.md's `profiles.ts` section: throws `FfmpegNotFoundError` if `!ffmpegPresent`; picks
    `h264_videotoolbox` when available and `!opts.cpuEncode`, else `libx264`; emits the exact
    `fallbackNotice` string from spec.md FR4 when VideoToolbox was wanted but unavailable (no
    notice when `cpuEncode` was explicitly requested); throws if `cpuEncode` was requested but
    `libx264` is also unavailable (Edge Cases).

- [x] `T6` — `temp.ts`: temp-dir lifecycle + signal handling
  - Files: `packages/encoder-ffmpeg/src/temp.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T1
  - Notes: `createTempRun(baseDir?)` per spec.md FR10 / design.md's `temp.ts` section —
    `<root>/claudevid-encode-<uuid>` naming, `registerChild(child)`, idempotent `cleanup()`,
    `SIGINT`/`SIGTERM` handler that SIGTERMs registered children then cleans up then exits.
    **No `cache.ts` in this change** — this is the sole owner of every encode's on-disk
    artifacts (spec.md FR10's explicit statement of the moot BLOCK finding).

- [x] `T7` — Tests for T5/T6
  - Files: `packages/encoder-ffmpeg/test/profiles.test.ts`, `packages/encoder-ffmpeg/test/temp.test.ts`
  - Estimate: medium
  - Kind: test
  - Depends: T5, T6
  - Notes: Covers AC5, AC6 (profiles — fallback notice content, `FfmpegNotFoundError`) and AC10
    (temp — dir created/removed, and a signal-handling test that spawns a **dummy long-running
    child process** in place of FFmpeg, registers it on a `TempRun`, sends the child's parent
    process a `SIGTERM`, and asserts both the dummy child and the temp dir are gone afterward).
    Zero FFmpeg binary required (spec.md NFR4).

### Wave 3 — pipe.ts (the integration point) + its tests

- [x] `T8` — `pipe.ts`: single-pipe encode, backpressure, progress parsing, `EncodeError`
  - Files: `packages/encoder-ffmpeg/src/pipe.ts`, `packages/encoder-ffmpeg/src/index.ts` (finalize exports)
  - Estimate: large
  - Kind: impl
  - Depends: T3, T5, T6
  - Notes: `createEncodePipe(opts: EncodeOptions): EncodePipe` per spec.md FR5/FR8/FR9 /
    design.md's `pipe.ts` section. Chains `resolveProfile` (T5) → `buildArgv` (T3) → `spawn`;
    registers the child on `opts.tempRun` if supplied (T6); `write()` awaits `once(stdin,
    "drain")` when `stdin.write()` returns `false` — real backpressure, not a hint; exported
    pure `parseProgressLine(line): ProgressEvent | null` (FR9 — the `frame=` counter IS the
    timeline-global index in v1, stated in a comment referencing FR9); `EncodeError{exitCode,
    stderrTail}` on non-zero exit with a 20-line stderr ring buffer; `write()`/`finish()` after
    `finish()`/`cancel()` throws synchronously (Edge Cases). `pipe.ts` calls `resolveProfile`/
    `buildArgv` and appends **zero** flags of its own (the FR2 contract T3 established).

- [x] `T9` — pipe.ts test suite: zero-FFmpeg parser test + isolated live-FFmpeg file
  - Files: `packages/encoder-ffmpeg/test/progress-parse.test.ts`, `packages/encoder-ffmpeg/test/pipe.live.test.ts`
  - Estimate: large
  - Kind: test
  - Depends: T8
  - Notes: `progress-parse.test.ts` covers AC7 against `parseProgressLine` directly (no process
    spawned). `pipe.live.test.ts` is a **separate file** (per design.md's "CI cost budget" /
    Risks — isolatable if a runner lacks FFmpeg) covering, each on a synthetic clip capped at a
    few seconds/small resolution and forcing `cpuEncode: true`: AC8 (strictly-increasing
    `ProgressEvent.frame` sequence ending at the true frame count), AC9 (`cancel()` leaves zero
    live FFmpeg processes — check via the child's own `.exitCode`/`.killed` plus a `kill(pid, 0)`
    liveness probe after `cancel()` resolves), AC11 (single-frame known-colour round-trip via a
    second FFmpeg decode pass), AC12 (the SSIM quality gate against a synthetic high-contrast
    text pattern via `-lavfi ssim`, floor `>= 0.92` per spec.md FR7).

### Wave 4 — tools/bench + full-workspace regression

- [x] `T10` — `tools/bench`: standalone bench script
  - Files: `tools/bench/package.json`, `src/reference-spec.ts`, `src/bench.ts`, `test/bench-args.test.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T8
  - Notes: Per spec.md FR11 / design.md's `bench.ts` section. Deps: `@claudevid/core`,
    `@claudevid/renderer-canvas`, `@claudevid/encoder-ffmpeg` (this package's only consumer of
    the render stack — design.md D7). `reference-spec.ts` defines a **short** default reference
    `VideoSpec` (e.g. 10s at 1080p30, not the full 30-minute target — spec.md AC13/Notes).
    `bench.ts` renders every frame via `compileTimeline`/`renderFrame`, pipes each into
    `createEncodePipe`, and prints render ms/frame p50/p95, render fps, encode fps (from
    `ProgressEvent`s), and wall clock against the documented `<15/<10/<5`min targets scaled to
    the reference spec's own duration. Invoked directly (`pnpm --filter @claudevid/bench
    bench`), **not** wired to a `claudevid` CLI subcommand (007's job, out of scope here). Not
    part of the fast `pnpm -r run test` tier — `bench-args.test.ts` covers only its own
    CLI-argument parsing, mirroring `tools/motion-preview`'s precedent.

- [x] `T11` — Workspace-wide build/test/lint pass + bench smoke run
  - Files: none (verification task)
  - Estimate: small
  - Kind: test
  - Depends: T4, T7, T9, T10
  - Notes: `pnpm -r run build`, `pnpm -r run test`, `pnpm -r run lint` all green from a clean
    checkout (AC14) — confirms 001-004's existing suites are unaffected (NFR3). Additionally run
    `tools/bench` once manually against its short reference spec and confirm it completes and
    prints all documented metrics (AC13) — this is a smoke check that the harness itself works,
    **not** a run against the real 30-minute reference (that gate decision stays deferred per
    spec.md Notes). Reconcile every AC in spec.md against a task above before marking this
    change built.

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
  - Kind: docs | test | config | refactor | impl | migration
  - Depends: <task ids> (if any)
  - Notes: <additional context>
```
