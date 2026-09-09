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
  const summaryLine = `${spec.scenes.length} ${sceneWord}, ~${totalSeconds}s${autoSuffix}`;

  // Compare each scene's authored `narration` block count (from the raw parsed JSON, before
  // `parseSpec` chunked any over-length blocks) against the resolved count, mirroring
  // `narrationSchema`'s own shape-normalization in `@claudevid/core`'s schema.ts.
  const rawScenes = Array.isArray((json as { scenes?: unknown })?.scenes)
    ? (json as { scenes: unknown[] }).scenes
    : [];
  const narrationLines: string[] = [];
  spec.scenes.forEach((scene, i) => {
    const rawNarration = (rawScenes[i] as { narration?: unknown } | undefined)?.narration;
    const authoredCount = Array.isArray(rawNarration) ? rawNarration.length : rawNarration == null ? 0 : 1;
    const resolvedCount = scene.narration?.length ?? 0;
    if (authoredCount !== resolvedCount) {
      const authoredWord = authoredCount === 1 ? "block" : "blocks";
      const resolvedWord = resolvedCount === 1 ? "sub-block" : "sub-blocks";
      narrationLines.push(
        `scene "${scene.id}": narration normalized from ${authoredCount} authored ${authoredWord} to ${resolvedCount} ${resolvedWord}`,
      );
    }
  });

  const message = [summaryLine, ...narrationLines].join("\n");

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
