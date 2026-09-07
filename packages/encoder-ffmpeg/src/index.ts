// Public exports for @claudevid/encoder-ffmpeg (design.md's API Changes section).
//
// Full public surface: capability detection (`probe`), profile resolution (`resolveProfile`,
// `PROFILE_TABLE`, `FfmpegNotFoundError`), argv construction (`buildArgv`), the single-pipe
// encode lifecycle (`createEncodePipe`, `parseProgressLine`, `EncodeError`), temp-dir/process
// hygiene (`createTempRun`), and every shared shape from `types.ts`.

export { probe } from "./probe.js";

export { PROFILE_TABLE, resolveProfile, FfmpegNotFoundError } from "./profiles.js";
export type { ProfileName } from "./profiles.js";

export { buildArgv } from "./argv.js";

export { createEncodePipe, parseProgressLine, EncodeError } from "./pipe.js";
export type { EncodeOptions, EncodePipe } from "./pipe.js";

export { createTempRun } from "./temp.js";
export type { TempRun } from "./temp.js";

export type {
  FrameGeometry,
  ResolvedProfile,
  EncoderCapabilities,
  ProgressEvent,
  ArgvInput,
} from "./types.js";
