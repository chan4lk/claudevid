# Verification Report: 005-videotoolbox-encoder

**Verified:** 2026-09-07
**Model:** claude-sonnet-5
**Verdict:** PASS

## Scope-Cut Documentation Check

Before the AC table: the task specifically asked me to confirm the deliberate scope reduction (full chunked-rendering proposal → single-pipe encoder) is documented, not silently dropped.

- `spec.md` line 15: *"**This is a scope-cut v1.** The original proposal's parallel scene-chunk rendering pipeline (`chunk.ts`/`pool.ts`/`concat.ts`/`cache.ts`...) is **entirely deferred**, per the party panel's upheld `party-po` BLOCK finding..."*
- `spec.md`'s "Deferred to follow-on" Notes section explicitly re-states which modules are cut and why chunk-level resume goes with them.
- `GOALS.md`'s 005 section: *"**Scope decision (resolves the BLOCK findings):** adopted party-po's own BLOCK-severity fix — v1 ships `probe`/`argv`/`pipe`/`profiles` (preview+final only)/`temp`/`tools/bench`, single-pipe only. `chunk.ts`/`pool.ts`/`concat.ts`/`cache.ts`... are cut entirely from this change and deferred to a follow-on, gated on `tools/bench`'s real 30-minute Apple Silicon number failing to clear the <15min primary target."*

Confirmed on disk that no `chunk.ts`/`pool.ts`/`concat.ts`/`cache.ts` exist anywhere in the repo — `packages/encoder-ffmpeg/src/` contains exactly `probe.ts`, `argv.ts`, `pipe.ts`, `profiles.ts`, `temp.ts`, `types.ts`, `index.ts`. Documented, not an oversight. **PASS.**

## Acceptance Criteria

- ✅ **AC1:** `probe()` with `execFn` simulating FFmpeg absent (ENOENT) returns `{ffmpegPresent:false, h264_videotoolbox:false, libx264:false}` — `packages/encoder-ffmpeg/test/probe.test.ts` "probe (AC1) — FFmpeg entirely absent" passes with a fake `execFn` that emits `error` (never a real spawn); re-ran `pnpm --filter @claudevid/encoder-ffmpeg test` myself, all 34 tests green.
- ✅ **AC2:** `probe()` with canned `-encoders` output (libx264 only) returns `{ffmpegPresent:true, h264_videotoolbox:false, libx264:true}` — `probe.test.ts` "probe (AC2)" covers both/one/none-present cases exactly, no real spawn.
- ✅ **AC3:** `buildArgv` for the pinned `final`/1080p30 input returns the exact array from FR2 — `packages/encoder-ffmpeg/src/argv.ts` is a pure, branchless 30-line function; `test/argv.test.ts` asserts `toEqual` against the literal pinned array element-for-element. Verified by reading `argv.ts` directly — it is the sole flag-emitting function in the package.
- ✅ **AC4:** `preview` profile at 1280x720/30fps differs only in `-s`/`-b:v`/`outputPath`, and a structural check (`test/argv.test.ts`, "buildArgv — structural check (AC4)") asserts no `-vf`/`-filter`/`-filter:v`/`scale=` token appears in either array.
- ✅ **AC5:** `resolveProfile("final", {...h264_videotoolbox:false, libx264:true})` returns `libx264` + a `fallbackNotice` containing both `"h264_videotoolbox"` and `"libx264"` — `packages/encoder-ffmpeg/src/profiles.ts` line 63-65 emits the exact FR4-pinned message; `test/profiles.test.ts` "resolveProfile (AC5)" asserts both the exact string and substring containment.
- ✅ **AC6:** `resolveProfile("final", {ffmpegPresent:false,...})` throws `FfmpegNotFoundError` with an actionable, install-referencing message before any spawn — `profiles.ts` line 48, message contains `"Install FFmpeg (https://ffmpeg.org/download.html)..."`; `test/profiles.test.ts` "resolveProfile (AC6)" verifies both the type and message substring, plus that it throws before considering `cpuEncode`.
- ✅ **AC7:** `parseProgressLine` on the exact AC7 sample line returns `{frame:120, fps:30, speedX:1.0, timeSeconds:4}` — `test/progress-parse.test.ts` asserts this exact object, plus null-return cases for banner/warning/incomplete lines, all with zero FFmpeg process involvement.
- ✅ **AC8:** Real 30-frame/320×240 encode emits strictly increasing `ProgressEvent.frame`, last value `=30` — `test/pipe.live.test.ts` "createEncodePipe (AC8)"; re-ran the live suite myself (`pnpm --filter @claudevid/encoder-ffmpeg test`), test passed.
- ✅ **AC9:** `cancel()` mid-encode resolves and leaves zero live FFmpeg processes — `test/pipe.live.test.ts` "createEncodePipe (AC9)" uses `ps`-based PID liveness checks before/after. Re-ran myself: test took **5071ms**, matching the documented `CANCEL_GRACE_MS = 5000` SIGKILL-escalation path in `pipe.ts` (lines 28-31, 202-216) — the file header and inline comment explain this sandbox's FFmpeg doesn't honor SIGTERM while blocked on stdin, so the test genuinely rides out the grace window to the SIGKILL fallback rather than silently masking a slow/broken cancel. This is handled gracefully (documented, bounded, test still passes), not swallowed.
- ✅ **AC10:** `createTempRun()`'s dir exists immediately; `cleanup()` removes it; a SIGTERM'd child process with a registered dummy `sleep` child still gets its dir removed and dummy child killed — `test/temp.test.ts` covers directory creation/removal/idempotent-cleanup/unique-naming (zero-FFmpeg) plus a real cross-process SIGTERM test using a standalone script + `sleep` as the FFmpeg stand-in, per spec's own "no live FFmpeg needed" instruction.
- ✅ **AC11:** Single 64×64 solid-red frame round-trips through `createEncodePipe` and decodes within tolerance 12 of `[255,0,0]` at 5 sample points (corners+center) — `test/pipe.live.test.ts` "createEncodePipe (AC11)"; passed in my own re-run.
- ✅ **AC12:** SSIM quality gate — synthetic text-pattern frame at `final`'s default 18000kbps scores `SSIM >= 0.92` via FFmpeg's own `-lavfi ssim` filter — `test/pipe.live.test.ts` "createEncodePipe (AC12/FR7)"; passed in my own re-run.
- ✅ **AC13:** `tools/bench` runs and reports the documented format — I built the full workspace (`pnpm -r build`) and ran `cd tools/bench && node dist/bench.js` myself against the real pipeline (not a mock). Actual output:
  ```
  frames rendered:        300
  render ms/frame (p50):  0.91ms
  render ms/frame (p95):  1.45ms
  render fps:             971.70
  encode fps:             189.90
  total wall clock:       1579.76ms (1.58s)
  ... scaled PASS/FAIL against primary/aggressive10min/aggressive5min targets, all PASS
  ```
  Matches FR11's documented report shape exactly, against the 10s reference spec (`tools/bench/src/reference-spec.ts`), not the 30-minute target, with the deferred-gate disclaimer text printed inline.
- ✅ **AC14:** `pnpm --filter @claudevid/encoder-ffmpeg build && test` and full-workspace `pnpm -r run build && pnpm -r run test` succeed — ran both myself: encoder-ffmpeg alone (34/34 tests, 6/6 files), full workspace (300/300 tests across `core`(34)/`encoder-ffmpeg`(34)/`motion`(38)/`renderer-canvas`(38)/`bench`(8)/`motion-preview`(8)/`layer-code`(140)), and `pnpm -r run lint` (all `tsc --noEmit` clean). No regressions to 001-004's suites.

No unhandled edge cases found — all seven spec.md Edge Cases (FFmpeg absent, `cpuEncode` with no libx264, zero-frame finish, double-write/finish, missing output dir, idle SIGTERM, double cleanup) have direct code paths or tests (`profiles.test.ts`'s Edge Cases block, `temp.test.ts`'s idempotent-cleanup test, `pipe.ts`'s synchronous-throw comment block lines 219-224).

## NFR Checks

- ✅ **NFR1 (no orphaned processes):** `temp.ts`'s `registerChild`+signal-handler is the single mechanism (verified by reading `temp.ts` in full); `pipe.ts`'s `cancel()` SIGTERM→5s grace→SIGKILL escalation is the same mechanism AC9 exercises for real.
- ✅ **NFR2 (`buildArgv`/`resolveProfile` pure):** Both read as branchless/side-effect-free over their inputs — confirmed by direct reading of `argv.ts` (17-line literal-array return) and `profiles.ts` (no I/O, no `Date`/`Math.random`).
- ✅ **NFR3 (no cross-package dependency):** `packages/encoder-ffmpeg/package.json` has **no** `dependencies` field at all — only `devDependencies` (types/tsup/vitest/typescript). `grep -rn "@claudevid/" packages/encoder-ffmpeg/src/*.ts` finds only comments, no imports. Only `tools/bench/package.json` declares `@claudevid/core`/`@claudevid/renderer-canvas`/`@claudevid/encoder-ffmpeg` as dependencies, and additively (a separate standalone tool package, not a core module). `git diff --name-only main...HEAD` confirms **zero** files touched under `packages/core`, `packages/motion`, `packages/renderer-canvas`, `packages/layer-code`.
- ✅ **NFR4 (CI cost bounded):** Live-FFmpeg suite (`pipe.live.test.ts`) totals 5302ms for 4 tests, entirely dominated by the single documented AC9 grace-window wait; all clips are ≤30 frames at ≤320×240, never the 30-minute bench target. `tools/bench`'s own test file (`bench-args.test.ts`) tests only CLI arg parsing — no render/encode — confirming the "excluded from per-PR CI" claim in spec.md's Notes.
- ✅ **FR12 (no platform special-casing):** `grep -rn "process.platform" packages/encoder-ffmpeg/src/ tools/bench/src/` returns nothing. Confirmed this sandbox's real FFmpeg (`N-124098-ge717604a29`, Linux) has `libx264`/`libx264rgb` and no `h264_videotoolbox` — exactly the fallback path the spec claims is the reference non-macOS case, exercised automatically through `probe()`+`resolveProfile()` with zero branching.

## Test Results

Re-ran independently (not just trusting the build-agent's log):
```
packages/encoder-ffmpeg test: 6 files, 34 tests passed (5.83s total; pipe.live.test.ts alone 5302ms,
  dominated by the documented AC9 SIGKILL-escalation wait)
Full workspace (`pnpm -r run test`): 7 projects, 300 tests passed, 0 failed
  core: 34, encoder-ffmpeg: 34, motion: 38, renderer-canvas: 38, bench: 8, motion-preview: 8, layer-code: 140
Full workspace lint (`pnpm -r run lint`): all `tsc --noEmit` clean, 0 errors
Full workspace build (`pnpm -r run build`): all packages/tools built successfully
tools/bench live run (`node dist/bench.js`): completed in 1.58s wall clock, correct report format, all
  three scaled targets reported PASS (informational only, not the real 30-min gate)
```

## Issues Found

1. **Minor spec/design wording inconsistency on signal disposition (non-blocking).** `spec.md` FR10 states the SIGINT/SIGTERM handler "then re-raises the signal's default disposition," but `temp.ts` (line 63) actually calls `process.exit(0)` unconditionally after cleanup. This is not a bug — `design.md`'s Key Decision D6 explicitly documents and justifies this exact choice ("an explicit `exit(0)` after `await cleanup()` is more predictable than relying on the default disposition re-raising itself... accepted: a SIGINT-cancelled encode is not a failure the exit code needs to distinguish in v1"). No AC tests exit-code semantics, so nothing fails. **Fix (optional, cosmetic):** tighten spec.md FR10's phrasing to match the design.md D6 decision so a future reader doesn't need to cross-reference design.md to resolve the discrepancy.

No other issues found — implementation matches spec.md's pinned contracts (argv, fallback message, error message, progress-line parsing) byte-for-byte where the spec pins exact strings, and every AC has a real, independently-reproduced test result.

## Summary

**Passed:** 14/14 acceptance criteria
**Failed:** 0/14 acceptance criteria
**Verdict:** PASS — single-pipe encoder matches every pinned contract (argv, profiles, probe, progress parsing, temp lifecycle) exactly, all 300 workspace tests and lint pass under independent re-run, `tools/bench` runs for real and reports the documented format, scope is genuinely additive (no `@claudevid/*` core dependency, zero touches to packages/core|motion|renderer-canvas|layer-code), and the scope-cut from the original chunked-rendering proposal is explicitly documented in both spec.md and GOALS.md, not an oversight.
