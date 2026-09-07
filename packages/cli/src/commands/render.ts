// `claudevid render <spec> --out <path>` (spec.md FR4/Edge Cases). Reads + `parseSpec`s the file
// (same error-reporting shape as validate.ts, design.md D2), refuses to overwrite an existing
// `--out` file unless `--force` (mirrors tools/motion-preview's `assertOutputWritable` pattern),
// then runs the shared render pipeline (FR9) at the spec's native resolution.

import { existsSync, readFileSync } from "node:fs";

import { parseSpec } from "@claudevid/core";

import { ArgError, findFlagValue, hasFlag } from "../args.js";
import { runRenderPipeline } from "../render-pipeline.js";

export interface RenderCommandArgs {
  specPath: string;
  outPath: string;
  force: boolean;
  captions: boolean;
  cpuEncode: boolean;
  profile?: string;
}

export interface RenderDeps {
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
  runRenderPipeline: typeof runRenderPipeline;
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

  return { specPath, outPath, force, captions, cpuEncode };
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

  if (!args.force && deps.exists(args.outPath)) {
    return { ok: false, message: `refusing to overwrite existing file "${args.outPath}" without --force` };
  }

  try {
    await deps.runRenderPipeline(result.spec, {
      profileName: "final",
      outputPath: args.outPath,
      captions: args.captions,
      cpuEncode: args.cpuEncode,
      force: args.force,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, message: reason };
  }

  return { ok: true, message: `wrote ${args.outPath}` };
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
  };

  const result = await runRender(args, deps);

  if (result.ok) {
    console.log(result.message);
  } else {
    console.error(result.message);
  }

  process.exitCode = result.ok ? 0 : 1;
}
