// `claudevid batch <dir>` (spec.md FR6/AC8, design.md D3). Reads every `*.json` file in `<dir>`,
// classifies each as a pre-built spec (`parseSpec` succeeds) or a prompt-list entry
// (`{ prompt: string, out?: string }`), and runs each through a fixed-size worker pool bounded by
// `--concurrency` (default 1). Writes `<dir>/batch-manifest.json` after every job — success or
// failure — so a killed batch still leaves a usable partial manifest (Edge Cases). A job that is
// neither a valid spec nor a valid prompt description is recorded `failed` without ever reaching
// `deps.runJob`.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { parseSpec, type VideoSpec } from "@claudevid/core";
import { generateSpec, buildDirectorPrompt } from "@claudevid/claude";
import { exportCatalogue } from "@claudevid/motion";
import { BUNDLED_LANGS, BUNDLED_THEMES } from "@claudevid/layer-code";

import { ArgError, findFlagValue, hasFlag } from "../args.js";
import { loadConfig } from "../config.js";
import { runRenderPipeline } from "../render-pipeline.js";
import { runGenerate, type GenerateDeps } from "./generate.js";

export interface BatchCommandArgs {
  dir: string;
  concurrency: number;
  render: boolean;
}

/** Pure argument parsing — no filesystem access. `argv[0]` is the job directory. */
export function parseBatchArgs(argv: string[]): BatchCommandArgs {
  const dir = argv[0];
  if (!dir) {
    throw new ArgError("batch requires a directory");
  }

  const concurrencyRaw = findFlagValue(argv, "--concurrency");
  const concurrency = concurrencyRaw !== undefined ? Number(concurrencyRaw) : 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new ArgError("--concurrency must be a positive integer");
  }

  const render = hasFlag(argv, "--render");

  return { dir, concurrency, render };
}

export interface BatchJobResult {
  file: string;
  status: "ok" | "failed";
  error?: string;
  outputPath?: string;
}

export interface BatchDeps {
  listFiles: (dir: string) => string[];
  readFile: (path: string) => string;
  writeManifest: (path: string, manifest: BatchJobResult[]) => void;
  runJob: (file: string, content: string) => Promise<{ outputPath?: string }>;
}

type JobClassification =
  | { kind: "spec"; spec: VideoSpec }
  | { kind: "prompt"; prompt: string; out?: string }
  | { kind: "invalid"; error: string };

/** Classifies a job file's raw content as a ready spec, a `{prompt}` job description, or
 * unusable-as-either (Edge Cases: "neither a valid VideoSpec ... nor a {prompt} job
 * description"). Shared between the classification step below (which decides whether a job even
 * reaches `runJob`) and the real `runJob` wired in `runBatchFromCli` (which needs to know how to
 * dispatch a job it's already been told is valid). */
function classifyJob(content: string): JobClassification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      kind: "invalid",
      error: `neither a valid VideoSpec (see diagnostics: invalid JSON: ${reason}) nor a {prompt} job description`,
    };
  }

  const specResult = parseSpec(parsed);
  if (specResult.ok) {
    return { kind: "spec", spec: specResult.spec };
  }

  const obj = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  const prompt = obj?.prompt;
  if (typeof prompt === "string") {
    const out = typeof obj?.out === "string" ? obj.out : undefined;
    return { kind: "prompt", prompt, out };
  }

  const diagnostics = specResult.diagnostics
    .map((d) => `${d.path}: ${d.message}${d.suggestion ? `, suggestion: ${d.suggestion}` : ""}`)
    .join("; ");
  return {
    kind: "invalid",
    error: `neither a valid VideoSpec (see diagnostics: ${diagnostics}) nor a {prompt} job description`,
  };
}

/**
 * Runs every file `deps.listFiles(args.dir)` returns through a fixed-size worker pool of
 * `args.concurrency` workers pulling from a shared index. Never throws for an individual job
 * failure — only `deps.listFiles` itself throwing (e.g. a bad directory) propagates. Writes the
 * manifest (via `deps.writeManifest`) after every completed job, in original file order, so a
 * killed batch leaves a usable partial manifest.
 */
export async function runBatch(args: BatchCommandArgs, deps: BatchDeps): Promise<BatchJobResult[]> {
  const files = deps.listFiles(args.dir);
  const results: BatchJobResult[] = new Array(files.length);
  const manifestPath = path.join(args.dir, "batch-manifest.json");

  const writeManifestSoFar = () => {
    deps.writeManifest(manifestPath, results.filter((r): r is BatchJobResult => r !== undefined));
  };

  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < files.length) {
      const i = nextIndex++;
      const file = files[i]!;
      const content = deps.readFile(file);
      const job = classifyJob(content);

      let result: BatchJobResult;
      if (job.kind === "invalid") {
        result = { file, status: "failed", error: job.error };
      } else {
        try {
          const jobResult = await deps.runJob(file, content);
          result = { file, status: "ok", outputPath: jobResult.outputPath };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = { file, status: "failed", error: message };
        }
      }

      results[i] = result;
      writeManifestSoFar();
    }
  };

  await Promise.all(Array.from({ length: args.concurrency }, () => worker()));

  return results;
}

/** Real dispatch for a job already classified as valid (spec or prompt) — re-classifies `content`
 * (cheap, and keeps `BatchDeps.runJob`'s signature to exactly `(file, content)`) then either
 * delegates to `runGenerate` (prompt job) or runs the shared render pipeline directly against the
 * already-parsed spec (ready-spec job, only when `--render` is set). */
async function realRunJob(
  file: string,
  content: string,
  args: BatchCommandArgs,
  generateDeps: GenerateDeps,
): Promise<{ outputPath?: string }> {
  const job = classifyJob(content);

  if (job.kind === "prompt") {
    const result = await runGenerate({ prompt: job.prompt, outPath: job.out, render: args.render }, generateDeps);
    if (!result.ok) {
      throw new Error(result.message);
    }
    return { outputPath: result.outPath };
  }

  if (job.kind === "spec") {
    if (!args.render) {
      return {};
    }
    const outputPath = file.replace(/\.json$/, ".mp4");
    await runRenderPipeline(job.spec, { profileName: "final", outputPath });
    return { outputPath };
  }

  // classifyJob already filtered this job out before it could reach runJob.
  throw new Error(job.error);
}

/**
 * Real (non-DI) entry point. Parses `argv`, loads `claudevid.config.json` once for the whole
 * batch (FR7 — not re-read per job), wires the real filesystem and the real generate/render
 * pipelines, then prints one line per job. Per AC8, individual job failures never fail the batch
 * itself — `process.exitCode` is always 0 once the batch has run.
 */
export async function runBatchFromCli(argv: string[]): Promise<void> {
  const args = parseBatchArgs(argv);
  const config = loadConfig();

  const generateDeps: GenerateDeps = {
    apiKeyEnv: process.env,
    generateSpec,
    buildDirectorPrompt,
    exportCatalogue,
    bundledLangs: BUNDLED_LANGS,
    bundledThemes: BUNDLED_THEMES,
    config,
    writeFile: (path, fileContent) => writeFileSync(path, fileContent, "utf-8"),
    runRenderPipeline,
  };

  const deps: BatchDeps = {
    listFiles: (dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith(".json") && name !== "batch-manifest.json")
        .map((name) => path.join(dir, name)),
    readFile: (p) => readFileSync(p, "utf-8"),
    writeManifest: (p, manifest) => writeFileSync(p, JSON.stringify(manifest, null, 2), "utf-8"),
    runJob: (file, content) => realRunJob(file, content, args, generateDeps),
  };

  const results = await runBatch(args, deps);

  for (const result of results) {
    if (result.status === "ok") {
      console.log(`${result.file}: ok${result.outputPath ? ` (${result.outputPath})` : ""}`);
    } else {
      console.error(`${result.file}: failed — ${result.error}`);
    }
  }

  process.exitCode = 0;
}
