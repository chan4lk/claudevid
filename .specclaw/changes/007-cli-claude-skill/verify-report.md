# Verify Report: 007-cli-claude-skill

**Verdict:** PASS

## Acceptance Criteria

- [PASS] **AC1** — `claudevid init` creates config/.gitignore/example, refuses without `--force`, overwrites with it. `packages/cli/test/init.test.ts:33` "scaffolds config, .claudevid/.gitignore, and specs/example.json in a fresh directory", `:49` "refuses to overwrite an existing claudevid.config.json without --force" (throws `ArgError`), `:56` "overwrites ... when --force is set". All 3 tests pass (`init.test.ts (3 tests)`).

- [PASS] **AC2** — `validate` exits 0 on valid examples, exits 1 with a JSON-pointer diagnostic on invalid/malformed input. `packages/cli/test/validate.test.ts:38/47` cover success paths, `:67` "reports failure with the missing field's JSON pointer for an invalid spec", `:75` "reports failure at pointer / for malformed JSON, without throwing" — matching FR2's exact requirement that malformed JSON reports one diagnostic at `/`, not a stack trace. 4/4 tests pass.

- [PASS] **AC3** — `runRenderPipeline` sums two auto-duration narrated scenes' durations into the mux call. `packages/cli/test/render-pipeline.test.ts:120-140`, test titled "AC3: two auto-duration narrated scenes, no captions — mux gets the summed narration duration" asserts `graphCalls[0].outputDurationSeconds` ≈ `BLOCK_DURATION_SECONDS * 2` and that `muxCalls[0].silentVideoPath !== opts.outputPath`. Per NFR3 this is deliberately fixture-driven (no real ffmpeg); the actual duration-tolerance guarantee this AC references ("mux.ts's existing tolerance") is independently exercised by `packages/audio/test/mux.test.ts`'s real-FFmpeg smoke test, which the Test Output confirms passing.

- [PASS] **AC4** — captions insertion is timeline-absolute. `render-pipeline.test.ts:142-163`, "AC4: opts.captions inserts exactly one timeline-absolute captions layer per narrated scene" — asserts exactly one `captions` layer per narrated scene and `words[0].start ≈ sceneAWindow.startFrame / FPS`, i.e. timeline-absolute not block-relative. A companion test (`:165`) confirms the no-narration edge case is a no-op.

- [PASS] **AC5** — repair loop attempt counting and last-attempt-diagnostics. `packages/claude/test/generate.test.ts:13` "resolves with the correct spec and attempts:2 after one repair round-trip" and `:36` "rejects with only the last attempt's diagnostics when always invalid" — explicitly asserts only the last attempt's diagnostics are kept. `:83` covers custom `repairAttempts`.

- [PASS] **AC6** — `mergeChapters` ordering and collision handling. `packages/claude/test/chapters.test.ts:16` concatenation-in-order test, `:39` "throws SceneIdCollisionError naming a shared scene id and does not return a partial merge", `:61` "names every colliding id, not just the first".

- [PASS] **AC7** — drift check. `packages/claude/test/generated-assets.test.ts` regenerates prompt/schema in-memory and diffs against committed files, plus byte-identity checks between `packages/claude/schemas` and `.claude/skills/video-generator/schemas`. 4/4 tests pass.

- [PASS] **AC8** — batch skip-and-record semantics. `packages/cli/test/batch.test.ts:34-88` confirms malformed job2 is recorded as failed without calling runJob, incremental manifest writes, and that individual job failures never throw (only queue-level failures propagate).

- [PASS] **AC9** — `models install` exit/print behavior. `packages/cli/test/models.test.ts` tests `runModelsInstall` resolving `ok:true` on success and `ok:false` with the thrown error's exact message on rejection.

- [PASS] **AC10** — build/test/lint all green. `pnpm -r run build/lint/test` all pass: `packages/claude` 21/21 tests, `packages/cli` 67/67 tests; all pre-existing packages (001-006, 008) unaffected.

## Lint / Build / Test / E2E Results

- **Lint:** PASS — all 11 workspace projects clean, no errors.
- **Build:** PASS — all 11 packages build cleanly (ESM + DTS).
- **Test:** PASS — 21/21 (`claude`) and 67/67 (`cli`) tests pass, plus all pre-existing packages.
- **E2E:** SKIPPED — no e2e tier configured for this change (`not_configured`). AC3's end-to-end mux-duration guarantee is covered instead by `packages/audio`'s existing real-FFmpeg smoke test, so AC3 is not capped by the missing e2e tier.

## Gaps (if any)

None blocking. Verify-context payload had a truncation artifact (changed-files/test-output sections cut before reaching cli/claude packages); compensated by reading source/tests directly and re-running build/lint/test on the working tree.
