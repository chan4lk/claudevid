// Shared cache-root resolution (spec.md FR7, design.md D2). The ONE place that decides where
// `.claudevid/cache/` lives, so `cache.ts` (TTS audio cache entries, under `tts/`) and
// `models.ts` (downloaded model files, under `models/`) agree on a single root instead of each
// hand-rolling its own path. Pure path-resolution logic only — no directory creation, no
// filesystem access at all; callers create whatever subdirectories they need.

import * as path from "node:path";

/** Resolves the project's shared cache root: `<projectRoot>/.claudevid/cache`. `projectRoot`
 * defaults to `process.cwd()` when omitted. */
export function resolveCacheRoot(projectRoot?: string): string {
  return path.join(projectRoot ?? process.cwd(), ".claudevid", "cache");
}

/** Resolves a named subdirectory under the shared cache root, e.g. `resolveCacheSubdir("tts")`
 * or `resolveCacheSubdir("models")` — this is what `cache.ts` and `models.ts` actually call, so
 * both land under the same root (spec.md FR7) without either hand-picking a path. */
export function resolveCacheSubdir(name: string, projectRoot?: string): string {
  return path.join(resolveCacheRoot(projectRoot), name);
}
