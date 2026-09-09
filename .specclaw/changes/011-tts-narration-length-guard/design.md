# Design: Narration blocks are auto-chunked before synthesis, so Kokoro's token cap can't silently truncate them

**Change:** 011-tts-narration-length-guard
**Created:** 2026-09-09

## Technical Approach

Add the chunking as a `.transform()` stage on the existing `narrationSchema` in
`packages/core/src/schema.ts`, immediately after today's shape-normalization `z.preprocess` step:

```ts
// packages/core/src/narration-chunking.ts

/** Conservative word-count ceiling per synthesized narration block. Kokoro's documented hard cap
 * is 509 *phoneme* tokens (see packages/audio/src/tts.ts), not words — this constant is
 * deliberately padded well below the word count that maps to in the common case, because the
 * phonemes-per-word ratio varies with punctuation, numbers, and abbreviations. It is a safety
 * margin, not a measured exact limit. */
export const MAX_SAFE_NARRATION_WORDS = 90;

/** Pure: splits `text` on sentence boundaries, then greedily groups sentences into chunks of at
 * most `maxWords` words. A single-capital-letter-plus-period token (an initial, e.g. "D.") is
 * never treated as a sentence boundary. Concatenating the result with a single space between
 * chunks reproduces `text`. */
export function chunkNarrationText(text: string, maxWords = MAX_SAFE_NARRATION_WORDS): string[] {
  // 1. protect "<Capital>. " patterns from the sentence-boundary regex
  // 2. split on /(?<=[.!?])\s+(?=[A-Z])/ against the protected text
  // 3. un-protect, then greedily accumulate sentences into <= maxWords-word chunks
}
```

```ts
// packages/core/src/schema.ts (extract)
import { chunkNarrationText } from "./narration-chunking.js";

const narrationSchema = z
  .preprocess((value) => { /* existing shape normalization, unchanged */ }, z.array(narrationBlockSchema))
  .transform((blocks) =>
    blocks.flatMap((block) =>
      chunkNarrationText(block.text).map((text) => ({ ...block, text }))
    )
  ) as unknown as z.ZodType<NarrationBlockType[], z.ZodTypeDef, string | NarrationBlockType | NarrationBlockType[]>;
```

Because every command (`validate`, `render`, `preview`, `generate --render`, `batch`) reaches
`packages/cli/src/render-pipeline.ts` only via `@claudevid/core`'s `parseSpec`
(`packages/core/src/diagnostics.ts`: `videoSpecSchema.safeParse(json)`), this one change point is
sufficient — `synthesizeNarration` and `computeAudioDurationsRecord` never see an over-length block,
because by the time `parseSpec` returns, chunking has already happened. No change to either
function, and no new pipeline stage.

`validate`'s reporting (Functional Requirement 3) needs the *authored* block count (before
normalization) to compare against the *resolved* count (after). `runValidate` already has the raw
parsed JSON (`json = JSON.parse(raw)`) in scope before calling `parseSpec(json)` — a small local
helper counts each scene's raw `narration` field the same way `narrationSchema`'s own
shape-normalization does (`Array.isArray(v) ? v.length : v == null ? 0 : 1`), without needing any
metadata threaded through `parseSpec`'s return value or the `NarrationBlock` type itself.

## Architecture

No new pipeline stage, no new package. The chunking function lives in `packages/core` (already the
home of `narrationSchema`/`narrationBlockSchema` and the package `validate` already depends on for
schema parsing) rather than `packages/audio` — `validate` has no existing dependency on
`packages/audio` and this design keeps it that way, per the proposal's stated placement decision.

## File Changes Map

| File | Action | Description |
|------|--------|-------------|
| `packages/core/src/narration-chunking.ts` | Create | `MAX_SAFE_NARRATION_WORDS` constant + pure `chunkNarrationText()`. |
| `packages/core/src/schema.ts` | Modify | `narrationSchema` gains a `.transform()` applying `chunkNarrationText` to every resolved block, flat-mapping one block into N sibling blocks when it splits. |
| `packages/core/src/index.ts` | Modify | Export `chunkNarrationText` and `MAX_SAFE_NARRATION_WORDS` (needed by `validate.ts`'s reporting, and generally useful as public API for anything else that wants to preview chunking without a full spec parse). |
| `packages/core/test/narration-chunking.test.ts` | Create | Unit tests for `chunkNarrationText`: pass-through under threshold, splits over threshold with exact concatenation equality, initials are not split on. |
| `packages/core/test/schema.test.ts` | Modify | Extend existing narration-schema tests: an over-length block resolves to multiple `NarrationBlock`s carrying the original `voice`/`speed`; an under-threshold block is unaffected (byte-identical to today's resolved shape). |
| `packages/cli/src/commands/validate.ts` | Modify | `runValidate` computes each scene's authored narration block count from the raw parsed JSON and compares it to the resolved count; appends a line per scene where they differ. |
| `packages/cli/test/validate.test.ts` | Modify | Extend with a fixture spec containing a long narration block, asserting the reported message names the scene and both counts; existing no-narration/short-narration fixtures assert unchanged output. |
| `packages/cli/test/render-pipeline.test.ts` | Modify | Add a case using the existing injectable `synthesizeFn` seam: a fake synthesize returning audio length proportional to input text length, spec with one over-length narration block, asserting the scene's computed `"auto"` duration reflects the full original text (not a truncated prefix). |
| `.claude/skills/video-generator/SKILL.md` | Modify | Update the "Rendering also needs..." paragraph to state that narration length is handled automatically (chunked as needed) rather than leaving per-block length as an unstated author responsibility. |

## Data Model Changes

None to the `VideoSpec`/`Scene`/`NarrationBlock` *schema* — the input shape an author writes is
unchanged (`narration` still accepts a string, a single block, or an array). Only the *resolved*
in-memory shape can now contain more `NarrationBlock` entries per scene than were authored, which
is already exactly what today's shape-normalization step does for the string/single-object input
forms (one authored value, one-or-more resolved blocks) — this change extends an existing,
already-asymmetric input/output contract rather than introducing a new kind of asymmetry.

## API Changes

- `packages/core`'s public exports (`index.ts`) gain `chunkNarrationText` and
  `MAX_SAFE_NARRATION_WORDS` — additive, no existing export changes shape.
- `claudevid validate`'s stdout message gains additional lines only when a narration block was
  actually split; the existing `${sceneCount} scenes, ~${totalSeconds}s${autoSuffix}` summary line
  is unchanged in every other case (Acceptance Criterion 6).

## Key Decisions

- **Chunk at parse time (`schema.ts`), not at render time (`render-pipeline.ts`).** Party review's
  BLOCK finding on the original (pre-split) proposal was that splitting inside
  `synthesizeNarration` would desync the block cardinality `computeAudioDurationsRecord` depends
  on. Chunking inside the schema's own transform means every consumer of a parsed `VideoSpec` —
  not just the render pipeline — already sees the post-chunk array; there is no seam left where
  cardinality could disagree, because there is only ever one array per scene from the moment
  `parseSpec` returns.
- **Mandatory, not optional or warn-only.** A warning's value depends on someone reading it —
  this project's own change 009 demonstrates that a fully-successful render's output can hide a
  real defect unnoticed until the rendered artifact itself is reviewed. Making chunking
  unconditional removes that dependency: the bug becomes structurally impossible rather than
  flagged.
- **`packages/core`, not `packages/audio`, for placement.** `validate` has no existing dependency
  on `packages/audio`; putting the estimator/splitter there would pull an audio-model-adjacent
  package into a schema-only command. `packages/core` already owns `narrationSchema`.
- **No new pipeline stage or CLI flag.** Because the fix lives in the schema transform, every
  existing call path (`validate`, `render`, `preview`, `generate --render`, `batch`) gets it for
  free with no per-command wiring.

## Grounding sources

- `packages/core/src/schema.ts` (lines ~26-48) — `narrationBlockSchema`/`narrationSchema`, the
  exact existing preprocessing step this change extends: "Accepts a bare string..., a single
  NarrationBlock-shaped object, or an array of NarrationBlock, and normalizes all three shapes to
  NarrationBlock[]."
- `packages/core/src/diagnostics.ts` — `parseSpec(json)` calls `videoSpecSchema.safeParse(json)`
  and is the single function every CLI command uses to turn raw JSON into a `VideoSpec`,
  confirming the schema-transform placement reaches every call path with no per-command change.
- `packages/cli/src/render-pipeline.ts` — `synthesizeNarration`'s own comment: "Step A —
  synthesizes every narration block up front... every 'auto'-duration scene needs its blocks'
  measured durations to compute a timeline," and `computeAudioDurationsRecord`'s comment: "sums
  each `'auto'`-duration scene's synthesized blocks into the `audioDurations` record" — both
  already treat `scene.narration` as an already-final array, which is exactly the contract this
  change preserves rather than modifies.
- `packages/cli/src/commands/validate.ts` — `runValidate`'s existing message format
  (`` `${spec.scenes.length} ${sceneWord}, ~${totalSeconds}s${autoSuffix}` ``) and its
  `ValidateDeps`-injected, pure, disk-I/O-free test seam, which the new reporting logic extends
  without changing.
- `packages/audio/src/tts.ts` — cited in the (pre-split) proposal for the 509-token cap this
  change's threshold is derived from; unchanged by this design.

## Risks & Mitigations

- **Risk:** a pathologically long single sentence with no internal sentence-ending punctuation
  cannot be split without an artificial mid-sentence break, and remains at risk of truncation.
  **Mitigation:** documented as a known limitation in spec.md's Edge Cases; `validate`'s reporting
  still reflects accurately that no split occurred (honest about the residual risk, not silently
  papered over). Out of scope to solve further in this change.
- **Risk:** chunking changes the exact audio pacing of a scene that previously happened to render
  correctly in full via one long Kokoro call (more, shorter calls instead of one long one).
  **Mitigation:** only blocks *over* the conservative threshold are affected — an already-correct,
  under-threshold block is provably unchanged (Acceptance Criterion 2), so no previously-fine
  scene's audio changes.
- **Risk:** `MAX_SAFE_NARRATION_WORDS`'s specific value is a judgment call, not a derived constant.
  **Mitigation:** documented explicitly as a conservative heuristic in its own doc comment (Design
  Decision above, Non-Functional Requirement 2) rather than presented as measured fact — a future
  change can retune the single constant without any other design change.
