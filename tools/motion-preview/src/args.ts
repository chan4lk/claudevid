export const MAX_FRAMES = 24;
export const DEFAULT_FRAMES = 6;

export class ArgError extends Error {}

export interface ParsedArgs {
  specPath: string;
  outPath: string;
  sceneId?: string;
  frames: number;
  force: boolean;
}

/** Pure argument parsing — no filesystem access, no rendering (spec.md FR17/tasks.md T13:
 * this tool isn't part of the automated test tier, but its argument contract is). */
export function parseArgs(argv: string[]): ParsedArgs {
  let specPath: string | undefined;
  let outPath: string | undefined;
  let sceneId: string | undefined;
  let frames = DEFAULT_FRAMES;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--spec":
        specPath = argv[++i];
        break;
      case "--out":
        outPath = argv[++i];
        break;
      case "--scene":
        sceneId = argv[++i];
        break;
      case "--frames":
        frames = Number(argv[++i]);
        break;
      case "--force":
        force = true;
        break;
      default:
        throw new ArgError(`unknown argument "${arg}"`);
    }
  }

  if (!specPath) throw new ArgError("--spec is required");
  // Never derived from spec content (spec.md FR17) — always an explicit operator-supplied argument.
  if (!outPath) throw new ArgError("--out is required");
  if (!Number.isFinite(frames) || frames < 1) throw new ArgError("--frames must be a positive integer");
  if (frames > MAX_FRAMES) throw new ArgError(`--frames must be at most ${MAX_FRAMES}, got ${frames}`);

  return { specPath, outPath, sceneId, frames, force };
}

/** No-clobber guard (spec.md FR17/AC11): refuses to overwrite an existing file unless
 * `--force` is passed. `exists` is injected so this stays testable without touching real disk. */
export function assertOutputWritable(outPath: string, force: boolean, exists: (path: string) => boolean): void {
  if (!force && exists(outPath)) {
    throw new ArgError(`refusing to overwrite existing file "${outPath}" without --force`);
  }
}
