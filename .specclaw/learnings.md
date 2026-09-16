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

## [L3] best_practice — Instructing each parallel wave agent to stage/commit ONLY...

**When:** 2026-09-09 07:01 UTC
**Category:** best_practice
**Priority:** low
**Status:** pending

### Detail
Instructing each parallel wave agent to stage/commit ONLY its own declared files by exact path (never git add -A/./−a) fully prevented the commit-race class of bug seen in change 010's wave 2 (T3's commit got swept into T4's). All 3 parallel-task waves in this build (2-task and 4-task) produced clean, correctly-attributed single-file commits with zero manual reconciliation needed.

### Action
Consider adding this instruction as a standard line in specclaw-build-context's output for any task sharing a wave with others in a non-worktree git.strategy, rather than relying on the orchestrator to remember to add it per-prompt.

---

## [L4] agent_issue — specclaw-build-context truncated the T5 task Notes mid-se...

**When:** 2026-09-16 02:11 UTC
**Category:** agent_issue
**Priority:** medium
**Status:** pending

### Detail
specclaw-build-context truncated the T5 task Notes mid-sentence at the first backtick-quoted code containing braces ('const resolved = resolveSceneAudioPaths(spec, { specDir: ... })'); the agent had to reconstruct the task from spec/design.

### Action
Avoid brace-bearing inline code in tasks.md Notes, or fix the Notes parser in specclaw-parse-tasks/build-context to preserve them.

---

## [L5] spec_gap — FR3 asked for a repair suggestion on the narration-xor-au...

**When:** 2026-09-16 02:11 UTC
**Category:** spec_gap
**Priority:** low
**Status:** pending

### Detail
FR3 asked for a repair suggestion on the narration-xor-audio superRefine issue, but diagnostics.ts suggestionFor() returns undefined for Zod custom issues, so the diagnostic ships with the message only (no suggestion). Same for AC5: a strict() violation surfaces at pointer '/' with the key named in the message, not at '/audio'.

### Action
When a spec requires a suggestion on a custom refinement, include diagnostics.ts in the owning task's file list; state unrecognized-key diagnostics as path '/' + key in message.

---

## [L6] pattern — Pre-013 builds silently rendered a spec whose scene carri...

**When:** 2026-09-16 02:11 UTC
**Category:** pattern
**Priority:** medium
**Status:** pending

### Detail
Pre-013 builds silently rendered a spec whose scene carried an unknown 'audio' key: Zod strip mode dropped it, duration:auto with no narration resolved to 0 frames, and render exited 0 with an unplayable MP4 (ffprobe duration N/A). videoSpecSchema.strict() (T1) turns this into a '/' unrecognized-key diagnostic.

### Action
Keep videoSpecSchema strict; consider strict() on sceneSchema and layer schemas so typos in author-facing fields fail at validate, not at playback.

---

## [L7] agent_issue — specclaw-build finalize reported tests_passed/lint_passed...

**When:** 2026-09-16 02:11 UTC
**Category:** agent_issue
**Priority:** medium
**Status:** pending

### Detail
specclaw-build finalize reported tests_passed/lint_passed/build_passed=false because config.yaml's commands call bare 'pnpm' (broken here, learnings L1); the same commands under 'npx pnpm@10' were green (471 tests across 11 packages).

### Action
Switched build.test_command/lint_command/build_command in .specclaw/config.yaml to 'npx pnpm@10 -r --if-present run ...' as L1 recommended.

---

## [L8] agent_issue — specclaw-verify collect produced JSON that failed validat...

**When:** 2026-09-16 02:15 UTC
**Category:** agent_issue
**Priority:** medium
**Status:** pending

### Detail
specclaw-verify collect produced JSON that failed validation ('ignored null byte in input'; a 0x8b byte at offset ~168k), so specclaw-verify-context emitted a payload with no changed-file contents and 'No tests configured' despite config commands being set. Verification evidence had to be assembled by hand.

### Action
Have collect strip/escape non-UTF-8 bytes from captured command output and file contents, and fail loudly instead of emitting a best-effort payload that reads as 'no tests configured'.

---
