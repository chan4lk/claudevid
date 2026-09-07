// Codec/bitrate *resolution* only (spec.md FR3/FR4, design.md's `profiles.ts` section).
// `profiles.ts` never touches geometry (width/height/fps are the caller/renderer's job, passed
// into `buildArgv` as `ArgvInput.geometry` — see types.ts) and never spawns anything; it is pure
// (NFR2): same `name`/`capabilities`/`opts` in, same `{ resolved, fallbackNotice }` out.

import type { EncoderCapabilities, ResolvedProfile } from "./types.js";

/** `preview`/`final` only — `hevc`/`master`/`web`/vertical presets are cut (party-po WARN: no
 * stated value beyond "the table exists"). Codec + bitrate only, never dimensions — output
 * resolution has exactly one source of truth (`VideoSpec.width`/`height`, not this table). */
export const PROFILE_TABLE = {
  preview: { bitrateKbps: 4000 }, // fast draft loop (change 007)
  final: { bitrateKbps: 18000 }, // YouTube / general delivery — high end of the recommended
  //                                16-20M range, see FR6
} as const;

export type ProfileName = keyof typeof PROFILE_TABLE;

/** Thrown by `resolveProfile` when `capabilities.ffmpegPresent` is `false` — an actionable,
 * install-referencing message so a downstream `spawn` never fails with a raw `ENOENT` deep
 * inside `pipe.ts` (spec.md FR4/AC6, Edge Cases). */
export class FfmpegNotFoundError extends Error {
  constructor() {
    super(
      "FFmpeg not found on PATH. Install FFmpeg (https://ffmpeg.org/download.html) and " +
        "ensure it is on PATH, or pass an explicit ffmpegPath."
    );
    this.name = "FfmpegNotFoundError";
  }
}

/** Resolves a profile name + detected capabilities into the concrete codec/bitrate `buildArgv`
 * (argv.ts, T3) consumes (spec.md FR4):
 * - Throws `FfmpegNotFoundError` if FFmpeg itself isn't present (AC6).
 * - Picks `h264_videotoolbox` when available and VideoToolbox wasn't explicitly opted out of
 *   via `opts.cpuEncode`; otherwise falls back to `libx264`.
 * - Sets `fallbackNotice` to the exact FR4-pinned message when VideoToolbox was wanted but
 *   unavailable (AC5) — never set when `cpuEncode` was an explicit, intentional caller choice.
 * - Throws a typed error naming both the requested and available codecs if `cpuEncode: true`
 *   was requested but `libx264` is also unavailable (Edge Cases) — an explicit caller request
 *   is never silently overridden by picking VideoToolbox anyway.
 */
export function resolveProfile(
  name: ProfileName,
  capabilities: EncoderCapabilities,
  opts: { cpuEncode?: boolean } = {}
): { resolved: ResolvedProfile; fallbackNotice?: string } {
  if (!capabilities.ffmpegPresent) throw new FfmpegNotFoundError();

  const bitrateKbps = PROFILE_TABLE[name].bitrateKbps;
  const wantsVideotoolbox = !opts.cpuEncode;

  if (wantsVideotoolbox && capabilities.h264_videotoolbox) {
    return { resolved: { codec: "h264_videotoolbox", bitrateKbps } };
  }

  const resolved: ResolvedProfile = { codec: "libx264", bitrateKbps };

  if (wantsVideotoolbox) {
    // VideoToolbox was wanted but unavailable — this is the fallback case, notice fires.
    return {
      resolved,
      fallbackNotice:
        "h264_videotoolbox not available on this machine; falling back to libx264 (slower). " +
        "Install FFmpeg with VideoToolbox support or pass { cpuEncode: true } to silence this.",
    };
  }

  // cpuEncode explicitly requested — libx264 chosen on purpose, no notice, unless it's also
  // unavailable, in which case the explicit request must fail loudly rather than be overridden.
  if (!capabilities.libx264) {
    throw new Error(
      "cpuEncode was requested but libx264 is not available in this FFmpeg build " +
        `(h264_videotoolbox: ${capabilities.h264_videotoolbox}, libx264: false).`
    );
  }

  return { resolved };
}
