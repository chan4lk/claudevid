import type { ProfileName } from "@claudevid/encoder-ffmpeg";

export class ArgError extends Error {}

export interface ParsedArgs {
  /** Which `@claudevid/encoder-ffmpeg` profile to encode with — defaults to `"final"`, matching
   * design.md's `bench.ts` pseudocode (a real-delivery encode, not the fast-preview bitrate). */
  profile: ProfileName;
  /** Forces `libx264` even when `h264_videotoolbox` is available (`EncodeOptions.cpuEncode`) —
   * useful for an apples-to-apples bench run on a machine that has both. */
  cpuEncode: boolean;
}

const VALID_PROFILES: ProfileName[] = ["preview", "final"];

/** Pure argument parsing — no filesystem access, no rendering, no FFmpeg (mirrors
 * `tools/motion-preview/src/args.ts`'s precedent, tasks.md T10): `bench.ts`'s own
 * CLI-argument contract, kept separate from anything that spawns a real render/encode so it
 * stays testable without either. */
export function parseArgs(argv: string[]): ParsedArgs {
  let profile: ProfileName = "final";
  let cpuEncode = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--profile": {
        const value = argv[++i];
        if (!VALID_PROFILES.includes(value as ProfileName)) {
          throw new ArgError(`--profile must be one of ${VALID_PROFILES.join(", ")}, got "${value}"`);
        }
        profile = value as ProfileName;
        break;
      }
      case "--cpu-encode":
        cpuEncode = true;
        break;
      default:
        throw new ArgError(`unknown argument "${arg}"`);
    }
  }

  return { profile, cpuEncode };
}
