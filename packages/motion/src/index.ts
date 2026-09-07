export type { Channel, CostClass } from "./properties.js";
export { CHANNELS, COST_CLASS, isChannel } from "./properties.js";

export { resolveEasing, bakeSpring, MotionConfigError } from "./easing.js";
export type { SpringSpec, BakedSpring, EasingFn } from "./easing.js";

export { evaluate } from "./track.js";
export type { Track, ResolvedTrack, EasingRef } from "./track.js";

export { resolvePreset, exportCatalogue } from "./presets.js";
export type { PresetParams, CatalogueEntry } from "./presets.js";

export { orderIndices } from "./stagger.js";
export type { StaggerSpec } from "./stagger.js";

export { compileMotion } from "./compile.js";
export type { CompileMotionResult } from "./compile.js";

export { createResolver } from "./resolver.js";
export type { MotionResolver } from "./resolver.js";
