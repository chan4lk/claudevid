// Public exports for @claudevid/audio (design.md's API Changes section).
//
// This is a stub: only the shared shapes, cache-root resolution, synthesize(), and the model
// pinning/verification machinery exist so far (T2, T3, T4, T5). `computeAudioDurations` is added
// by a later task as durations.ts lands.

export type { SynthesisRequest, CachedSynthesis, AudioDurationsOptions } from "./types.js";
export { resolveCacheRoot, resolveCacheSubdir } from "./cache-root.js";
export { synthesize } from "./tts.js";
export type { PinnedModel } from "./models.js";
export { PINNED_MODEL, ModelDigestMismatchError, installModels, verifyInstalledModel, resolveModelFilePath } from "./models.js";
