# Design: Forced-Aligned Captions, Speech-Synced Motion & Audio Graph

**Change:** 008-forced-alignment-captions-audio-graph
**Created:** 2026-09-07

## Technical Approach

```
006's SynthesisRequest (+ lexicon digest field, this change)
        │
        ▼
   006's cache.ts / tts.ts → { audio, durationSeconds }  (unchanged, reused)
        │
        ▼
align.ts: align({ audio, sampleRate, referenceText })
   1. run @huggingface/transformers ASR pipeline (Whisper, return_timestamps:'word')
      → raw recognized words + timestamps (untrusted, may drop/insert/reorder)
   2. reconcile raw stream against referenceText's tokenization (edit-distance alignment)
      → one candidate timing per reference word, or "no confident mapping" per span
   3. validate: every reference word covered; timestamps monotonic/non-negative/bounded
      → pass: WordTiming[] (block-relative). fail (low-confidence span): throw, unless
        allowEstimated -> proportional-distribution fallback, estimated:true, logged
        │
        ▼
   WordTiming[] { word, start, end, estimated, confidence? }  (block-relative)
        │
        ├──────────► export.ts: SRT/VTT (offsets applied same as captions, see below)
        │
        ├──────────► layer-captions: captions layer stores WordTiming[] with timeline-
        │             absolute start/end (offset applied ONCE, by whoever assembles the
        │             VideoSpec's captions layer from 006's scene-window data — not
        │             recomputed inside align.ts or layer-captions)
        │             painter (registerPainter("captions",...)): at frame F, find the word
        │             whose [start,end) contains F's time, draw karaoke-highlight style
        │             (direct frame-time comparison — no new packages/motion track type)
        │
        └──────────► graph.ts + mux.ts: argv-safe FFmpeg (gain/fade/duck/loudnorm) →
                      distinct output path, temp+rename, duration-tolerance check
```

## Architecture

```
packages/audio/src/  (existing package, additive)
  align.ts                  # FR1-FR4: align(), reconciliation, validation, fail-closed/estimated
  word-timing-types.ts      # FR5: WordTiming type
  graph.ts                  # FR7: argv-safe filter graph (gain/fade/trim/loop/duck/loudnorm)
  mux.ts                    # FR8: distinct-path mux, temp+rename, duration-tolerance
  export.ts                 # FR9: SRT/VTT from WordTiming[]
  lexicon.ts                # FR10: pronunciation lexicon, digest -> SynthesisRequest field
  types.ts                  # + lexiconDigest field on SynthesisRequest (extends 006's type)
test/
  align.test.ts             # AC1-AC4, fixture ASR pipeline, zero real inference
  graph.test.ts              # AC6, AC7 — argv construction + ducking level
  mux.test.ts                # AC8
  export.test.ts             # AC9
  lexicon.test.ts             # AC10
  align.live.test.ts           # AC11, gated (mirrors 006's tts.live.test.ts)

packages/layer-captions/    (new package, mirrors packages/layer-code's structure exactly)
  package.json               # deps: @claudevid/core, @claudevid/renderer-canvas,
                              #       @claudevid/motion, @claudevid/audio (WordTiming type only)
  src/
    schema.ts                # captions layer schema + registerLayer("captions", ...)
    render.ts                # paintCaptionsLayer (karaoke-highlight) + registerPainter(...)
    index.ts                 # public exports + the registerPainter side-effect call
                              #   (mirrors packages/layer-code/src/index.ts's own pattern
                              #   exactly, including its header-comment rationale)
  test/
    schema.test.ts            # AC5
    render.test.ts             # active-word-highlight frame-time lookup

packages/motion/            (no new files — FR6 uses the existing generic animation system
                              for the layer's own enter/exit, and layer-captions's painter
                              does direct frame-time comparison against WordTiming windows
                              for the karaoke highlight, not a new track type — see Key
                              Decision D7)
```

## File Changes Map

| File | Action | Description |
|------|--------|-------------|
| `packages/audio/src/align.ts` | new | ASR + reconciliation + validation + fail-closed |
| `packages/audio/src/word-timing-types.ts` | new | `WordTiming`, `AlignRequest` |
| `packages/audio/src/graph.ts` | new | argv-safe FFmpeg filter graph |
| `packages/audio/src/mux.ts` | new | distinct-path mux |
| `packages/audio/src/export.ts` | new | SRT/VTT |
| `packages/audio/src/lexicon.ts` | new | pronunciation lexicon |
| `packages/audio/src/types.ts` | modify | add `lexiconDigest` to `SynthesisRequest` |
| `packages/audio/src/index.ts` | modify | export new symbols |
| `packages/audio/test/*.test.ts` | new | per Architecture above |
| `packages/layer-captions/**` | new | full new package, mirrors `layer-code` |

## Data Model Changes

```ts
// packages/audio/src/word-timing-types.ts
export interface WordTiming {
  word: string;        // reference-transcript surface form, pre-lexicon-substitution
  start: number;        // seconds, block-relative
  end: number;           // seconds, block-relative
  estimated: boolean;     // true only under allowEstimated's proportional-distribution fallback
  confidence?: number;
}
export interface AlignRequest {
  audio: Buffer;
  sampleRate: number;
  referenceText: string;
  allowEstimated?: boolean;
}
export interface AlignResult {
  timings: WordTiming[];
  estimatedSpans: { startIndex: number; endIndex: number }[];
}

// packages/audio/src/types.ts — extends 006's SynthesisRequest
export interface SynthesisRequest {
  text: string;
  voice: string;
  speed: number;
  modelId: string;
  modelDigest: string;
  lexiconDigest: string;  // NEW — digest of applied lexicon entries; "" when lexicon unused
}
```

## API Changes

- `@claudevid/audio` new exports: `align`, `WordTiming`, `AlignRequest`, `AlignResult`,
  `buildAudioGraphArgv`/`muxOutput` (graph.ts/mux.ts's actual entry points, named in tasks.md),
  `exportSrt`/`exportVtt`, `resolveLexiconDigest`/lexicon lookup.
- `@claudevid/layer-captions` (new): `captionsLayerSchema`, `CaptionsLayer` type,
  `paintCaptionsLayer`. Importing the package (or any named export) runs the
  `registerPainter("captions", paintCaptionsLayer)` side effect, exactly as
  `@claudevid/layer-code`'s `index.ts` documents for its own registration.
- `SynthesisRequest`'s new `lexiconDigest` field is additive — 006's existing cache-key hash
  (over "the full resolved request object," design.md D1) picks it up automatically; no change
  to `cache.ts`.

## Key Decisions

- **D1 — ASR runs on `@huggingface/transformers`, not whisper.cpp.** Already a direct dependency
  of `packages/audio` (006), already routes through the shared cache root. One native runtime for
  both TTS and ASR, not two. Resolves the original proposal's "two native ML runtimes" risk at
  the dependency level.
- **D2 — Reconciliation is a named, testable component, not "alignment."** Edit-distance
  alignment between two *known* token sequences (raw ASR output vs. reference transcript) — a
  bounded problem, unlike open transcription. Concrete algorithm: Levenshtein-style DP alignment
  over word tokens (insert/delete/substitute costs = 1), producing an operation sequence that
  maps each reference-word index to a recognized-word index or "unmatched."
  Rule 1 (Think Before Coding) note: this is the concrete pick promised in proposal.md's Open
  Questions — if a build agent finds edit-distance alignment insufficient for the fixture corpus,
  it must stop and ask rather than silently substituting a different algorithm.
- **D3 — Fail-closed by default, opt-in estimated fallback, never silently mixed.** No span is
  ever downgraded to an estimate without the caller explicitly asking (`allowEstimated: true`)
  and receiving `estimatedSpans` naming exactly which spans were degraded.
- **D4 — Captions is its own package, `layer-captions`, mirroring `layer-code`'s existing,
  proven structure** — not "schema in core" (core only hardcodes 4 built-in types and exposes a
  registry) and not "in `packages/audio`" (the original BLOCK). Verified against
  `packages/core/src/layers.ts`'s `registerLayer` and `packages/layer-code/src/index.ts`'s
  registration side effect before writing this design, not assumed.
- **D5 — FFmpeg argv construction reuses 005's pattern, not a new invocation layer.** `graph.ts`
  builds argv arrays the same way `packages/encoder-ffmpeg/src/argv.ts` does (pure, no string
  concatenation of untrusted values); binary resolution reuses `encoder-ffmpeg`'s `probe()`.
- **D6 — `lexiconDigest` extends `SynthesisRequest` rather than a second cache mechanism.**
  Directly exercises 006's design.md D1 ("a field added later is added to `SynthesisRequest` and
  the key changes automatically") — this change is the first real test of that promise.
- **D7 — Active-word emphasis is a direct frame-time lookup in the painter, not a new
  `packages/motion` track type.** `WordTiming[]`'s `[start,end)` windows are compared against the
  current frame's timestamp directly inside `paintCaptionsLayer`; the layer's own enter/exit still
  uses the existing generic `animation` field like every other layer. Simplicity First (Rule 2):
  the existing track system animates a *declared* property over a *declared* duration; word
  timing is externally-supplied, discrete, data-driven — forcing it into the track abstraction
  would add a new track *kind* for no shared mechanism, where a direct comparison is one `if`.

## Risks & Mitigations

- **Risk:** Reconciliation algorithm (D2) may not handle all real-world ASR failure modes (e.g.
  the model transcribing a homophone). **Mitigation:** fail-closed default means an unhandled
  case surfaces as a thrown error naming the block, not a silently wrong caption — safe failure
  mode even if the algorithm needs iteration.
- **Risk:** Per-block ASR wall-clock cost unknown. **Mitigation:** indicative bench during build,
  same as 005/006's precedent; `align()`'s seam means this cost is isolated from every other test.
- **Risk:** FFmpeg audio-graph complexity (ducking, loudnorm, multiple inputs) has more surface
  for a subtly-wrong argv than 005's single-input case. **Mitigation:** D5's reuse of 005's
  pattern plus AC6/AC7's structural + measured-level tests, not just "it builds."
- **Risk:** Whisper model licensing unresolved (carried from proposal.md). **Mitigation:** tracked
  as an explicit open item, not a build blocker (v1 ships no redistributed model weights).
