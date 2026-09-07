// Public exports for @claudevid/audio (design.md's API Changes section).
//
// This is a stub: only the shared shapes, cache-root resolution, and synthesize() exist so far
// (T2, T3, T5). `computeAudioDurations` and `installModels` are added by later tasks as
// durations.ts and models.ts land.

export type { SynthesisRequest, CachedSynthesis, AudioDurationsOptions } from "./types.js";
export { resolveCacheRoot, resolveCacheSubdir } from "./cache-root.js";
export { synthesize } from "./tts.js";
