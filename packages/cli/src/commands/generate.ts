// `claudevid generate "<prompt>"` (spec.md FR5). Thin wrapper: builds the director prompt (FR8)
// from the current preset catalogue / bundled langs+themes / brand kit, calls @claudevid/claude's
// generateSpec (bounded repair loop), writes the resulting spec, and re-`parseSpec`s it as a
// final integrity check. Does NOT render by default (spec.md Decisions) — `--render` opts in to
// running the shared render pipeline (FR9) against the freshly-written spec.

import { writeFileSync } from "node:fs";

import { parseSpec } from "@claudevid/core";
import { generateSpec, buildDirectorPrompt, type BrandKitConfig } from "@claudevid/claude";
import { exportCatalogue, type CatalogueEntry } from "@claudevid/motion";
import { BUNDLED_LANGS, BUNDLED_THEMES } from "@claudevid/layer-code";

import { ArgError, findFlagValue, hasFlag } from "../args.js";
import { loadConfig } from "../config.js";
import { runRenderPipeline } from "../render-pipeline.js";

/** Per spec.md Decisions — override via config `model` or `--model`; bumping this as models
 * change is a config edit, not a code change. */
export const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

export interface GenerateCommandArgs {
  prompt: string;
  outPath?: string;
  render: boolean;
  model?: string;
  repairAttempts?: number;
}

/** Pure argument parsing — no filesystem access. `argv[0]` is the prompt. */
export function parseGenerateArgs(argv: string[]): GenerateCommandArgs {
  const prompt = argv[0];
  if (!prompt) {
    throw new ArgError("generate requires a prompt");
  }

  const outPath = findFlagValue(argv, "--out");
  const model = findFlagValue(argv, "--model");
  const render = hasFlag(argv, "--render");

  const repairAttemptsRaw = findFlagValue(argv, "--repair-attempts");
  const repairAttempts = repairAttemptsRaw !== undefined ? Number(repairAttemptsRaw) : undefined;
  if (repairAttemptsRaw !== undefined && (!Number.isInteger(repairAttempts) || (repairAttempts as number) <= 0)) {
    throw new ArgError("--repair-attempts must be a positive integer");
  }

  return { prompt, outPath, render, model, repairAttempts };
}

/** Lowercases, replaces runs of non-alphanumerics with a single "-", trims leading/trailing "-",
 * then truncates to ~40 chars (re-trimming any trailing "-" the truncation exposes). Used to
 * derive the default `--out` path (`specs/<slug>.json`) from a free-text prompt. */
export function slugify(prompt: string): string {
  const collapsed = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return collapsed.slice(0, 40).replace(/-+$/, "");
}

export interface GenerateDeps {
  apiKeyEnv: Record<string, string | undefined>;
  generateSpec: typeof generateSpec;
  buildDirectorPrompt: typeof buildDirectorPrompt;
  exportCatalogue: () => CatalogueEntry[];
  bundledLangs: readonly string[];
  bundledThemes: readonly string[];
  config: BrandKitConfig;
  writeFile: (path: string, content: string) => void;
  runRenderPipeline?: typeof runRenderPipeline;
}

export interface GenerateCommandResult {
  ok: boolean;
  message: string;
  outPath?: string;
}

/**
 * Pure-ish generation logic, testable with fully injected fakes (no real network/disk I/O).
 * Fails fast — before calling `deps.generateSpec` at all — if `ANTHROPIC_API_KEY` is unset
 * (spec.md Edge Cases).
 */
export async function runGenerate(args: GenerateCommandArgs, deps: GenerateDeps): Promise<GenerateCommandResult> {
  const apiKey = deps.apiKeyEnv.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, message: "ANTHROPIC_API_KEY is not set" };
  }

  const outPath = args.outPath ?? `specs/${slugify(args.prompt)}.json`;

  const systemPrompt = deps.buildDirectorPrompt(
    deps.exportCatalogue(),
    deps.bundledLangs,
    deps.bundledThemes,
    deps.config.brand,
  );

  let result: Awaited<ReturnType<typeof generateSpec>>;
  try {
    result = await deps.generateSpec(args.prompt, {
      model: args.model ?? deps.config.model ?? DEFAULT_MODEL_ID,
      apiKey,
      repairAttempts: args.repairAttempts ?? deps.config.repairAttempts,
      systemPrompt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }

  deps.writeFile(outPath, JSON.stringify(result.spec, null, 2));

  // Final integrity check (spec.md FR5) — should never fail given generateSpec's own contract,
  // but checked rather than assumed.
  const integrity = parseSpec(result.spec);
  if (!integrity.ok) {
    const message = integrity.diagnostics
      .map((d) => `${d.path}: ${d.message}${d.suggestion ? `, suggestion: ${d.suggestion}` : ""}`)
      .join("\n");
    return { ok: false, message: `generated spec failed final validation: ${message}`, outPath };
  }

  const attemptWord = result.attempts === 1 ? "attempt" : "attempts";
  let message = `wrote ${outPath} (${result.attempts} ${attemptWord})`;

  if (args.render) {
    try {
      await deps.runRenderPipeline!(result.spec, {
        profileName: "final",
        outputPath: outPath.replace(/\.json$/, ".mp4"),
      });
      message += ", rendered";
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // A render failure after a successful generate must not overwrite the generate's own
      // success — report both distinctly.
      message += ` (render failed: ${reason})`;
    }
  }

  return { ok: true, message, outPath };
}

/**
 * Real (non-DI) entry point. Parses `argv`, loads `claudevid.config.json` (CLI flags win per
 * FR7), wires up the real Anthropic-backed `generateSpec`, and prints the result.
 */
export async function runGenerateFromCli(argv: string[]): Promise<void> {
  const args = parseGenerateArgs(argv);

  const config = loadConfig();

  const deps: GenerateDeps = {
    apiKeyEnv: process.env,
    generateSpec,
    buildDirectorPrompt,
    exportCatalogue,
    bundledLangs: BUNDLED_LANGS,
    bundledThemes: BUNDLED_THEMES,
    config,
    writeFile: (path, content) => writeFileSync(path, content, "utf-8"),
    runRenderPipeline,
  };

  const result = await runGenerate(args, deps);

  if (result.ok) {
    console.log(result.message);
  } else {
    console.error(result.message);
  }

  process.exitCode = result.ok ? 0 : 1;
}
