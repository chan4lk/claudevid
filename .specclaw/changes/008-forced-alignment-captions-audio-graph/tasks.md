# Tasks: Forced-Aligned Captions, Speech-Synced Motion & Audio Graph

**Change:** 008-forced-alignment-captions-audio-graph
**Created:** 2026-09-07
**Total Tasks:** 10

## Summary

10 tasks across 5 waves. Wave 1 adds the shared word-timing types and the `lexiconDigest`
extension to `SynthesisRequest` (both zero-dependency, everything else builds on them). Wave 2
builds `align.ts` (reconciliation + validation + fail-closed/estimated) and `lexicon.ts` in
parallel — independent of each other. Wave 3 builds the `layer-captions` package (schema +
painter, mirrors `layer-code`'s structure) and `graph.ts`/`mux.ts` (argv-safe FFmpeg, reuses
005's `probe()`) in parallel — independent workstreams. Wave 4 builds `export.ts` (depends on the
word-timing type from Wave 1, independently testable) and the gated live-alignment integration
test. Wave 5 is the final full-workspace regression pass.

## Tasks

### Wave 1 — Shared types

- [ ] `T1` — `word-timing-types.ts`: `WordTiming`, `AlignRequest`, `AlignResult`
  - Files: `packages/audio/src/word-timing-types.ts`
  - Estimate: small
  - Kind: impl
  - Notes: Per spec.md FR5/design.md Data Model Changes. Plain interfaces, no logic. `word`/
    `start`/`end`/`estimated`/`confidence?` on `WordTiming`; `start`/`end` documented as
    block-relative directly on the type (design.md's offset-convention decision).

- [ ] `T2` — Extend `SynthesisRequest` with `lexiconDigest`
  - Files: `packages/audio/src/types.ts`
  - Estimate: small
  - Kind: impl
  - Notes: Per spec.md FR10/design.md D6. Add `lexiconDigest: string` to the existing
    `SynthesisRequest` interface (006). No change to `cache.ts` — its existing full-object hash
    picks up the new field automatically (this is the point of design.md D6, exercising 006's D1
    promise). Update any existing `SynthesisRequest` object literals in 006's tests only if
    TypeScript's strict field requirement breaks them (add `lexiconDigest: ""` to keep them
    compiling) — do not otherwise modify 006's test assertions.

### Wave 2 — align.ts, lexicon.ts (independent of each other)

- [ ] `T3` — `align.ts`: ASR + reconciliation + validation + fail-closed/estimated
  - Files: `packages/audio/src/align.ts`, `packages/audio/test/align.test.ts`
  - Estimate: large
  - Kind: impl
  - Depends: T1
  - Notes: Per spec.md FR1-FR4/AC1-AC4/design.md D2/D3. `align(request: AlignRequest):
    Promise<AlignResult>` — production path runs `@huggingface/transformers`'s
    `automatic-speech-recognition` pipeline (`pipeline('automatic-speech-recognition',
    '<model id>', { dtype: 'fp32' })` with `return_timestamps: 'word'`; route its cache dir
    through `resolveCacheSubdir` per 006's precedent). Implements the reconciliation function as
    an edit-distance (Levenshtein-style) alignment between the raw recognized word stream and
    `referenceText`'s tokenization (design.md D2 — stop and flag if this proves insufficient
    rather than silently swapping algorithms). Validates before returning: every reference word
    covered, timestamps monotonic/non-negative/bounded by measured audio duration
    (`audio.length / 2 / sampleRate`, matching 006's PCM format) — throws naming the block and
    the failed check on violation. `allowEstimated` opt-in triggers proportional-distribution
    fallback for low-confidence spans only, marking `estimated: true` and populating
    `estimatedSpans`; default (`allowEstimated` absent/false) throws instead. The function itself
    is an injectable seam — production callers use the real implementation, tests inject a fake
    raw-ASR-output function ahead of the (real, always-run) reconciliation/validation logic, so
    reconciliation/validation are tested without real inference (NFR2). Test file covers AC1
    (clean stream), AC2 (dropped/inserted/reordered word fixtures, 3 cases), AC3 (non-monotonic/
    negative/past-length timestamp rejection), AC4 (both `allowEstimated` directions).

- [ ] `T4` — `lexicon.ts`: pronunciation lexicon + resolved digest
  - Files: `packages/audio/src/lexicon.ts`, `packages/audio/test/lexicon.test.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T2
  - Notes: Per spec.md FR10/AC10. A simple term→phoneme/respelling map (project-level, loaded
    from a config the caller supplies — keep this small, no new file-format parser beyond a plain
    JS object/JSON per Rule 2 Simplicity First) plus `resolveLexiconDigest(appliedEntries):
    string` — a SHA-256 hex digest of the entries actually applied to a given text (not the whole
    lexicon — matches 006/party-security's "digest of the applied lexicon entries" framing).
    Test file covers AC10: adding/changing a lexicon entry that affects a given text changes its
    digest; an entry for a word absent from the text does not change the digest for that text
    (Edge Case in spec.md).

### Wave 3 — layer-captions package, graph.ts/mux.ts (independent workstreams)

- [ ] `T5` — `packages/layer-captions`: package scaffolding + schema + `registerLayer`
  - Files: `packages/layer-captions/package.json`, `tsup.config.ts`, `vitest.config.ts`,
    `tsconfig.json`, `src/schema.ts`, `src/index.ts` (stub)
  - Estimate: medium
  - Kind: impl
  - Depends: T1
  - Notes: Per spec.md FR6/design.md D4. Mirror `packages/layer-code`'s package.json exactly
    (deps: `@claudevid/core`, `@claudevid/renderer-canvas`, `@claudevid/motion`,
    `@claudevid/audio` workspace deps — the last one for `WordTiming`'s type only). `schema.ts`
    defines a `captionsLayerSchema` (zod, spreads core's `baseLayerShape` per the verified
    `layer-code` precedent) with a `words: WordTiming[]` field (timeline-absolute by the time it
    reaches this schema — the offset is applied by whoever assembles the spec's captions layer,
    not here) and calls `registerLayer("captions", captionsLayerSchema)` at module load, exactly
    matching `packages/layer-code/src/schema.ts`'s own `registerLayer` call.

- [ ] `T6` — `layer-captions`: `render.ts` (karaoke-highlight painter) + `registerPainter`
  - Files: `packages/layer-captions/src/render.ts`, `packages/layer-captions/src/index.ts`
    (finalize exports + `registerPainter` call), `packages/layer-captions/test/render.test.ts`,
    `packages/layer-captions/test/schema.test.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T5
  - Notes: Per spec.md FR6/AC5/design.md D7. `paintCaptionsLayer` finds the active word at the
    current frame via direct frame-time comparison against each `WordTiming`'s `[start,end)`
    window (converted to frames via the spec's fps — no new `packages/motion` track type, per
    design.md D7) and draws it with a distinct (e.g. scaled/colored) style versus inactive words.
    `index.ts` calls `registerPainter("captions", paintCaptionsLayer)` at module load, mirroring
    `packages/layer-code/src/index.ts`'s own registration call and its documented rationale
    (schema-valid-but-silently-paints-nothing without this). `schema.test.ts` covers AC5
    (parses via core's registry once `layer-captions` is imported; structural check that
    `packages/core`'s and `packages/renderer-canvas`'s own `package.json` list no dependency on
    `layer-captions`). `render.test.ts` covers the active-word frame-time lookup directly (no
    real canvas rendering needed beyond what `layer-code`'s own render tests already establish as
    this repo's pattern).

- [ ] `T7` — `graph.ts`: argv-safe FFmpeg filter graph (gain/fade/duck/loudnorm)
  - Files: `packages/audio/src/graph.ts`, `packages/audio/test/graph.test.ts`
  - Estimate: large
  - Kind: impl
  - Notes: Per spec.md FR7/AC6/AC7/design.md D5. Builds an argv array (never a concatenated
    filter-graph string built from raw spec-supplied values) — every media file is a separate
    `-i` input; the filter-graph string references inputs by index only (e.g. `[0:a]`, `[1:a]`);
    every numeric parameter (gain, fade duration, loop count) validated against an explicit range,
    rejecting out-of-range values. Sidechain ducking (`sidechaincompress`) and loudness
    normalization (`loudnorm`, −14 LUFS target) as additional graph stages. Resolves the FFmpeg
    binary via `packages/encoder-ffmpeg`'s exported `probe()` (add `@claudevid/encoder-ffmpeg` as
    a dependency of `packages/audio`) — no second binary-resolution implementation. Test file
    covers AC6 (structural: out-of-range gain rejected; argv array contains file paths as whole
    elements, filter-graph string contains no raw path) and AC7 (ducking: a fixture voice+music
    pair's output level under speech reduced by a stated dB threshold, measured via a synthetic
    level check against the graph's actual FFmpeg invocation — if FFmpeg isn't available in the
    test environment, gate this specific assertion the same way 005's `pipe.live.test.ts`
    isolates real-FFmpeg tests).

- [ ] `T8` — `mux.ts`: distinct-path mux, temp+rename, duration-tolerance check
  - Files: `packages/audio/src/mux.ts`, `packages/audio/test/mux.test.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T7
  - Notes: Per spec.md FR8/AC8. Writes to a distinct output path (never overwrites 005's silent
    encode in place); writes to temp file, renames only on FFmpeg exit code 0; refuses to
    overwrite an existing output unless explicitly forced; asserts audio/video duration agreement
    within a stated tolerance (e.g. 50ms), failing with both numbers on mismatch. Test file
    covers AC8 via an injectable FFmpeg-invocation seam (mirrors T7/006's pattern) — no real
    FFmpeg process needed for the temp+rename/duration-check logic itself.

### Wave 4 — export.ts + gated integration test

- [ ] `T9` — `export.ts`: SRT/VTT from `WordTiming[]`
  - Files: `packages/audio/src/export.ts`, `packages/audio/test/export.test.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T1
  - Notes: Per spec.md FR9/AC9. `exportSrt(timings: WordTiming[]): string`,
    `exportVtt(timings: WordTiming[]): string` — group words into cue lines (simple: one cue per
    word or per short run, whichever is simpler per Rule 2 — don't build a phrase-segmentation
    algorithm beyond what's needed for a readable subtitle), marking `estimated: true` entries
    distinctly (e.g. an inline marker or separate cue styling) per AC9.

- [ ] `T10` — Gated live-alignment integration test + workspace-wide build/test/lint pass
  - Files: `packages/audio/test/align.live.test.ts`
  - Estimate: medium
  - Kind: test
  - Depends: T3, T4, T6, T8, T9
  - Notes: Mirrors 006's `tts.live.test.ts` gating pattern exactly (try/catch + timeout +
    graceful skip with a clear console message if the environment can't run real inference).
    Covers AC11: `align()` with the real ASR pipeline over a short synthesized sample sentence
    (reuse 006's real `synthesize()` to produce the sample audio) produces non-empty word
    timings. Record an indicative per-block alignment wall-clock number in this task's notes/PR
    description (design.md's Risks section), cache-cold vs. cache-warm where applicable. Then run
    `pnpm -r run build`, `pnpm -r run test`, `pnpm -r run lint` from a clean checkout (AC12) and
    confirm 001–006's existing suites are unaffected. Reconcile every AC in spec.md against a
    task above before marking this change built.

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
  - Kind: docs | test | config | refactor | impl | migration
  - Depends: <task ids> (if any)
  - Notes: <additional context>
```
