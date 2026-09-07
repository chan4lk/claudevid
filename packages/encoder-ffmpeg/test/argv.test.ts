// Zero-FFmpeg unit tests for argv.ts (spec.md AC3/AC4). buildArgv is a pure function — no
// mocking needed, no FFmpeg binary needed to run this file (spec.md NFR4).

import { describe, expect, it } from "vitest";

import { buildArgv } from "../src/argv.js";
import type { ArgvInput } from "../src/types.js";

const RESOLUTION_TRANSFORM_FLAGS = ["-vf", "-filter", "-filter:v", "scale="];

describe("buildArgv (AC3) — final profile, 1920x1080/30fps", () => {
  const input: ArgvInput = {
    profile: { codec: "libx264", bitrateKbps: 18000 },
    geometry: { width: 1920, height: 1080, fps: 30 },
    inputPath: "-",
    outputPath: "out.mp4",
  };

  it("returns exactly the argv array pinned in spec.md FR2", () => {
    expect(buildArgv(input)).toEqual([
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      "1920x1080",
      "-r",
      "30",
      "-i",
      "-",
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
      "libx264",
      "-b:v",
      "18000k",
      "-movflags",
      "+faststart",
      "out.mp4",
    ]);
  });
});

describe("buildArgv (AC4) — preview profile, 1280x720/30fps", () => {
  const input: ArgvInput = {
    profile: { codec: "libx264", bitrateKbps: 4000 },
    geometry: { width: 1280, height: 720, fps: 30 },
    inputPath: "-",
    outputPath: "preview.mp4",
  };

  it("returns exactly the expected argv array, differing from AC3 only in -s/-b:v/outputPath", () => {
    expect(buildArgv(input)).toEqual([
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      "1280x720",
      "-r",
      "30",
      "-i",
      "-",
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
      "libx264",
      "-b:v",
      "4000k",
      "-movflags",
      "+faststart",
      "preview.mp4",
    ]);
  });
});

describe("buildArgv — structural check (AC4)", () => {
  const finalInput: ArgvInput = {
    profile: { codec: "libx264", bitrateKbps: 18000 },
    geometry: { width: 1920, height: 1080, fps: 30 },
    inputPath: "-",
    outputPath: "out.mp4",
  };
  const previewInput: ArgvInput = {
    profile: { codec: "h264_videotoolbox", bitrateKbps: 4000 },
    geometry: { width: 1280, height: 720, fps: 30 },
    inputPath: "-",
    outputPath: "preview.mp4",
  };

  it.each([
    ["final/1080p", finalInput],
    ["preview/720p", previewInput],
  ])("never emits -vf, scale=, or any other resolution-transform flag (%s)", (_label, input) => {
    const argv = buildArgv(input as ArgvInput);
    for (const flag of RESOLUTION_TRANSFORM_FLAGS) {
      expect(argv.some((arg) => arg.includes(flag))).toBe(false);
    }
  });
});
