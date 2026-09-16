// resolveSceneAudioPaths() — spec.md FR6-FR8/AC6, design.md's "spec → filesystem" boundary (the
// second row of the "Three boundaries, three guards" table). `@claudevid/core`'s `parseSpec` only
// checks that `scene.audio.src` is a plain path (FR2); it never touches the filesystem (NFR3 —
// parseSpec stays pure, shared with the Claude repair loop). This module is the CLI-layer guard
// that turns that path into a real, resolved, contained file before anything downstream (the
// decoder, `render-pipeline.ts`'s Step A) trusts it: resolve `src` against the spec's own
// directory (or take it as given if absolute), follow symlinks with `realpathFn` (so a symlink
// pointing outside the allowed root cannot be used to escape it — design.md D3, edge case 5), and
// require the resolved real path to be an existing regular file contained under
// `realpath(audioRoot ?? specDir)`.
//
// Every fs touch is injectable (`statFn`/`realpathFn`, defaulting to the real `node:fs`
// functions) so this stays testable with fakes — no real disk I/O required — mirroring
// `config.ts`'s `loadConfig`/`decode.ts`'s `decodeAudioFile` injection style used elsewhere in
// this workspace.

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath, sep } from "node:path";

import type { Diagnostic, ParseResult, Scene, VideoSpec } from "@claudevid/core";

/** Minimal shape this module needs from `fs.statSync` — real `fs.Stats` satisfies it structurally. */
export type StatFn = (path: string) => { isFile(): boolean };
/** Minimal shape this module needs from `fs.realpathSync` — throws (e.g. `ENOENT`) when `path`
 * does not exist. */
export type RealpathFn = (path: string) => string;

export interface ResolveSceneAudioPathsOptions {
  /** Directory a relative `scene.audio.src` is resolved against — the spec file's own directory
   * (spec.md FR6/FR7). */
  specDir: string;
  /** Extra allowed root a resolved `src` may live under, in addition to `specDir` (spec.md FR8).
   * When given, it — not `specDir` — is the only allowed root (spec.md edge case 6). */
  audioRoot?: string;
  /** Defaults to the real `fs.statSync`. Injected by tests to avoid touching real disk. */
  statFn?: StatFn;
  /** Defaults to the real `fs.realpathSync`. Injected by tests to avoid touching real disk. */
  realpathFn?: RealpathFn;
}

/** `resolveSceneAudioPaths`'s result shares `parseSpec`'s `{ ok, spec | diagnostics }` shape
 * (`@claudevid/core`'s `ParseResult`) so callers print both kinds of failure the same way
 * (spec.md FR7: "Diagnostics are printed in the same ... shape as parse diagnostics"). */
export type ResolveSceneAudioPathsResult = ParseResult;

function isContained(realPath: string, root: string): boolean {
  // Trailing-separator containment: `/deck/audio-evil` must not read as inside `/deck/audio`
  // (spec.md FR6, AC6). `root` itself (no trailing separator needed) is also allowed.
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return realPath === root || realPath.startsWith(rootWithSep);
}

function resolveOneAudioPath(
  scene: Scene,
  index: number,
  rootDisplay: string,
  rootReal: string,
  statFn: StatFn,
  realpathFn: RealpathFn,
  specDir: string,
): { ok: true; src: string } | { ok: false; diagnostic: Diagnostic } {
  const src = scene.audio!.src;
  const pointer = `/scenes/${index}/audio/src`;
  const suggestion = `move the file under ${rootDisplay} or pass --audio-root <dir>`;

  const candidatePath = isAbsolute(src) ? src : resolvePath(specDir, src);

  let realPath: string;
  try {
    realPath = realpathFn(candidatePath);
  } catch {
    return {
      ok: false,
      diagnostic: { path: pointer, message: `audio file not found: "${candidatePath}"`, suggestion },
    };
  }

  if (!statFn(realPath).isFile()) {
    return {
      ok: false,
      diagnostic: { path: pointer, message: `audio file is not a regular file: "${realPath}"`, suggestion },
    };
  }

  if (!isContained(realPath, rootReal)) {
    return {
      ok: false,
      diagnostic: {
        path: pointer,
        message: `audio file is outside the allowed root (${rootDisplay}): "${realPath}"`,
        suggestion,
      },
    };
  }

  return { ok: true, src: realPath };
}

/**
 * Resolves every scene's `audio.src` (spec.md FR6) to an existing, contained, absolute real
 * path. Returns `{ ok: true, spec }` with a **new** `VideoSpec` whose `audio.src` values are the
 * resolved real paths — the input `spec` is never mutated (AC6) — or `{ ok: false, diagnostics }`
 * with one diagnostic per failing scene, so a spec with several bad audio paths is reported in
 * one pass rather than one failure at a time.
 *
 * A spec with no `audio` scenes passes through unchanged but still as a new top-level object
 * (spec.md FR7).
 */
export function resolveSceneAudioPaths(
  spec: VideoSpec,
  opts: ResolveSceneAudioPathsOptions,
): ResolveSceneAudioPathsResult {
  const statFn = opts.statFn ?? ((path: string) => statSync(path));
  const realpathFn = opts.realpathFn ?? ((path: string) => realpathSync(path));
  const rootDisplay = opts.audioRoot ?? opts.specDir;
  const rootReal = realpathFn(rootDisplay);

  const diagnostics: Diagnostic[] = [];
  const scenes: Scene[] = spec.scenes.map((scene, index) => {
    if (!scene.audio) return scene;

    const result = resolveOneAudioPath(scene, index, rootDisplay, rootReal, statFn, realpathFn, opts.specDir);
    if (!result.ok) {
      diagnostics.push(result.diagnostic);
      return scene;
    }

    return { ...scene, audio: { ...scene.audio, src: result.src } };
  });

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  return { ok: true, spec: { ...spec, scenes } };
}
