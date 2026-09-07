// Zero-FFmpeg unit tests for `parseProgressLine` (spec.md AC7, FR9). Pure function — no process
// is ever spawned, no stderr stream involved. Exercises the exact example line from AC7 plus
// malformed/non-progress lines that must return `null` (banner text, warnings, codec info).

import { describe, expect, it } from "vitest";

import { parseProgressLine } from "../src/pipe.js";

describe("parseProgressLine (AC7) — a real FFmpeg progress line", () => {
  it("parses AC7's exact example line into the documented ProgressEvent shape", () => {
    const line =
      "frame=  120 fps= 30 q=-1.0 size=    512kB time=00:00:04.00 bitrate= 1024.0kbits/s speed=1.0x";

    expect(parseProgressLine(line)).toEqual({
      frame: 120,
      fps: 30,
      speedX: 1.0,
      timeSeconds: 4,
    });
  });

  it("parses correctly even when optional q=/size= fields are absent between fps= and time=", () => {
    const line = "frame=  120 fps= 30 time=00:00:04.00 bitrate= 1024.0kbits/s speed=1.0x";

    expect(parseProgressLine(line)).toEqual({
      frame: 120,
      fps: 30,
      speedX: 1.0,
      timeSeconds: 4,
    });
  });

  it("computes timeSeconds from hh:mm:ss.cs correctly for a non-trivial timestamp", () => {
    const line =
      "frame= 5400 fps= 29 q=-1.0 size=  204800kB time=01:02:03.45 bitrate=1024.0kbits/s speed=0.98x";

    const result = parseProgressLine(line);
    expect(result).not.toBeNull();
    expect(result!.frame).toBe(5400);
    expect(result!.fps).toBe(29);
    expect(result!.speedX).toBe(0.98);
    // 1h2m3.45s = 3600 + 120 + 3.45 = 3723.45
    expect(result!.timeSeconds).toBeCloseTo(3723.45, 5);
  });
});

describe("parseProgressLine (AC7 edge cases) — malformed / non-progress lines return null", () => {
  it("returns null for an empty string", () => {
    expect(parseProgressLine("")).toBeNull();
  });

  it("returns null for FFmpeg banner text", () => {
    expect(
      parseProgressLine("ffmpeg version N-124098-ge717604a29-20260426 Copyright (c) 2000-2026"),
    ).toBeNull();
  });

  it("returns null for a stream-mapping info line", () => {
    expect(
      parseProgressLine("Stream #0:0 -> #0:0 (rawvideo (native) -> h264 (libx264))"),
    ).toBeNull();
  });

  it("returns null for a warning line", () => {
    expect(
      parseProgressLine("[libx264 @ 0x5555] using SAR=1/1"),
    ).toBeNull();
  });

  it("returns null for a line that has 'frame=' but is missing the required time=/speed= fields", () => {
    expect(parseProgressLine("frame=  120 fps= 30 q=-1.0 size=    512kB")).toBeNull();
  });

  it("returns null for a final summary line lacking the frame= prefix", () => {
    expect(
      parseProgressLine("video:512kB audio:0kB subtitle:0kB other streams:0kB global headers:0kB"),
    ).toBeNull();
  });
});
