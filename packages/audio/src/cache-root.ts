// Cache-root resolution — the ONE place that decides where this package's cached things live, so
// no consumer hand-rolls its own path. There are two roots, because two different things are
// cached with two different lifetimes (012 spec.md FR1/FR5, design.md D1):
//
//   resolveCacheRoot / resolveCacheSubdir  →  <projectRoot>/.claudevid/cache
//       Per-project, per-content. `cache.ts`'s TTS synthesis entries live here under `tts/`: they
//       are keyed to one project's narration text, so they are worthless to any other project.
//
//   resolveModelsRoot                      →  machine-wide (XDG / OS cache dir)
//       Per-machine. Pinned model weights are immutable and byte-identical for every project, so a
//       project-scoped root made each new directory re-download ~310 MB of Kokoro (012's premise).
//
// This narrows change 006's D2 ("one cache root ... not two") rather than discarding it: D2's
// actual principle was that a single module decides every cache path, and that still holds — this
// module is still the only one that decides. What changed is the scope of the model half, from
// per-project to per-machine.
//
// Pure path-resolution logic only — no directory creation, no filesystem access at all (FR2);
// callers create whatever subdirectories they need. `models-migration.ts` owns the one filesystem
// side effect this split implies, deliberately kept out of here so that purity claim stays true.

import * as os from "node:os";
import * as path from "node:path";

/** Resolves the project's shared cache root: `<projectRoot>/.claudevid/cache`. `projectRoot`
 * defaults to `process.cwd()` when omitted.
 *
 * This is the *project* cache — TTS synthesis entries only. Model weights do NOT live here; see
 * `resolveModelsRoot`. */
export function resolveCacheRoot(projectRoot?: string): string {
  return path.join(projectRoot ?? process.cwd(), ".claudevid", "cache");
}

/** Resolves a named subdirectory under the project cache root, e.g. `resolveCacheSubdir("tts")` —
 * this is what `cache.ts` calls, so it lands under the project root without hand-picking a path. */
export function resolveCacheSubdir(name: string, projectRoot?: string): string {
  return path.join(resolveCacheRoot(projectRoot), name);
}

/** Injection seam for `resolveModelsRoot` (FR3). Production callers pass nothing and get the real
 * process environment, home directory and platform; tests pass all three so every precedence tier
 * and every platform default is assertable without mutating `process.env` or reading the real
 * user cache directory (NFR2). */
export interface ModelsRootOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
}

/** Treats an env var as set only when it holds something other than whitespace.
 *
 * Not `name in env`: `export CLAUDEVID_MODELS_DIR=` in a shell profile, or a CI system that
 * materializes an undefined variable as `""`, would otherwise resolve the model root to `""` —
 * putting ~310 MB into whichever directory the process happened to start in, which is the
 * per-directory bug this whole change removes, only harder to spot (spec.md AC4, Edge Case 3). */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/** Resolves the machine-wide root for pinned model weights (FR1). First match wins:
 *
 *   1. `$CLAUDEVID_MODELS_DIR` — used **verbatim**, with nothing appended. An explicit override
 *      names the directory it means; appending `claudevid/models` would quietly turn
 *      `CLAUDEVID_MODELS_DIR=/mnt/models` into `/mnt/models/claudevid/models`, which is precisely
 *      the surprise an escape hatch exists to avoid. This is also the supported way out for
 *      sandboxed CI and containers with no writable `$HOME` (Edge Case 4).
 *   2. `$XDG_CACHE_HOME/claudevid/models` — this one DOES append, because `$XDG_CACHE_HOME` names
 *      a shared cache *parent* owned by the XDG convention, not by this tool.
 *   3. The platform's own cache location.
 *
 * Pure path arithmetic; makes no filesystem calls and creates nothing (FR2, AC5). A returned path
 * may well not exist yet — that is the caller's business. */
export function resolveModelsRoot(opts?: ModelsRootOptions): string {
  const env = opts?.env ?? process.env;
  const platform = opts?.platform ?? process.platform;
  const homedir = opts?.homedir ?? os.homedir();

  const explicit = readEnv(env, "CLAUDEVID_MODELS_DIR");
  if (explicit) return explicit;

  const xdgCacheHome = readEnv(env, "XDG_CACHE_HOME");
  if (xdgCacheHome) return path.join(xdgCacheHome, "claudevid", "models");

  if (platform === "darwin") {
    return path.join(homedir, "Library", "Caches", "claudevid", "models");
  }
  if (platform === "win32") {
    // `%LOCALAPPDATA%` is the conventional per-machine cache location on Windows; falling back to
    // its standard location keeps resolution pure when the variable is absent.
    const localAppData = readEnv(env, "LOCALAPPDATA") ?? path.join(homedir, "AppData", "Local");
    return path.join(localAppData, "claudevid", "Cache", "models");
  }
  return path.join(homedir, ".cache", "claudevid", "models");
}
