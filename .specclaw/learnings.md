# Learnings: 009-text-layer-centering

Build learnings, spec gaps, and patterns discovered.

**Categories:** spec_gap | design_gap | pattern | best_practice | agent_issue

---

## [L1] agent_issue — specclaw-build finalize's test/lint/build commands invoke...

**When:** 2026-09-08 08:56 UTC
**Category:** agent_issue
**Priority:** medium
**Status:** pending

### Detail
specclaw-build finalize's test/lint/build commands invoke the bare 'pnpm' binary, which is broken in this environment (corrupted global pnpm store pointer) — every finalize run will report tests_passed/lint_passed/build_passed: false even when the actual test suite is green, unless the caller separately verifies with a working invocation (e.g. 'npx pnpm ...').

### Action
Consider configuring test_command/lint_command/build_command in .specclaw/config.yaml to use 'npx pnpm' or a project-local pnpm binary instead of the bare 'pnpm' on PATH, so finalize's automated verdict is trustworthy without a manual double-check.

---

## [L2] agent_issue — Wave 2 ran 3 parallel coding agents (T2, T3, T4) against ...

**When:** 2026-09-09 06:49 UTC
**Category:** agent_issue
**Priority:** medium
**Status:** pending

### Detail
Wave 2 ran 3 parallel coding agents (T2, T3, T4) against one shared checkout (git.strategy: branch-per-change, no worktree-per-task). T3 and T4 both independently staged+committed at nearly the same moment; T4's commit won the race and swept T3's already-staged render.mts/validate.mts changes into its own commit, so T3 has no standalone commit in history even though its file changes are correctly present in HEAD.

### Action
Consider git.strategy: worktree-per-change (or per-task) when running parallel build waves with auto_commit, so concurrent agents can't race on the same working tree's git index.

---
