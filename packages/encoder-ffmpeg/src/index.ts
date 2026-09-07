// Public exports for @claudevid/encoder-ffmpeg.
//
// Stub (T1 — package scaffolding + shared types). This file only re-exports the shared shapes
// so the package builds standalone before probe.ts/argv.ts/profiles.ts/pipe.ts/temp.ts exist.
// T8 finalizes this file's exports (`probe`, `resolveProfile`, `PROFILE_TABLE`, `buildArgv`,
// `createEncodePipe`, `parseProgressLine`, `createTempRun`, `EncodeError`,
// `FfmpegNotFoundError`) per design.md's API Changes section.

export type {
  FrameGeometry,
  ResolvedProfile,
  EncoderCapabilities,
  ProgressEvent,
  ArgvInput,
} from "./types.js";
