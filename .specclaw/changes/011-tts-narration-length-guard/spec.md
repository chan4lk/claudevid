# Spec: Narration blocks are auto-chunked before synthesis, so Kokoro's token cap can't silently truncate them

**Change:** 011-tts-narration-length-guard
**Created:** 2026-09-09
**Status:** 🟡 Draft

## Overview

`packages/audio/src/tts.ts`'s `synthesize()` calls `kokoro-js`'s `KokoroTTS.generate()`, which
tokenizes with `truncation: true` and caps the style-vector lookup at 509 tokens
(`generate_from_ids`). Kokoro tokenizes the *phonemized* string, so the practical word budget per
call is well under what an author would guess from raw word count. A narration block long enough
to exceed it is silently cut off mid-sentence — no thrown error, no logged warning — and because a
scene's `"auto"` duration is computed directly from the (silently truncated) synthesized audio's own
length, nothing on the timeline flags that anything is wrong either.

This change makes narration length safe by construction rather than by author discipline: every
scene's `narration` array is normalized — including, when needed, split into several
sentence-aligned sub-blocks under a conservative word threshold — at spec-parse time, in
`packages/core/src/schema.ts`'s existing `narrationSchema` (the same preprocessing step that
already normalizes a bare string / single object / array into `NarrationBlock[]`). Every consumer
downstream of `parseSpec` (`synthesizeNarration`, `computeAudioDurationsRecord`, and every other
caller in `packages/cli/src/render-pipeline.ts`) already treats `scene.narration` as an array of
independently-synthesized blocks, so this normalization needs no change to any of them — by the
time they run, there is no over-length block left to encounter.

## Requirements

### Functional Requirements

1. A new pure function, `chunkNarrationText(text: string, maxWords?: number): string[]`, in a new
   module `packages/core/src/narration-chunking.ts`, splits `text` on sentence boundaries and
   greedily groups consecutive sentences into chunks of at most `maxWords` words each (default: a
   named, documented constant — see Non-Functional Requirement 2). Concatenating the returned
   chunks (joined by a single space) reproduces the original text. A single-capital-letter-plus-
   period pattern (e.g. an initial like "D. Smith") is not treated as a sentence boundary.
2. `packages/core/src/schema.ts`'s `narrationSchema` applies `chunkNarrationText` to every
   resolved `NarrationBlock`'s `text` after today's shape-normalization step (bare
   string/object/array → `NarrationBlock[]`), replacing any block whose text chunks into more than
   one piece with that many sibling blocks, each carrying the original block's `voice`/`speed`
   unchanged. A block that chunks into exactly one piece (the common case — already under
   threshold) is unaffected: same object shape as today.
3. `packages/cli/src/commands/validate.ts`'s `runValidate` reports, per scene, when narration was
   auto-split: the authored block count (as it appeared in the input JSON, before normalization)
   versus the resolved block count (after normalization), whenever they differ — appended to
   `validate`'s existing stdout summary line(s), not a separate warning stream.
4. No change to `packages/cli/src/render-pipeline.ts`'s `synthesizeNarration` or
   `computeAudioDurationsRecord` — both already synthesize/measure each array entry independently;
   this change relies on that existing contract rather than modifying it.

### Non-Functional Requirements

1. **Testability:** `chunkNarrationText` is a pure function (no model, no phonemization, no I/O) —
   unit-testable directly. The end-to-end guarantee (a scene's total `"auto"` duration reflects the
   *entire* narration text, not a truncated prefix) is verified via `render-pipeline.ts`'s existing
   injectable `synthesizeFn` seam, with no real Kokoro model required.
2. **Threshold is conservative and documented, not asserted as precise.** The word-count threshold
   is a named constant with a doc comment stating it is derived conservatively from Kokoro's
   documented 509-token cap, deliberately padded down to account for the variable phonemes-per-word
   ratio across real English text — not a measured exact limit.
3. **No behavior change for already-short narration.** Any `NarrationBlock` whose text does not
   exceed the threshold resolves to exactly one block, identical to today's output for the same
   input.

## Acceptance Criteria

1. Given a narration block whose text chunks into `N > 1` pieces under `chunkNarrationText`,
   `parseSpec` resolves that scene's `narration` array to `N` sibling `NarrationBlock`s, each
   carrying the original block's `voice`/`speed`, whose `text` fields — concatenated in order —
   reproduce the original text exactly.
2. Given a narration block whose text chunks into exactly 1 piece, `parseSpec` resolves it to the
   same single-block shape produced today (no observable change).
3. Given a narration block containing a single-capital-letter-plus-period pattern (e.g.
   `"...analyst D. Wickramasinghe."`), `chunkNarrationText` does not split immediately after the
   initial.
4. Given a spec with a scene whose single authored narration block is long enough to require
   splitting, and a fake `synthesizeFn` (injected via `RenderPipelineOptions`) that returns audio
   whose length is proportional to its input text's character count, that scene's computed
   `"auto"` duration reflects the **full** original text's proportional length — not the length of
   only the first sub-block or any prefix of the original text.
5. `validate`'s output for a spec containing an auto-split narration block names the affected scene
   and reports both the authored and resolved block counts.
6. `validate`'s output for a spec with no narration block requiring a split is unchanged from
   today's message format.

## Edge Cases

- **Narration block with fewer words than the threshold but unusual punctuation density**
  (e.g. many short sentences). `chunkNarrationText` groups by word count, not sentence count, so
  this does not produce excess splitting — only total accumulated word count per chunk matters.
- **A single sentence alone exceeds the threshold** (e.g. one very long run-on sentence with no
  internal sentence-ending punctuation). `chunkNarrationText` cannot split *inside* a sentence
  without inventing an artificial mid-sentence break; this proposal's scope is sentence-aligned
  chunking, so a pathological single-sentence block over threshold is passed through as its own
  (still over-threshold) chunk rather than mid-sentence-split. Documented as a known limitation,
  not silently handled — `validate`'s reporting (Functional Requirement 3) still surfaces it as
  "1 authored block, 1 resolved block" (no split occurred), which is honest about what happened
  even though the underlying risk isn't fully eliminated for this pathological case.
- **A pre-chunked narration array (the existing manual workaround)** — every block already under
  threshold — passes through unchanged, per Non-Functional Requirement 3. Nothing about this
  change requires an author to undo manual chunking already in place.

## Dependencies

- None beyond what already exists — no new package dependency; `chunkNarrationText` is pure
  TypeScript with no external library.

## Notes

- This spec was split out of an earlier, broader proposal
  (`010-cli-staleness-and-tts-truncation`) that also covered a CLI-resolution-staleness fix. That
  fix is tracked separately in `010-cli-resolution-freshness`; this change is the TTS narration
  guard only.
- The original proposal's design (a warn-only check, with auto-chunking offered only as a vaguer
  "stronger option") was replaced, after party review, with mandatory, automatic chunking at
  parse time — see `proposal.md`'s revision note for the review findings that motivated the
  change (in particular: auto-chunking removes the dependency on a warning actually being read,
  and placing it at parse time avoids the block-cardinality mismatch a later-pipeline-stage split
  would have created).
