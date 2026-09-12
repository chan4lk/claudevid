// One-time migration of a project-local model cache to the machine-wide root (012 spec.md
// FR7/FR8, design.md D2/D4).
//
// Before change 012, pinned model weights lived at `<projectRoot>/.claudevid/cache/models`. A user
// upgrading already has ~310 MB of Kokoro sitting there, and re-downloading bytes they own is the
// exact cost this change exists to remove — so on the first run after the upgrade we move it
// instead of re-fetching it.
//
// Deliberately a module of its own rather than a side effect inside `cache-root.ts`: that module
// documents itself as pure path arithmetic with no filesystem access (FR2), and a resolver that
// quietly moved 310 MB of files would be a trap for every future caller. This is also the only
// filesystem write the root split implies, so it is worth being able to point at.
//
// Never throws (FR8). Its worst failure mode is "the user pays for one download they could have
// avoided"; escalating that into a crashed render would be strictly worse than the problem.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { resolveCacheSubdir, resolveModelsRoot } from "./cache-root.js";

/** Outcome of a `migrateProjectModelsCache` call. `reason` is always populated — `"migrated"`
 * exactly when `migrated` is true — so a caller that wants to report what happened can, without
 * re-deriving it. No current caller does: a warning printed on every cold render would be noise
 * (design.md D4). */
export interface MigrationResult {
  migrated: boolean;
  reason: "migrated" | "destination-exists" | "nothing-to-migrate" | "failed";
  error?: Error;
}

/** True when `dir` exists, is a directory, and holds at least one entry. Any error — missing,
 * unreadable, or a file where a directory was expected — answers false: all of them mean "there is
 * nothing here worth migrating." */
async function hasEntries(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/** True when anything at all exists at `target`. */
async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Moves `<projectRoot>/.claudevid/cache/models` to the machine-wide model root, once, when that
 * is both possible and safe. Idempotent and cheap to call on every model load: after the first
 * run the destination exists, which short-circuits on a single `stat`.
 *
 * Skips — without touching anything — when:
 * - the machine-wide root already exists. **Never merges** (AC11): merging would have to decide
 *   which `model.onnx` wins when both sides hold a different one, and every answer to that is a
 *   guess about the user's intent. Skipping is the only behaviour that cannot corrupt a cache that
 *   already works. The project-local copy is left alone rather than deleted, because deleting data
 *   on a path the user did not ask for is not this function's call to make.
 * - there is no project-local `models/` directory, or it is empty (Edge Case 7).
 *
 * Moves by `fs.rename` where it can, which is atomic and instant on one filesystem. `EXDEV` (the
 * project and the home directory on different volumes) falls back to a recursive copy followed by
 * a delete — in that order, so an interrupted copy leaves the source intact (Edge Case 5).
 *
 * Both roots are injectable: production callers pass neither. */
export async function migrateProjectModelsCache(opts?: {
  projectRoot?: string;
  modelsRoot?: string;
}): Promise<MigrationResult> {
  try {
    const destination = opts?.modelsRoot ?? resolveModelsRoot();
    if (await exists(destination)) {
      return { migrated: false, reason: "destination-exists" };
    }

    const source = resolveCacheSubdir("models", opts?.projectRoot);
    if (!(await hasEntries(source))) {
      return { migrated: false, reason: "nothing-to-migrate" };
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fs.rename(source, destination);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      // Different filesystems: copy first, and only delete the source once the copy has resolved.
      await fs.cp(source, destination, { recursive: true });
      await fs.rm(source, { recursive: true, force: true });
    }
    return { migrated: true, reason: "migrated" };
  } catch (err) {
    // FR8: never fatal. The project-local directory is still there (a rename either happened or
    // did not; a copy is only followed by a delete on success), so the fallback is the ordinary
    // download-on-demand path, not data loss.
    return { migrated: false, reason: "failed", error: err as Error };
  }
}
