# Verify Report — 008-forced-alignment-captions-audio-graph

**Verified:** 2026-09-07
**Model:** claude-sonnet-5

## Overall Verdict: **PASS**

All 12 acceptance criteria are met by real, working code — not by rubber-stamped summaries. `pnpm -r run build`, `pnpm -r run lint`, and `pnpm -r run test` all pass across the full workspace when run cleanly (build: clean; lint: clean; test: 12/12 packages green, including a genuine, non-skipped live-model run of AC11). One pre-existing, already-documented flake (`renderer-canvas/test/perf.test.ts`, from change 002) was observed and re-confirmed as environmental, not a regression. One real, non-blocking gap is flagged as a WARN below (hardcoded `DEFAULT_FPS=30` in the captions painter) and documented in spec.md's Notes as a known limitation.

## Per-AC Findings

- **AC1 (clean 1:1 reconciliation)** — PASS. `align.test.ts`'s clean-stream case exercises the real Levenshtein-style DP in `align.ts`, producing one `WordTiming` per reference word, all `estimated: false`.
- **AC2 (dropped/inserted/reordered fixtures)** — PASS. Three distinct fixture cases each produce exactly one `WordTiming` per reference word under `allowEstimated: true`. Reordering is genuinely handled: a diagonal DP step onto a *different* word is excluded from "matched" (align.ts:180-186), so a swapped pair honestly falls out as unmatched rather than silently inheriting wrong timestamps.
- **AC3 (invalid timestamp rejection)** — PASS. Validation checks non-negative, bounded, monotonic, throwing `AlignmentValidationError` naming the check + word index (align.ts:361-389).
- **AC4 (fail-closed default / allowEstimated opt-in)** — PASS. `LowConfidenceSpanError` by default; proportional fill + `estimated: true` + `estimatedSpans` under opt-in.
- **AC5 (captions layer registration + no reverse dependency)** — PASS, verified structurally: `grep -rn "layer-captions" packages/core/ packages/renderer-canvas/` returns zero hits. `registerLayer`/`registerPainter` mirror layer-code's exact pattern.
- **AC6 (argv-safety)** — PASS, verified directly in graph.ts: every `filePath` is a standalone `-i` argv element; the filter-complex string is built only from `[N:a]` references and validated numbers. Tested against a deliberately hostile path containing filter metacharacters.
- **AC7 (ducking level)** — PASS. Real FFmpeg run (gated), measures the music track's intermediate level pre-loudnorm, ≥3dB reduction asserted and observed.
- **AC8 (distinct-path mux, temp+rename, duration tolerance)** — PASS. Verified control flow: same-path guard, temp+rename only after both exit-0 and duration-tolerance checks pass, cleanup on any failure path.
- **AC9 (SRT/VTT with estimated marker)** — PASS. `[estimated]...[/estimated]` marker, per-word cue granularity (documented v1 simplification).
- **AC10 (lexicon digest → cache key)** — PASS. `resolveLexiconDigest` tested directly for entry-variance and absent-word no-op. Minor coverage gap (NOTE): no `cache.test.ts` case varies only `lexiconDigest` to assert a cache miss the way `speed`/`modelDigest` are tested — inferred correct (whole-object hash) but not directly exercised. Not a blocker.
- **AC11 (gated live-model integration)** — PASS, genuinely verified running: `align.ts`'s `ASR_MODEL_ID` confirmed switched to `Xenova/whisper-tiny.en` (from `onnx-community/whisper-base`, which lacked cross-attentions for word timestamps — caught by this same live test during build, fixed same day). Live run in this verify pass actually executed real network + real Whisper inference and passed (not skipped).
- **AC12 (full workspace build/test/lint)** — PASS. Build/lint clean. Test: one instance of the pre-confirmed `renderer-canvas/test/perf.test.ts` flake under concurrent load, reconfirmed passing in isolation — not a regression.

## Design.md Key Decisions Spot-Check

- **D1** (ASR via `@huggingface/transformers`, no whisper.cpp) — PASS, confirmed via package.json + repo-wide grep.
- **D4** (layer-captions structural independence) — PASS, see AC5.
- **D5** (graph.ts reuses encoder-ffmpeg's `probe()`) — PASS, confirmed real import, not a reimplementation.
- **D7** (no new motion track type) — PASS, confirmed zero files touched in `packages/motion`.

## Concerns

1. **WARN — hardcoded `DEFAULT_FPS = 30`** in `packages/layer-captions/src/render.ts` — real correctness gap: captions desync from audio on any `VideoSpec` with `fps !== 30` (proportional to `actualFps/30`). Inherited from `layer-code`'s identical pre-existing pattern (`PainterFn` carries no `fps`). Not a blocking AC failure (spec.md makes no fps-agnostic promise) but a foreseeable, likely-to-bite gap. Documented as a known limitation in spec.md's Notes; fix deferred to whichever future change next touches `PainterFn`'s signature (benefits `layer-code` too).
2. **NOTE** — AC10's cache-miss behavior for `lexiconDigest` specifically is inferred from the whole-object-hash mechanism, not directly tested. Not a blocker.
3. **NOTE** — known flake reconfirmed (`renderer-canvas/test/perf.test.ts`, change 002, sandbox-load-sensitive, not a regression).
