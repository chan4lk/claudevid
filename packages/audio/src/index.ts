// Public exports for @claudevid/audio (design.md's API Changes section).
//
// Shared shapes, cache-root resolution, synthesize(), the model pinning/verification machinery,
// the content-hash cache, and computeAudioDurations() all exist now (T2-T7). Only the gated
// live-model integration test (T8) remains outside this package's public surface.

export type { SynthesisRequest, CachedSynthesis, AudioDurationsOptions } from "./types.js";
export type { WordTiming, AlignRequest, AlignResult } from "./word-timing-types.js";
export { resolveCacheRoot, resolveCacheSubdir } from "./cache-root.js";
export { synthesize } from "./tts.js";
export type { PinnedModel } from "./models.js";
export { PINNED_MODEL, ModelDigestMismatchError, installModels, verifyInstalledModel, resolveModelFilePath } from "./models.js";
export { getOrSynthesize, hashSynthesisRequest, resolveCacheEntryPath, measureDurationSeconds } from "./cache.js";
export { computeAudioDurations, EmptyNarrationError, MaxDurationExceededError } from "./durations.js";
export type { ComputeAudioDurationsOptions } from "./durations.js";
