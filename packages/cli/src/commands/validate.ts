// `claudevid validate <spec>` (spec.md FR2/AC2). Reads the file, `JSON.parse`s it, runs
// `@claudevid/core`'s `parseSpec`. Never lets a raw `SyntaxError` or `ZodError` escape this
// command's own error boundary — a malformed-JSON file is reported as one diagnostic at pointer
// `/`, not a stack trace.

import { readFileSync } from "node:fs";

import { parseSpec } from "@claudevid/core";

import { ArgError } from "../args.js";

export interface ValidateDeps {
  readFile: (path: string) => string;
}

export interface ValidateResult {
  ok: boolean;
  sceneCount: number;
  message: string;
}

/**
 * Pure validation logic, testable with a fully injected `readFile` fake (no real disk I/O).
 */
export function runValidate(specPath: string, deps: ValidateDeps): ValidateResult {
  const raw = deps.readFile(specPath);

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, sceneCount: 0, message: `/: invalid JSON: ${reason}` };
  }

  const result = parseSpec(json);
  if (!result.ok) {
    const message = result.diagnostics
      .map((d) => `${d.path}: ${d.message}${d.suggestion ? `, suggestion: ${d.suggestion}` : ""}`)
      .join("\n");
    return { ok: false, sceneCount: 0, message };
  }

  const { spec } = result;
  let totalSeconds = 0;
  let autoCount = 0;
  for (const scene of spec.scenes) {
    if (typeof scene.duration === "number") {
      totalSeconds += scene.duration;
    } else {
      autoCount += 1;
    }
  }

  const autoSuffix = autoCount > 0 ? ` (${autoCount} auto-duration)` : "";
  const sceneWord = spec.scenes.length === 1 ? "scene" : "scenes";
  const message = `${spec.scenes.length} ${sceneWord}, ~${totalSeconds}s${autoSuffix}`;

  return { ok: true, sceneCount: spec.scenes.length, message };
}

/**
 * Real (non-DI) entry point. Parses `argv[0]` as the spec path, validates it against real disk
 * I/O, and prints the result. Called by `cli.ts`'s command dispatch (T19).
 */
export function runValidateFromCli(argv: string[]): void {
  const specPath = argv[0];
  if (!specPath) {
    throw new ArgError("validate requires a spec file path");
  }

  const deps: ValidateDeps = {
    readFile: (path) => readFileSync(path, "utf-8"),
  };

  const result = runValidate(specPath, deps);

  if (result.ok) {
    console.log(result.message);
  } else {
    console.error(result.message);
  }

  process.exitCode = result.ok ? 0 : 1;
}
