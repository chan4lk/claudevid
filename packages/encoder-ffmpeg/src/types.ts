// Shared shapes for @claudevid/encoder-ffmpeg — plain interfaces, no logic (spec.md FR1-FR3/FR9,
// design.md's Data Model / Architecture sections). This package has no `@claudevid/*` dependency
// and no dependency on the render stack (NFR3) — every field here is a Node built-in-compatible
// primitive shape, not a re-export of another package's type.

/** Output frame geometry — owned solely by the caller/renderer (`VideoSpec.width`/`height`/
 * `fps` in `001`'s schema), never read from or produced by `profiles.ts` (spec.md FR3). */
export interface FrameGeometry {
  width: number;
  height: number;
  fps: number;
}

/** The fully-resolved codec + bitrate `resolveProfile` (profiles.ts, T5) hands to `buildArgv`
 * (argv.ts, T3) — never a profile *name* (design.md Key Decision D1). */
export interface ResolvedProfile {
  codec: "h264_videotoolbox" | "libx264";
  bitrateKbps: number;
}

/** `probe()`'s (probe.ts, T2) result — exactly the two codecs `preview`/`final` need
 * (spec.md FR1). */
export interface EncoderCapabilities {
  ffmpegPresent: boolean;
  ffmpegVersion?: string;
  h264_videotoolbox: boolean;
  libx264: boolean;
}

/** `parseProgressLine`'s (pipe.ts, T8) result. `frame` is FFmpeg's own `frame=` counter from
 * stderr — because v1 has exactly one FFmpeg process per encode (no chunking), this counter
 * already IS the timeline-global frame index directly, with no aggregation or offset math
 * needed (spec.md FR9). */
export interface ProgressEvent {
  frame: number;
  fps?: number;
  speedX?: number;
  timeSeconds?: number;
}

/** `buildArgv`'s (argv.ts, T3) sole input — the complete, four-field contract from which the
 * entire FFmpeg argv is derived (spec.md FR2). `inputPath` is `"-"` for the stdin raw-RGBA
 * pipe — this package's only caller in v1. */
export interface ArgvInput {
  profile: ResolvedProfile;
  geometry: FrameGeometry;
  inputPath: string;
  outputPath: string;
}
