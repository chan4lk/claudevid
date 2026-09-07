// Forced-alignment shapes for @claudevid/audio — plain interfaces, no logic (spec.md FR5,
// design.md's Data Model Changes section).

/** A single aligned word from `align()` (align.ts, T-later). `start`/`end` are block-relative
 * seconds. `word` is always `referenceText`'s surface form (pre-lexicon-substitution), never
 * the ASR pipeline's own recognized spelling — punctuation is not a separate entry. */
export interface WordTiming {
  word: string;
  start: number;
  end: number;
  /** true only under `allowEstimated`'s proportional-distribution fallback (spec.md FR5). */
  estimated: boolean;
  confidence?: number;
}

/** `align`'s (align.ts, T-later) sole input. */
export interface AlignRequest {
  audio: Buffer;
  sampleRate: number;
  referenceText: string;
  /** Enables the proportional-distribution fallback for spans the aligner can't confidently
   * place, instead of throwing. */
  allowEstimated?: boolean;
}

/** `align`'s (align.ts, T-later) return shape. `estimatedSpans` indexes into `timings` for any
 * run of consecutive `estimated: true` entries, so a caller can flag degraded scenes without
 * re-scanning `timings`. */
export interface AlignResult {
  timings: WordTiming[];
  estimatedSpans: { startIndex: number; endIndex: number }[];
}
