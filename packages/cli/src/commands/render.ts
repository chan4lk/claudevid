// `claudevid render <spec> --out <path>` (spec.md FR4/Edge Cases). Reads + `parseSpec`s the file
// (same error-reporting shape as validate.ts, design.md D2), refuses to overwrite an existing
// `--out` file unless `--force` (mirrors tools/motion-preview's `assertOutputWritable` pattern),
// then runs the shared render pipeline (FR9) at the spec's native resolution.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

import { parseSpec } from "@claudevid/core";

import { ArgError, findFlagValue, hasFlag } from "../args.js";
import { runRenderPipeline } from "../render-pipeline.js";
import { resolveSceneAudioPaths } from "../scene-audio-paths.js";

export interface RenderCommandArgs {
  specPath: string;
  outPath: string;
  force: boolean;
  captions: boolean;
  /** spec.md FR18/AC15: render anyway when `captions` is set and some scenes use `scene.audio`;
   * those scenes are skipped rather than captioned. Rejected by `parseRenderArgs` (ArgError) when
   * `captions` is not also set. */
  captionsAllowPartial: boolean;
  cpuEncode: boolean;
  profile?: string;
  /** spec.md FR8 — extra allowed root for `scene.audio.src` resolution, in addition to the spec
   * file's own directory. */
  audioRoot?: string;
}

export interface RenderDeps {
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
  runRenderPipeline: typeof runRenderPipeline;
  /** spec.md FR6/FR7 — defaults to the real `resolveSceneAudioPaths` when omitted. */
  resolveSceneAudioPaths?: typeof resolveSceneAudioPaths;
  /** spec.md FR18 — writes the `<out>.captions-skipped.json` sidecar. Defaults to the real
   * `fs.writeFileSync` when omitted. */
  writeFile?: (path: string, content: string) => void;
}

export interface RenderResult {
  ok: boolean;
  message: string;
}

/** Pure argument parsing — no filesystem access (NFR2, mirrors tools/motion-preview's
 * `parseArgs`). `argv[0]` is the spec path; `--out` is required and never derived from the spec
 * (same rule `tools/motion-preview` already enforces for its own `--out`). */
export function parseRenderArgs(argv: string[]): RenderCommandArgs {
  const specPath = argv[0];
  if (!specPath) {
    throw new ArgError("render requires a spec file path");
  }

  const outPath = findFlagValue(argv, "--out");
  if (!outPath) {
    throw new ArgError("--out is required");
  }

  const force = hasFlag(argv, "--force");
  const captions = hasFlag(argv, "--captions");
  const cpuEncode = hasFlag(argv, "--cpu-encode");
  const captionsAllowPartial = hasFlag(argv, "--captions-allow-partial");
  const audioRoot = findFlagValue(argv, "--audio-root");

  if (captionsAllowPartial && !captions) {
    throw new ArgError("--captions-allow-partial requires --captions");
  }

  return { specPath, outPath, force, captions, cpuEncode, captionsAllowPartial, audioRoot };
}

/**
 * Pure-ish render logic, testable with fully injected fakes (no real disk I/O, no real render
 * pipeline). Reads and `parseSpec`s the spec file (validate.ts's exact error-reporting shape),
 * enforces the no-clobber guard on `args.outPath`, then delegates to `deps.runRenderPipeline`.
 */
export async function runRender(args: RenderCommandArgs, deps: RenderDeps): Promise<RenderResult> {
  const raw = deps.readFile(args.specPath);

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `/: invalid JSON: ${reason}` };
  }

  const result = parseSpec(json);
  if (!result.ok) {
    const message = result.diagnostics
      .map((d) => `${d.path}: ${d.message}${d.suggestion ? `, suggestion: ${d.suggestion}` : ""}`)
      .join("\n");
    return { ok: false, message };
  }

  // spec.md FR6/FR7: resolve every scene's `audio.src` against the spec file's own directory
  // (or `--audio-root`) immediately after a successful parseSpec, before anything else touches
  // the spec. Diagnostics are printed in the same shape as parseSpec's own.
  const resolveAudioPaths = deps.resolveSceneAudioPaths ?? resolveSceneAudioPaths;
  const specDir = dirname(resolvePath(args.specPath));
  const resolved = resolveAudioPaths(result.spec, { specDir, audioRoot: args.audioRoot });
  if (!resolved.ok) {
    const message = resolved.diagnostics
      .map((d) => `${d.path}: ${d.message}${d.suggestion ? `, suggestion: ${d.suggestion}` : ""}`)
      .join("\n");
    return { ok: false, message };
  }
  const spec = resolved.spec;

  if (!args.force && deps.exists(args.outPath)) {
    return { ok: false, message: `refusing to overwrite existing file "${args.outPath}" without --force` };
  }

  let pipelineResult: { skippedCaptionSceneIds: string[] };
  try {
    pipelineResult = await deps.runRenderPipeline(spec, {
      profileName: "final",
      outputPath: args.outPath,
      captions: args.captions,
      captionsAllowPartial: args.captionsAllowPartial,
      cpuEncode: args.cpuEncode,
      force: args.force,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, message: reason };
  }

  // spec.md FR18: a partial-captions render (via --captions-allow-partial) writes a sidecar
  // naming the scenes that were rendered without captions, only when there were any.
  const skipped = pipelineResult.skippedCaptionSceneIds;
  if (skipped.length > 0) {
    const writeFile = deps.writeFile ?? ((path, content) => writeFileSync(path, content, "utf-8"));
    writeFile(`${args.outPath}.captions-skipped.json`, JSON.stringify({ skipped }, null, 2));
  }

  const skipSuffix =
    skipped.length > 0 ? ` (${skipped.length} scene${skipped.length === 1 ? "" : "s"} skipped captions)` : "";
  return { ok: true, message: `wrote ${args.outPath}${skipSuffix}` };
}

/**
 * Real (non-DI) entry point. Parses `argv`, validates against real disk I/O, runs the real render
 * pipeline, prints the result. Called by `cli.ts`'s command dispatch (T19).
 */
export async function runRenderFromCli(argv: string[]): Promise<void> {
  const args = parseRenderArgs(argv);

  const deps: RenderDeps = {
    readFile: (path) => readFileSync(path, "utf-8"),
    exists: (path) => existsSync(path),
    runRenderPipeline,
    resolveSceneAudioPaths,
    writeFile: (path, content) => writeFileSync(path, content, "utf-8"),
  };

  const result = await runRender(args, deps);

  if (result.ok) {
    console.log(result.message);
  } else {
    console.error(result.message);
  }

  process.exitCode = result.ok ? 0 : 1;
}
