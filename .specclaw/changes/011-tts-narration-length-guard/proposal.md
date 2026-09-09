# Proposal: Narration blocks are auto-chunked before synthesis, so Kokoro's token cap can't silently truncate them

**Created:** 2026-09-09
**Status:** 🟡 Draft

**Revision note:** this was originally bundled with a CLI-resolution fix in one proposal
(`010-cli-staleness-and-tts-truncation`), reviewed together by this project's party panel
(standard tier, 3 seats, 2 rounds — see that change's `party-report.md`). The panel found the two
bugs independent (party-po) and found this half's original design — warn-only, with auto-chunking
as a vague "stronger option" — under-specified at the seam where chunking would actually happen
(party-architect: it would desync the block cardinality `computeAudioDurationsRecord` depends on),
untestable without a real model (party-architect), and resting on the unproven assumption that
someone reads a stderr warning at all (party-ba, and confirmed by this exact project's own
experience: change 009's already-fixed bug went unnoticed through fully successful render output).
This revision resolves all of those by making auto-chunking the one specified behavior — not a
warning, not an option — applied before synthesis ever happens.

## Problem

_What problem are we solving? Why does it matter?_

`packages/audio/src/tts.ts`'s `synthesize()` calls `kokoro-js`'s `KokoroTTS.generate()`, which
tokenizes with `truncation: true` and then caps the style-vector lookup at 509 tokens
(`generate_from_ids`: `256 * Math.min(Math.max(input_ids.dims.at(-1) - 2, 0), 509)`). Kokoro
tokenizes the *phonemized* string, not raw words, so the practical word budget per call is well
under what an author would guess from word count alone.

Nothing in `synthesize()`, the CLI's `validate` command, or the render pipeline
(`packages/cli/src/render-pipeline.ts`) checks input length before or after this call. The result:
audio that is cut off mid-sentence, with no thrown error, no logged warning — and because a scene's
`"auto"` duration is computed directly from the (silently truncated) synthesized audio's own length,
nothing on the timeline flags that anything is wrong either. This was hit directly authoring a real
spec: several 150-300-word narration blocks produced audible mid-sentence clipping, found only by
listening to the rendered output and cross-checking `ffprobe`-reported scene durations against
expected word counts — not by any tool feedback. The manual workaround — splitting a long block
into several shorter, sentence-aligned entries in the `narration` array by hand — works (each array
entry is already synthesized and measured independently), but nothing does it automatically, and
nothing tells an author they need to.

## Proposed Solution

_What are we building? High-level approach._

Make the fix automatic and unconditional, applied at spec-normalization time — **before** the
narration array reaches `synthesizeNarration`/`computeAudioDurationsRecord`, not inside them:

- A new normalization step (in `packages/core`, alongside the spec's other load-time
  normalization) walks every scene's `narration` array and replaces any block whose estimated
  length risks Kokoro's token cap with **multiple sentence-aligned sub-blocks**, each safely under
  the threshold. This runs once, before the timeline is compiled and before any audio is
  synthesized, so `synthesizeNarration` and `computeAudioDurationsRecord` see only the
  already-normalized array — their existing one-block-in, one-synthesis-call-out,
  one-duration-out contract is unchanged, because by the time they run there is no over-length
  block left to split. This directly answers review's cardinality concern: there is no
  sub-block/authored-block mismatch to reconcile downstream, because normalization happens upstream
  of every consumer that cares about block count.
- The length estimator is a **pure, deterministic text-splitting function** — no model, no
  phonemization, no network: split on sentence boundaries (reusing the same boundary logic a
  narration author would apply by hand — see the existing manual workaround), then greedily group
  sentences into chunks under a conservative word-count threshold. Because it's pure text
  processing, it is fully unit-testable in isolation, with no injected model or `synthesize` stub
  required — this answers review's testability concern for the estimator itself.
- The threshold is a named, configurable constant (not asserted as a precise fact): derived
  conservatively from Kokoro's documented 509-token cap, deliberately padded down to account for
  the variable phonemes-per-word ratio across English text (numbers, abbreviations, and punctuation
  all phonemize to different lengths per word) — the constant's doc comment states this derivation
  and that it is a conservative heuristic, not a measured exact limit.
- **Why auto-chunk instead of a warning, or documentation alone:** a warning (in `validate` or at
  render time) only helps if it's read and acted on — this project's own change 009 already
  demonstrates that a fully-successful render's output can hide a real defect that nobody notices
  until the rendered artifact itself is reviewed. Auto-chunking removes that dependency entirely:
  the bug becomes structurally impossible rather than merely flagged, for the same implementation
  cost as building the estimator a warning would have needed anyway (the estimator's output *is*
  the chunk boundaries — chunking is not additional work over detecting the risk, it is what
  happens once the risk is detected). Documentation alone was also considered and rejected for the
  same reason: it depends on an author reading and remembering it before hitting the bug, which is
  exactly the failure mode this proposal exists to remove.
- `validate` surfaces normalization as **informational output**, not a warning to react to: when a
  spec is validated, any scene whose narration was split reports how many sub-blocks it became (e.g.
  "scene `intro`: 1 narration block auto-split into 3"), on `validate`'s normal stdout output
  alongside its existing scene/duration summary — informational because there is nothing left to
  fix; nothing blocks, nothing needs to be read to avoid a bug.

## Scope

### In Scope
- `packages/core`: the narration-block normalization step (sentence-aligned auto-chunking),
  applied once at spec-load/normalization time, ahead of timeline compilation.
- The length-estimation heuristic (pure function, no model dependency), as a named, documented,
  conservative constant plus its derivation rationale.
- `packages/cli`'s `validate` command: informational per-scene reporting of any narration block
  that was auto-split, on stdout alongside existing validation output.
- Unit tests for the normalization step: an over-length single block becomes multiple
  sentence-aligned sub-blocks, each under threshold, whose concatenated text equals the original;
  a block already under threshold passes through unchanged; a block containing an abbreviation-like
  single-capital-letter-period pattern (e.g. an initial, "D. Smith") is not incorrectly split
  mid-name (matching the sentence-boundary heuristic already proven out in the manual workaround
  used on this exact bug).
- An integration-level check (with a fake/injected `synthesize` returning length proportional to
  input text, per review's suggested seam) confirming a scene's total `"auto"` duration reflects
  the full, un-truncated narration text end-to-end — not just that normalization produced the right
  sub-blocks in isolation.
- A doc comment on the `NarrationBlock` type and/or `SKILL.md` stating that narration length is
  now handled automatically, so an author (or an agent driving the skill) does not need to
  pre-chunk long narration by hand — retiring the manual workaround as a requirement, while leaving
  it valid (a pre-chunked array still passes through unchanged).

### Out of Scope
- The CLI-resolution/global-install-staleness fix — split out to `010-cli-resolution-freshness`.
- Exact token-count prediction (running real phonemization purely to validate length) — the
  threshold is a deliberately conservative heuristic, not a precise measurement.
- Changing Kokoro's own token cap, pinned model, or upstreaming a fix into `kokoro-js`.
- Any change to how a *manually* pre-chunked narration array (the existing workaround) behaves —
  it already passes through the normalizer unchanged, since none of its blocks exceed the
  threshold.

## Impact

- **Files affected:** 4-6 — a new normalization module in `packages/core`, the threshold constant
  and its doc comment, `packages/cli`'s `validate` command output, `NarrationBlock`/`SKILL.md`
  documentation, plus new unit/integration test files.
- **Complexity:** small — the estimator and splitter are pure text-processing functions; the only
  integration point is inserting one normalization pass ahead of timeline compilation.
- **Risk:** low. The normalization step only changes output for narration blocks that already risk
  silent truncation today (i.e. it can only make previously-broken audio correct, not change
  already-correct audio, since already-under-threshold blocks pass through unchanged). The main risk
  is a false-positive split on a block that would not actually have been truncated — cosmetically
  different audio pacing (more, shorter Kokoro calls) but not incorrect, and no worse than the
  manual workaround already in production use.

## Open Questions

- Should the auto-split threshold be user-configurable per spec (e.g. a `meta` field), or is a
  single project-wide conservative constant sufficient? No evidence yet that different specs need
  different thresholds; starting with a single constant, revisit if a real need surfaces.
- Does retiring the manual pre-chunking workaround as *documented guidance* (since it's now
  automatic) risk anyone relying on the old guidance to hand-tune pacing in a way auto-chunking
  might now override? Worth a design-time check of whether any existing published example
  (`.claude/skills/video-generator/examples/*.json`) depends on manual chunking's exact block
  boundaries for a reason beyond avoiding truncation.

## Dependency Bypass

## Item Split

## Resumes Split

---

**To proceed:** Review this proposal and approve to begin planning.
