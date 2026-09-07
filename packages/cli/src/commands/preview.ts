// `claudevid preview <spec>` (spec.md FR3). Runs the shared render pipeline (FR9) at a
// 1280-wide-cap working resolution via `render-pipeline.ts`'s own `opts.scale` seam,
// encoded with the "preview" profile. `--watch` re-runs on file change (`fs.watch`, 250ms
// debounce, no new dependency). `--sheet <path>` instead renders N evenly-spaced frames into
// one contact-sheet PNG via `@napi-rs/canvas`, independent of `tools/motion-preview` (which
// stays its own standalone dev tool per design.md's Decisions).
//
// Note (per this task's brief): `render-pipeline.ts` does not itself construct a smaller
// `createRenderer(1280, 720)` — it always renders at `spec.width`/`spec.height` native and only
// forwards `opts.scale` into each `renderFrame` call. That is `render-pipeline.ts`'s existing,
// accepted design (out of scope to change here); this command passes `scale` through exactly as
// it's supported today.

import { readFileSync, writeFileSync, mkdirSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";

import type { VideoSpec } from "@claudevid/core";
import { parseSpec, compileTimeline } from "@claudevid/core";
import { createRenderer, createFrameBuffer } from "@claudevid/renderer-canvas";
import { createCanvas, ImageData } from "@napi-rs/canvas";

import { ArgError, findFlagValue, hasFlag } from "../args.js";
import { runRenderPipeline } from "../render-pipeline.js";

export const MAX_SHEET_FRAMES = 24;
export const DEFAULT_SHEET_FRAMES = 6;

const WATCH_DEBOUNCE_MS = 250;
const PREVIEW_MAX_WIDTH = 1280;

export interface PreviewCommandArgs {
  specPath: string;
  watch: boolean;
  sheetPath?: string;
  sheetFrames: number;
}

/** Pure argument parsing — no filesystem access (NFR2, mirrors tools/motion-preview/src/args.ts
 * and render.ts's `parseRenderArgs`). `argv[0]` is the spec path. */
export function parsePreviewArgs(argv: string[]): PreviewCommandArgs {
  const specPath = argv[0];
  if (!specPath) {
    throw new ArgError("preview requires a spec file path");
  }

  const watch = hasFlag(argv, "--watch");
  const sheetPath = findFlagValue(argv, "--sheet");

  const framesValue = findFlagValue(argv, "--frames");
  const sheetFrames = framesValue !== undefined ? Number(framesValue) : DEFAULT_SHEET_FRAMES;
  if (!Number.isFinite(sheetFrames) || sheetFrames < 1) {
    throw new ArgError("--frames must be a positive integer");
  }
  if (sheetFrames > MAX_SHEET_FRAMES) {
    throw new ArgError(`--frames must be at most ${MAX_SHEET_FRAMES}, got ${sheetFrames}`);
  }

  return { specPath, watch, sheetPath, sheetFrames };
}

/**
 * One preview render (FR3): computes the 1280-cap `scale` and delegates to
 * `deps.runRenderPipeline` with the "preview" profile. Testable with a fully injected
 * `runRenderPipeline` fake (NFR3) — no real renderer/encoder/FFmpeg involved.
 */
export async function runPreviewOnce(
  spec: VideoSpec,
  deps: { runRenderPipeline: typeof runRenderPipeline; outputPath: string },
): Promise<{ ok: boolean; message: string }> {
  const scale = spec.width > PREVIEW_MAX_WIDTH ? PREVIEW_MAX_WIDTH / spec.width : undefined;

  try {
    await deps.runRenderPipeline(spec, { profileName: "preview", outputPath: deps.outputPath, scale });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, message: reason };
  }

  return { ok: true, message: `wrote ${deps.outputPath}` };
}

/**
 * `--sheet` (FR3): renders `opts.frameCount` evenly-spaced frames of `compileTimeline(spec)`'s
 * timeline (no `audioDurations` — an `"auto"`-duration scene throws `MissingAudioDurationError`,
 * left to propagate: narrated-auto-duration specs aren't previewable via contact sheet without a
 * real synthesis pass, out of scope for v1), composites them into one grid PNG, and writes the
 * bytes via `deps.writeFileFn`. Every external effect is an injectable seam (NFR3).
 */
export async function renderContactSheet(
  spec: VideoSpec,
  opts: { frameCount: number; sheetPath: string },
  deps: {
    createRendererFn?: typeof createRenderer;
    createFrameBufferFn?: typeof createFrameBuffer;
    writeFileFn?: (path: string, data: Buffer) => void;
  } = {},
): Promise<void> {
  const createRendererFn = deps.createRendererFn ?? createRenderer;
  const createFrameBufferFn = deps.createFrameBufferFn ?? createFrameBuffer;
  const writeFileFn = deps.writeFileFn ?? writeFileSync;

  const timeline = compileTimeline(spec);
  const frameCount = opts.frameCount;

  const cols = Math.ceil(Math.sqrt(frameCount));
  const rows = Math.ceil(frameCount / cols);
  const sheetCanvas = createCanvas(spec.width * cols, spec.height * rows);
  const sheetCtx = sheetCanvas.getContext("2d");

  const renderer = createRendererFn(spec.width, spec.height);
  const frameBuffer = createFrameBufferFn(spec.width, spec.height);

  try {
    for (let i = 0; i < frameCount; i++) {
      // Evenly spaced across [0, timeline.frameCount): floor-scaled index, clamped to the last
      // valid frame so a small frameCount never reads past the end of a short timeline.
      const frameIndex = Math.min(Math.floor((i * timeline.frameCount) / frameCount), timeline.frameCount - 1);

      await renderer.renderFrame(timeline, frameIndex, frameBuffer);

      const clamped = new Uint8ClampedArray(frameBuffer.data.buffer, frameBuffer.data.byteOffset, frameBuffer.data.byteLength);
      const imageData = new ImageData(clamped, frameBuffer.width, frameBuffer.height);

      const col = i % cols;
      const row = Math.floor(i / cols);
      sheetCtx.putImageData(imageData, col * spec.width, row * spec.height);
    }
  } finally {
    renderer.dispose();
  }

  const pngBytes = sheetCanvas.toBuffer("image/png");
  writeFileFn(opts.sheetPath, pngBytes);
}

/** Real (non-DI) `--watch` loop: re-reads, re-`parseSpec`s, and re-renders on every spec file
 * change, debounced 250ms. Never crashes the loop on a bad spec or a failed render — logs and
 * waits for the next change instead. Runs until the process is killed. */
async function watchPreview(specPath: string, outputPath: string): Promise<void> {
  const rerender = async (): Promise<void> => {
    try {
      const raw = readFileSync(specPath, "utf-8");
      const json = JSON.parse(raw);
      const result = parseSpec(json);
      if (!result.ok) {
        const message = result.diagnostics.map((d) => `${d.path}: ${d.message}`).join("\n");
        console.error(`preview --watch: spec invalid, skipping this render:\n${message}`);
        return;
      }

      const outcome = await runPreviewOnce(result.spec, { runRenderPipeline, outputPath });
      if (outcome.ok) {
        console.log(outcome.message);
      } else {
        console.error(`preview --watch: render failed: ${outcome.message}`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`preview --watch: re-render attempt failed: ${reason}`);
    }
  };

  await rerender();

  console.log(`preview --watch: watching "${specPath}" for changes...`);
  let debounceTimer: NodeJS.Timeout | undefined;
  fsWatch(specPath, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void rerender();
    }, WATCH_DEBOUNCE_MS);
  });

  // fs.watch keeps the event loop alive on its own; this just parks the async function so
  // runPreviewFromCli's caller awaits the (indefinitely-running) watch session.
  await new Promise<void>(() => {});
}

/**
 * Real (non-DI) entry point. Parses `argv`, reads + `parseSpec`s the spec file (validate.ts's
 * exact error-reporting shape), then dispatches to `--sheet`, `--watch`, or a single preview
 * render. Called by `cli.ts`'s command dispatch (T19).
 */
export async function runPreviewFromCli(argv: string[]): Promise<void> {
  const args = parsePreviewArgs(argv);

  const raw = readFileSync(args.specPath, "utf-8");

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`/: invalid JSON: ${reason}`);
    process.exitCode = 1;
    return;
  }

  const result = parseSpec(json);
  if (!result.ok) {
    const message = result.diagnostics
      .map((d) => `${d.path}: ${d.message}${d.suggestion ? `, suggestion: ${d.suggestion}` : ""}`)
      .join("\n");
    console.error(message);
    process.exitCode = 1;
    return;
  }

  const spec = result.spec;

  if (args.sheetPath) {
    try {
      await renderContactSheet(spec, { frameCount: args.sheetFrames, sheetPath: args.sheetPath });
      console.log(`wrote ${args.sheetPath}`);
      process.exitCode = 0;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(reason);
      process.exitCode = 1;
    }
    return;
  }

  mkdirSync(".claudevid", { recursive: true });
  const outputPath = join(".claudevid", "preview.mp4");

  if (args.watch) {
    await watchPreview(args.specPath, outputPath);
    return;
  }

  const outcome = await runPreviewOnce(spec, { runRenderPipeline, outputPath });
  if (outcome.ok) {
    console.log(outcome.message);
  } else {
    console.error(outcome.message);
  }
  process.exitCode = outcome.ok ? 0 : 1;
}
