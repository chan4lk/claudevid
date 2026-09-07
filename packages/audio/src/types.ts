// Shared shapes for @claudevid/audio — plain interfaces, no logic (spec.md FR2-FR5, design.md's
// Data Model Changes section). This package depends only on `@claudevid/core` for VideoSpec-level
// types (NFR1) — none of that dependency is needed here yet, so no import is added until a
// concrete need arises.

/** `synthesize`'s (tts.ts) sole input — every field that changes the waveform in this increment,
 * resolved to concrete values by the time it reaches `cache.ts` (spec.md FR3). Never partially
 * resolved / no optional fields — the cache key is hash(this object) in full (FR4, design.md D1).
 */
export interface SynthesisRequest {
  text: string;
  voice: string;
  speed: number;
  modelId: string;
  modelDigest: string;
  /** Digest of whichever pronunciation-lexicon entries (008's lexicon.ts) were actually applied
   * to `text` for this request — "" when no lexicon entry applies (spec.md FR10, design.md D6).
   * Part of the full request object hashed by cache.ts's `hashSynthesisRequest`, so a change here
   * changes the cache key automatically (no cache.ts edit needed). */
  lexiconDigest: string;
}

/** `cache.ts`'s (T-later) stored/returned shape for a single narration block's synthesis result
 * (spec.md FR4). Written atomically (temp file + rename) — a reader must never observe a
 * partially-written entry. */
export interface CachedSynthesis {
  audio: Buffer;
  durationSeconds: number;
}

/** `computeAudioDurations`'s (durations.ts, T-later) options — configurable padding and
 * min/max duration bounds applied per scene after summing its narration blocks' measured
 * durations (spec.md FR5). Exceeding `maxDurationSeconds` throws; falling below
 * `minDurationSeconds` raises to the minimum (AC8). */
export interface AudioDurationsOptions {
  headPaddingSeconds?: number;
  tailPaddingSeconds?: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
}
