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
