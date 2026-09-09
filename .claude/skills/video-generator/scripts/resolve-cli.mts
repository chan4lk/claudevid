// Shared CLI resolution logic for render.mts and validate.mts (spec.md 010-cli-resolution-freshness
// FR1-FR5). Split into a pure decision function (`pickCli`) and a thin ambient-gathering wrapper
// (`resolveCli`) so the priority order itself is unit-testable with plain data — no filesystem, no
// PATH lookup, no process spawning in the test (see resolve-cli.test.mts).
//
// Priority order: a monorepo checkout present relative to the calling script wins unconditionally
// over both other layouts — being inside (or alongside, via the fixed relative path) a claudevid
// monorepo checkout is itself the signal that a specific build is the one intended, and a
// node_modules dependency or a global install can only ever be a different, potentially older,
// build of the same tool. This is what makes change 009's fixes (and any other monorepo-local fix)
// actually reach a caller who also happens to have a global/local install on their machine — see
// design.md's Key Decisions for the incident that motivated this change.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import * as path from "node:path";

export interface CliCandidates {
  /** Path to the monorepo's own built CLI, if it exists at the fixed relative location — null
   * otherwise (including when no monorepo checkout is present at all). */
  monorepoDistPath: string | null;
  /** Present iff a `claudevid` dependency resolves from the caller's own node_modules; calling it
   * returns the resolved module path. Absent (null) when resolution fails. */
  localDepResolve: (() => string) | null;
  /** True iff a global `claudevid` responds on PATH. */
  globalOnPath: boolean;
}

export interface CliTarget {
  command: string;
  prefixArgs: string[];
}

const NOT_FOUND_MESSAGE =
  "Could not locate the claudevid CLI. Install it in this project (`npm install claudevid`), " +
  "install it globally (`npm install -g claudevid`), or run this script from inside the " +
  "claudevid monorepo after `pnpm build`.";

/** Pure: no fs, no process, no PATH lookup — takes already-resolved candidates and returns which
 * one to use. The monorepo dist path wins whenever it is present, regardless of what else is
 * also present; otherwise falls back to today's local-dependency-then-global order, unchanged. */
export function pickCli(candidates: CliCandidates): CliTarget {
  if (candidates.monorepoDistPath) {
    return { command: "node", prefixArgs: [candidates.monorepoDistPath] };
  }
  if (candidates.localDepResolve) {
    return { command: "node", prefixArgs: [candidates.localDepResolve()] };
  }
  if (candidates.globalOnPath) {
    return { command: "claudevid", prefixArgs: [] };
  }
  throw new Error(NOT_FOUND_MESSAGE);
}

/** Thin ambient wrapper: gathers real candidates from the filesystem/PATH/node_modules, then
 * delegates the actual decision to `pickCli`. `here` is the calling script's own directory
 * (`path.dirname(fileURLToPath(import.meta.url))`), matching what render.mts/validate.mts already
 * compute today. */
export function resolveCli(here: string): CliTarget {
  const monorepoPath = path.resolve(here, "../../../../packages/cli/dist/cli.js");
  const monorepoDistPath = existsSync(monorepoPath) ? monorepoPath : null;

  let localDepResolve: (() => string) | null = null;
  try {
    const resolved = createRequire(path.join(here, "noop.js")).resolve("claudevid/cli");
    localDepResolve = () => resolved;
  } catch {
    // Not a dependency of this project — leave null, pickCli falls through.
  }

  const onPath = spawnSync("claudevid", ["--version"], { stdio: "ignore" });
  const globalOnPath = !onPath.error;

  return pickCli({ monorepoDistPath, localDepResolve, globalOnPath });
}
