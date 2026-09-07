// The sole owner of the complete FFmpeg argv (spec.md FR2, design.md's argv.ts section). This
// directly resolves the party-architect BLOCK ("argument construction split across three
// modules... no single component sees the whole command line") — no other file in this package
// may construct an FFmpeg flag. `pipe.ts` (T8) calls `buildArgv` and appends nothing of its own.
//
// Pure and branchless (spec.md NFR2): same `ArgvInput` in, same argv array out, no I/O, no
// wall-clock/random dependency, no conditional flag inclusion. Frame geometry comes solely from
// `input.geometry` (already matching the renderer's actual output size — see
// `packages/renderer-canvas/src/frame-buffer.ts`) — this function states that geometry to
// FFmpeg on the raw-RGBA input side, it NEVER emits a resolution-changing filter such as
// `-vf scale=...` (spec.md FR3 / AC4's structural check: profiles never carry dimensions, and
// this function never invents a transform of its own).

import type { ArgvInput } from "./types.js";

export function buildArgv(input: ArgvInput): string[] {
  return [
    "-y",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${input.geometry.width}x${input.geometry.height}`,
    "-r",
    `${input.geometry.fps}`,
    "-i",
    input.inputPath,
    "-fps_mode",
    "passthrough",
    "-pix_fmt",
    "yuv420p",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-c:v",
    input.profile.codec,
    "-b:v",
    `${input.profile.bitrateKbps}k`,
    "-movflags",
    "+faststart",
    input.outputPath,
  ];
}
