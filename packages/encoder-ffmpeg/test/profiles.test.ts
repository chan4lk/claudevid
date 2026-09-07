// Zero-FFmpeg unit tests for profiles.ts (spec.md AC5/AC6, Edge Cases). `resolveProfile` is a
// pure function over `EncoderCapabilities` — no process is ever spawned to exercise it, so this
// file needs no real FFmpeg binary (spec.md NFR4).

import { describe, expect, it } from "vitest";

import { FfmpegNotFoundError, resolveProfile } from "../src/profiles.js";

describe("resolveProfile (AC5) — VideoToolbox wanted but unavailable", () => {
  it("falls back to libx264 and sets a fallbackNotice naming both codecs", () => {
    const { resolved, fallbackNotice } = resolveProfile(
      "final",
      { ffmpegPresent: true, h264_videotoolbox: false, libx264: true },
      {},
    );

    expect(resolved).toEqual({ codec: "libx264", bitrateKbps: 18000 });
    expect(fallbackNotice).toBe(
      "h264_videotoolbox not available on this machine; falling back to libx264 (slower). " +
        "Install FFmpeg with VideoToolbox support or pass { cpuEncode: true } to silence this.",
    );
    expect(fallbackNotice).toEqual(expect.stringContaining("h264_videotoolbox"));
    expect(fallbackNotice).toEqual(expect.stringContaining("libx264"));
  });
});

describe("resolveProfile — VideoToolbox available", () => {
  it("picks h264_videotoolbox and never sets a fallbackNotice", () => {
    const result = resolveProfile(
      "final",
      { ffmpegPresent: true, h264_videotoolbox: true, libx264: true },
      {},
    );

    expect(result.resolved).toEqual({ codec: "h264_videotoolbox", bitrateKbps: 18000 });
    expect(result.fallbackNotice).toBeUndefined();
  });

  it("uses the preview profile's bitrate (4000 kbps) when name is 'preview'", () => {
    const result = resolveProfile(
      "preview",
      { ffmpegPresent: true, h264_videotoolbox: true, libx264: true },
      {},
    );

    expect(result.resolved).toEqual({ codec: "h264_videotoolbox", bitrateKbps: 4000 });
  });
});

describe("resolveProfile — cpuEncode explicitly requested", () => {
  it("picks libx264 with no fallbackNotice even though VideoToolbox is available", () => {
    const result = resolveProfile(
      "final",
      { ffmpegPresent: true, h264_videotoolbox: true, libx264: true },
      { cpuEncode: true },
    );

    expect(result.resolved).toEqual({ codec: "libx264", bitrateKbps: 18000 });
    expect(result.fallbackNotice).toBeUndefined();
  });

  it("picks libx264 with no fallbackNotice when VideoToolbox is also unavailable", () => {
    const result = resolveProfile(
      "final",
      { ffmpegPresent: true, h264_videotoolbox: false, libx264: true },
      { cpuEncode: true },
    );

    expect(result.resolved).toEqual({ codec: "libx264", bitrateKbps: 18000 });
    expect(result.fallbackNotice).toBeUndefined();
  });
});

describe("resolveProfile (AC6) — FFmpeg entirely absent", () => {
  it("throws FfmpegNotFoundError with an actionable, install-referencing message", () => {
    const capabilities = { ffmpegPresent: false, h264_videotoolbox: false, libx264: false };

    expect(() => resolveProfile("final", capabilities, {})).toThrow(FfmpegNotFoundError);

    try {
      resolveProfile("final", capabilities, {});
      expect.unreachable("resolveProfile should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FfmpegNotFoundError);
      expect((err as Error).message).toEqual(expect.stringContaining("Install FFmpeg"));
      expect((err as Error).message.length).toBeGreaterThan(0);
    }
  });

  it("throws FfmpegNotFoundError before ever considering opts.cpuEncode", () => {
    const capabilities = { ffmpegPresent: false, h264_videotoolbox: false, libx264: false };

    expect(() => resolveProfile("final", capabilities, { cpuEncode: true })).toThrow(
      FfmpegNotFoundError,
    );
  });
});

describe("resolveProfile (Edge Cases) — cpuEncode requested but libx264 also unavailable", () => {
  it("throws a plain Error naming both the requested and available codecs, rather than silently picking VideoToolbox", () => {
    const capabilities = { ffmpegPresent: true, h264_videotoolbox: true, libx264: false };

    expect(() => resolveProfile("final", capabilities, { cpuEncode: true })).toThrow(
      "cpuEncode was requested but libx264 is not available in this FFmpeg build " +
        "(h264_videotoolbox: true, libx264: false).",
    );

    try {
      resolveProfile("final", capabilities, { cpuEncode: true });
      expect.unreachable("resolveProfile should have thrown");
    } catch (err) {
      // profiles.ts throws a plain `Error` here (not a named subclass like FfmpegNotFoundError) —
      // asserting against its actual shape rather than a typed class that doesn't exist.
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(FfmpegNotFoundError);
      expect((err as Error).name).toBe("Error");
    }
  });
});
