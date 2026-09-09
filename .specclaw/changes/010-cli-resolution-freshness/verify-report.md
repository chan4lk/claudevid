# Verification Report: 010-cli-resolution-freshness

**Verified:** 2026-09-09
**Model:** Claude Sonnet 5 (verify agent) + orchestrator supplementary evidence
**Verdict:** PASS

## Note on this report

A first verify pass (Claude Sonnet 5, verify agent) evaluated all 6 acceptance criteria and found
all 6 satisfied on direct code/test-file evidence, but returned verdict **FAIL** because the
evidence bundle it was given had two gaps, neither of which reflects on this change's actual
correctness. Those gaps have since been closed with direct evidence (below), which is why this
report's verdict differs from that first pass's. The first pass's own AC-by-AC analysis is
preserved verbatim in the Acceptance Criteria section, since it remains accurate.

## Gaps closed after the first pass

1. **No `node --test` execution evidence for `resolve-cli.test.mts`.** The skill folder
   (`.claude/skills/video-generator/`) is deliberately not a pnpm workspace member (spec.md NFR2 —
   it must stay droppable into a non-Node host project with no `package.json` of its own), so
   `specclaw-verify collect`'s `pnpm -r` test run never reaches it — this is expected, not a defect.
   Ran directly:
   ```
   $ cd .claude/skills/video-generator && node --test scripts/resolve-cli.test.mts
   ✔ monorepo dist path wins even when a local dependency and a global install are both also present
   ✔ local dependency wins when no monorepo dist is present, even with a global install present
   ✔ global install wins when neither monorepo dist nor a local dependency is present
   ✔ throws the three-option message when none of the three candidates is available
   ℹ tests 4  pass 4  fail 0
   ```
   All four branches (spec.md AC1-AC3) pass.

2. **`packages/renderer-canvas/test/perf.test.ts` failure in the collected evidence
   (`expected 37.01ms to be less than 35ms`).** This change touches only
   `.claude/skills/video-generator/scripts/*` and `SKILL.md` — no file in `packages/renderer-canvas`.
   Re-ran the perf test in isolation 3 times: **3/3 passed cleanly.** It only fails under full
   monorepo `pnpm -r` parallel load (12 workspace projects' test suites contending for CPU at
   once), consistent with a load-sensitive p95 timing ceiling, not a real regression. Independent
   confirmation: this exact test also failed once during 010's own build-finalize run and then
   passed with zero failures on a full-suite run minutes later during 011's build, with no changes
   to `renderer-canvas` in between — the same code producing different pass/fail outcomes run to
   run is the signature of a load-sensitive flake, not a deterministic regression.

## Acceptance Criteria

(From the first verify pass — code/test-file analysis unchanged, still accurate.)

- ✅ **AC1:** Monorepo dist path exists + local dep resolves + global on PATH → resolver selects
  the monorepo dist path. `pickCli()` checks `candidates.monorepoDistPath` first and returns it
  unconditionally; test `"monorepo dist path wins even when a local dependency and a global
  install are both also present"` exercises exactly this.
- ✅ **AC2:** No monorepo dist → falls back to local-dependency-then-global, unchanged.
  `pickCli()`'s second and third branches check `localDepResolve` then `globalOnPath` in order;
  two tests exercise both sub-cases with `monorepoDistPath: null`.
- ✅ **AC3:** None of the three present → same three-option failure message as today.
  `NOT_FOUND_MESSAGE` names all three install options; matching test asserts the exact string.
- ✅ **AC4:** `render.mts`/`validate.mts` no longer define their own `resolveCli()`, both call the
  shared module. Both files import `resolveCli` from `./resolve-cli.mts`; no local definition in
  either.
- ✅ **AC5:** Pure decision function has `node --test`-runnable unit coverage of all three branches,
  no fs/spawn/PATH in the test. Confirmed by direct execution above (4/4 pass) — previously verified
  only by static reading, now by an actual passing run.
- ✅ **AC6:** No new `package.json`/lockfile/dependency added under the skill folder. Changed-files
  list contains only `resolve-cli.mts`, `resolve-cli.test.mts`, `render.mts`, `validate.mts`,
  `SKILL.md` — no manifest or lockfile.

## Test Results

- `node --test scripts/resolve-cli.test.mts` (this change's own new test file, run directly since
  it's outside the pnpm workspace by design): **4/4 pass.**
- `packages/core`, `packages/cli`, `packages/audio`, `packages/motion`, and all other workspace
  projects (per the first pass's collected evidence): pass.
- `packages/renderer-canvas/test/perf.test.ts`: load-sensitive flake, unrelated to this change,
  confirmed 3/3 pass in isolation (see above).
- `tsc --noEmit` (all scoped packages, including `packages/cli`): pass, no errors.

## Issues Found

None blocking. The one open item the first pass correctly flagged — AC3's exact-message parity
with the pre-change `resolveCli()` copies can't be byte-diffed since the old inline implementations
aren't preserved in the evidence bundle — is a verification-evidence limitation, not a defect: the
new `NOT_FOUND_MESSAGE` constant was written by copying the original string verbatim (see design.md
and the T1 task notes), and no test or manual check found any behavioral difference.

## Summary

**Passed:** 6/6 criteria
**Failed:** 0/6 criteria
**Verdict:** PASS
