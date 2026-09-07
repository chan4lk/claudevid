# Verification Report: 004-code-block-layer

**Verified:** 2026-09-07
**Verdict:** PASS

## Scope of this verification

Independently re-derived, not trusted from build-agent self-reports:
- Read every relevant source file (`schema.ts`, `highlight.ts`, `layout.ts`, `diagnostics.ts`, `render.ts`, `animations.ts`, `diff.ts`, `annotate.ts`, `themes.ts`, `packages/renderer-canvas/src/painters.ts`, `index.ts` diff) and every test file backing an AC.
- Re-ran `pnpm -r run build`, `pnpm -r run test`, `pnpm -r run lint`, and `pnpm --filter @claudevid/layer-code build`/`test` standalone from the current checkout — all green, matching the committed evidence.
- Ran `git diff --name-only main...HEAD` to check for undeclared scope changes against `tasks.md`'s 15 tasks.
- Read the full regression-fix commit (`dded8f5`) diff line-by-line to confirm both known gaps are genuinely closed, not just claimed.

## Acceptance Criteria

| # | Criterion (abbrev.) | Verdict | Evidence |
|---|---|---|---|
| AC1 | `compileCodeLayers` output JSON-round-trips | ✅ PASS | `test/highlight.test.ts:45` — `expect(JSON.parse(JSON.stringify(ir))).toEqual(ir)`, passing. |
| AC2 | Cross-layer tokenize dedupe: exactly 1 Shiki call for shared `(code,lang,theme)` | ✅ PASS | `test/highlight.test.ts:102-118` — `vi.spyOn(highlighter, "codeToTokensBase")`, asserts `toHaveBeenCalledTimes(1)` across 3 layers; separately, reference-equality test at line 48-59 (`expect(a).toBe(b)`). |
| AC3 | Unsupported `lang: "cobol"` → diagnostic listing all 8 langs, no throw | ✅ PASS | `test/highlight.test.ts:61-73` asserts `suggestion` matches `/typescript/` and `/yaml/`; `test/diagnostics.test.ts:17-25` asserts all 8 names present. |
| AC4 | `measureLine` linear in charCount within 0.01px | ✅ PASS | `test/layout.test.ts:15-22` — asserts `<= 0.01` for charCount `{1,10,80}`. |
| AC5 | 40-line block sized for 20: diagnostic names 40/20, `paintCodeLayer` throws `CodeOverflowError` | ✅ PASS | `test/diagnostics.test.ts:54-67` (names 40 and 20, `blocked: true`); `test/render.test.ts:57-68` — `renderCodeFrame` throws `CodeOverflowError` for a `blocked:true` entry, and asserts zero cache misses (nothing painted before the throw). |
| AC6 | Same scenario + `scroll` config: no overflow diagnostic, no throw | ✅ PASS | `test/diagnostics.test.ts:69-80` — `hasScroll:true` → `diagnostics: []`, `blocked:false`. The "does not throw" half is implicitly and repeatedly exercised: every other render test (`render-cache`, `focus`, `integration`) uses `blocked:false` entries and never throws. |
| AC7 | Static 15-line block, 10 frames: 100% hit rate after frame 1 | ✅ PASS | `test/render-cache.test.ts:45-74` — asserts `misses` stays at 15 across frames 2-10, `hits === 15*9`. |
| AC8 | Typewriter 15-line reveal: `misses <= totalFrames+15`, `hits/(hits+misses) >= 14/15` | ✅ PASS | `test/render-cache.test.ts:95-154` — two dedicated tests, one asserting `misses === LINE_COUNT` exactly (tighter than the spec bound) and the ratio bound, one asserting the steady-state-window ratio directly against `(N-1)/N`. |
| AC9 | `diffLines("a\nb\nc","a\nx\nc")` exact golden output | ✅ PASS | `test/diff.test.ts:8-15` — byte-exact match to the spec's fixture. |
| AC10 | Focus dim: raw pixel buffers differ, dimmed line's luminance closer to background | ✅ PASS | `test/focus.test.ts:74-132` — raw RGBA buffer inequality (`not.toEqual`) plus a real alpha-composite-over-background luminance-distance comparison, not a snapshot image. |
| AC11 | `annotationPosition` y within 1px of `layout`'s own offset | ✅ PASS | `test/annotate.test.ts:13-18` — `Math.abs(pos.y - expectedLine.y) <= 1`; line 20-25 additionally proves it's read verbatim, not re-derived. |
| AC12 | `checkThemeContrast`: zero entries `< 3.0` for all 3 themes | ✅ PASS | `test/themes.test.ts:42-47` — loops all 3 `BUNDLED_THEMES`, asserts `failing` array is empty. |
| AC13 | Standalone + workspace-wide build/test pass | ✅ PASS | Independently re-run: `pnpm --filter @claudevid/layer-code build`/`test` → 13 files, 140 tests pass; `pnpm -r run build && pnpm -r run test` → 258 tests pass (34+38+38+8+140), zero failures. `pnpm -r run lint` also clean (`tsc --noEmit` on all 5 packages). |
| AC14 | End-to-end `parseSpec→compileTimeline→compileCodeLayers→renderFrame`, zero diagnostics, non-empty pixels | ✅ PASS | `test/integration.test.ts` — real pipeline, asserts `compileDiagnostics` and `layoutDiagnostics` both `[]`, then asserts a non-background pixel exists both globally and specifically *within* the code layer's own chrome box (a stronger check than "something painted somewhere" — catches a silent no-op dispatch). |

**Result: 14/14 acceptance criteria PASS.**

## NFR checks

- **NFR1 (no live Shiki instance leaves highlight.ts):** PASS — `compileCodeLayers`'s public return type is `{ compiled: Map<string, TokenizedCode>; diagnostics: Diagnostic[] }`; the `HighlighterCore` instance stays in a module-level singleton inside `highlight.ts`, never returned. Confirmed by reading `highlight.ts` in full.
- **NFR2 (no shiki/highlight.ts import outside highlight.ts):** PASS — `test/no-shiki-outside-highlight.test.ts` greps `render.ts`/`animations.ts`/`diff.ts`/`annotate.ts` for `shiki` imports, `highlight.js` imports, and `./highlight.(js|ts)` imports; all 13 sub-tests pass, including a "sanity" test that the regex *does* match `highlight.ts`'s own real imports (proving the guard isn't vacuously passing).
- **NFR3 (per-line cache hit rate (N-1)/N under typewriter):** PASS — see AC8 above, directly mechanically measured against the cache's own `hits`/`misses` counters.
- **NFR4 (determinism):** Not directly grep/timer-audited in this pass, but no `Math.random`/`Date.now`/wall-clock read was found in `animations.ts`, `diff.ts`, `highlight.ts`, or `render.ts` during reading; `lineStaggerDelays` explicitly delegates to `@claudevid/motion`'s `orderIndices` (FNV-1a, deterministic) per its own doc comment. Assumption, not independently exhaustively grepped for `Math.random`.
- **NFR5 (no network I/O):** PASS — `grep -rn "fetch(|http\.|https\.|axios|node-fetch" packages/layer-code/src/` returns nothing; `highlight.ts`'s imports are exclusively static `import ... from "shiki/langs/<id>.mjs"` / `"shiki/themes/<id>.mjs"` / `"shiki/core"` / `"shiki/engine/javascript"` — the fine-grained bundle FR2 specifies, not the full `shiki` convenience package's dynamic-load path.
- **NFR6 (zero co-changes to core/motion beyond the additive painter registry):** PASS — see Scope section below; `git diff --name-only main...HEAD` shows zero touches to `packages/core` or `packages/motion` source or tests.

## Known-gap regression fixes (explicitly re-verified)

Both fixes cited in the build history were independently confirmed, not just trusted:

1. **Tab-expansion desync (render.ts vs layout.ts).** Commit `dded8f5` adds `expandTokenTabs()` in `render.ts`, called before both the typewriter in-flight-line truncation and the cached-line paint closure. Regression test `test/render.test.ts:150-208` (added in the same commit) renders `"x\ty"` with `tabSize:4`, reads the actual cached bitmap's raw pixels, and asserts paint exists at the tab-expanded column (`x` + 4 spaces → char index 5) and is absent at the buggy raw-index column (2) — a genuine pixel-level regression test, not a mock assertion. Passing.
2. **Out-of-range focus/scroll/annotation diagnostics not wired into `compileCodeLayers`.** Same commit adds a `layoutCode` + `checkLayoutDiagnostics` call inside `compileCodeLayers`'s per-layer loop in `highlight.ts`, folding the results into the function's own returned `diagnostics` array. Four new tests in `test/highlight.test.ts:153-214` call `compileCodeLayers` on a full spec (not the diagnostic builders directly) with out-of-range `focus.lines`, `scroll.toLine`, `scroll.fromLine`, and `annotations[].line`, and all four assert the diagnostic is present with the correct JSON-pointer `path` and message content. All passing — confirms the checks are reachable from the real compile entry point, closing the exact gap described.

## Scope / deviation check

`git diff --name-only main...HEAD` shows changes confined to:
- `packages/layer-code/**` (new package: 11 src files, 13 test files, package.json/tsup/vitest/tsconfig) — matches tasks.md T1-T5, T7-T11 exactly.
- `packages/renderer-canvas/src/painters.ts` (new) + `packages/renderer-canvas/src/index.ts` (modified) + `packages/renderer-canvas/test/painters.test.ts` (new) — matches T6/T14 exactly. Diff of `index.ts` inspected directly: the change is additive (one new `default` branch consulting `getPainter()` before the pre-existing `continue` fallback, plus new named exports `registerPainter`/`getPainter`/`PainterFn`); no existing exported signature changed.
- `pnpm-lock.yaml` (+368 lines — expected from adding `shiki` as a dependency).
- `.specclaw/changes/004-code-block-layer/*` and `.specclaw/STATUS.md` — process artifacts.

**No unexpected touches to `packages/core`, `packages/motion`, or their test suites.** This matches NFR6 exactly and tasks.md's own stated wave plan.

## Test Results (independently re-run, not just quoted from the payload)

```
pnpm --filter @claudevid/layer-code test:  13 files, 140 tests passed
pnpm -r run test (workspace):               34 (core) + 38 (motion) + 38 (renderer-canvas)
                                             + 8 (motion-preview) + 140 (layer-code) = 258 tests passed
pnpm -r run build:                          all 5 workspace projects build clean
pnpm -r run lint:                           all 5 workspace projects (`tsc --noEmit`) clean
```

No failures, no skipped tests, no flaky reruns needed.

## Issues Found

No blocking issues found.

Minor observations (non-blocking, informational only):
1. **NFR4 (determinism) has no dedicated grep-based test**, unlike NFR2's explicit grep test. Reading confirms no `Math.random`/wall-clock usage in the animation/diff/highlight paths, but this is a documentation-strength gap rather than a functional one — a future regression here wouldn't be caught mechanically the way NFR2's would.
2. **AC6's "does not throw" half** has no single test that combines "scroll config present" + "calls `paintCodeLayer` and asserts no throw" in one assertion — it's covered by inference (every `blocked:false` entry across other test files never throws) rather than one dedicated AC6-labeled integration test. Functionally sound, but slightly indirect as evidence.

## Summary

**Passed:** 14/14 acceptance criteria
**Failed:** 0/14 acceptance criteria
**NFRs:** NFR1, NFR2, NFR3, NFR5, NFR6 directly confirmed with evidence; NFR4 plausible but not mechanically grep-tested.
**Scope:** Clean — matches tasks.md's declared 15-task file list, zero undeclared touches to `packages/core`/`packages/motion`.
**Regressions found during build:** Both confirmed genuinely fixed, each with a real pixel-level or pipeline-level regression test added in the same commit.

**Verdict: PASS — 14/14 ACs, 258 tests (140 in layer-code), no regressions, scope clean.**
