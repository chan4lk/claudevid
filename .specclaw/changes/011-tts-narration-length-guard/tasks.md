# Tasks: Narration blocks are auto-chunked before synthesis, so Kokoro's token cap can't silently truncate them

**Change:** 011-tts-narration-length-guard
**Created:** 2026-09-09
**Total Tasks:** 8

## Summary

Four waves, strictly respecting dependency order (a task never shares a wave with something it
depends on, so parallel tasks within a wave never race on the same file): build the pure chunking
primitive alone, then its tests plus the schema wiring in parallel, then everything that only
depends on the schema wiring in parallel, then the one task that depends on that wave's `validate`
change.

## Tasks

### Wave 1 — Chunking primitive

- [x] `T1` — Create `chunkNarrationText()` and `MAX_SAFE_NARRATION_WORDS`
  - Files: `packages/core/src/narration-chunking.ts` (new)
  - Estimate: small
  - Kind: impl
  - Notes: Pure function, no model/phonemization/I-O. Sentence-split on `/(?<=[.!?])\s+(?=[A-Z])/` after protecting single-capital-letter-plus-period tokens (initials) from the split; greedily accumulate sentences into chunks of at most `maxWords` words (default `MAX_SAFE_NARRATION_WORDS`). Concatenating the returned chunks with a single space must reproduce the input text exactly (spec.md AC1). Doc comment on the constant states it is a conservative heuristic derived from Kokoro's 509-phoneme-token cap (see `packages/audio/src/tts.ts`), not a measured exact limit.

### Wave 2 — Its tests, and the schema wiring (parallel — no shared files)

- [x] `T2` — Unit tests for `chunkNarrationText()`
  - Files: `packages/core/test/narration-chunking.test.ts` (new)
  - Estimate: small
  - Kind: test
  - Depends: T1
  - Notes: Cover spec.md's Edge Cases and Acceptance Criteria 1-3: under-threshold text returns a single chunk equal to the input; over-threshold text returns multiple chunks whose concatenation equals the input; a single-capital-letter-plus-period pattern (e.g. `"...analyst D. Wickramasinghe."`) is not split immediately after the initial; a single run-on sentence longer than the threshold with no internal sentence boundary returns itself as one (still-over-threshold) chunk rather than being mid-sentence-split.

- [x] `T3` — Apply chunking in `narrationSchema`'s transform; export the primitive from `packages/core`
  - Files: `packages/core/src/schema.ts`, `packages/core/src/index.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T1
  - Notes: Add a `.transform()` after today's shape-normalization `z.preprocess` step: `blocks.flatMap((block) => chunkNarrationText(block.text).map((text) => ({ ...block, text })))`. Each resulting sibling block keeps the original block's `voice`/`speed`. Export `chunkNarrationText` and `MAX_SAFE_NARRATION_WORDS` from `packages/core/src/index.ts` (needed by `validate.ts` in Wave 3, and generally useful public API).

### Wave 3 — Everything downstream of the schema wiring (parallel — no shared files)

- [~] `T4` — Extend schema tests for the chunking transform
  - Files: `packages/core/test/schema.test.ts`
  - Estimate: small
  - Kind: test
  - Depends: T3
  - Notes: An over-length authored block resolves to multiple `NarrationBlock`s in `parseSpec`'s output, each carrying the original `voice`/`speed` (spec.md AC1). An under-threshold authored block resolves to the same single-block shape produced today — byte-identical to pre-change output (spec.md AC2), including the existing bare-string/single-object/array input-shape tests already in this file.

- [~] `T5` — Report authored-vs-resolved narration block counts in `runValidate`
  - Files: `packages/cli/src/commands/validate.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T3
  - Notes: Using the raw parsed JSON already in scope (before `parseSpec(json)`), count each scene's authored `narration` field the same way `narrationSchema`'s shape-normalization does (`Array.isArray(v) ? v.length : v == null ? 0 : 1`). After a successful parse, compare against `spec.scenes[i].narration.length`; for any scene where they differ, append a line naming the scene and both counts to the existing summary message. No change to the message when no scene's counts differ (spec.md AC6).

- [~] `T7` — End-to-end duration check via the render pipeline's injectable `synthesizeFn`
  - Files: `packages/cli/test/render-pipeline.test.ts`
  - Estimate: small
  - Kind: test
  - Depends: T3
  - Notes: A fake `synthesizeFn` returns audio whose (computed) `durationSeconds` is proportional to `request.text.length`, with no real model. A spec with one `"auto"`-duration scene whose single authored narration block is long enough to split asserts the scene's computed duration reflects the **full** original text's proportional length, not a truncated prefix (spec.md AC4) — this is the test the pre-split proposal's review flagged as missing.

- [x] `T8` — Update `SKILL.md`'s narration-length note
  - Files: `.claude/skills/video-generator/SKILL.md`
  - Estimate: small
  - Kind: docs
  - Depends: T3
  - Notes: The existing "Rendering also needs..." paragraph should state that narration length is handled automatically (long blocks are chunked at parse time) rather than leaving per-block length as an unstated author responsibility — retiring the manual pre-chunking workaround as a *requirement* (a pre-chunked array still passes through unchanged per spec.md's Edge Cases, so nothing about existing authored specs needs to change).

### Wave 4 — `validate`'s reporting tests (depends on Wave 3's `validate.ts` change)

- [ ] `T6` — Tests for `validate`'s auto-split reporting
  - Files: `packages/cli/test/validate.test.ts`
  - Estimate: small
  - Kind: test
  - Depends: T5
  - Notes: A fixture spec with one scene whose narration block is long enough to split reports the scene name plus authored/resolved counts (spec.md AC5). Existing no-narration and short-narration fixtures continue to produce today's unchanged message (spec.md AC6) — this task extends, and must not break, the existing test file's current cases.

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
  - Kind: docs | test | config | refactor | impl | migration   (optional; hints the build subagent's role, tools, and model)
  - Depends: <task ids> (if any)
  - Notes: <additional context>
```
