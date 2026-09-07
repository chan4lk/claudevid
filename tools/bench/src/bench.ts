// Standalone bench harness (spec.md FR11, AC13; design.md's `tools/bench/src/bench.ts`
// section). Renders `reference-spec.ts`'s fixed, short `VideoSpec` through the real pipeline —
// `compileTimeline` (`@claudevid/core`) -> `renderFrame` (`@claudevid/renderer-canvas`) ->
// `createEncodePipe` (this change's `@claudevid/encoder-ffmpeg`) — and reports render ms/frame
// p50/p95, render fps, encode fps (from `ProgressEvent`s), and total wall clock, plus each
// against the documented `<15/<10/<5`min targets SCALED to the reference spec's own (short)
// duration (design.md's `report()` description).
//
// Invoked directly — `pnpm --filter @claudevid/bench bench` (design.md D7) — or imported as a
// library and called via its exported `runBench(argv)` (change 007's `packages/cli/src/commands/
// bench.ts`). The self-invoking `main()` below is gated on this module being the actual entry
// script (`isDirectRun`), not merely imported — otherwise every `claudevid <anything>` invocation
// would also run a real bench pass as a side effect of statically importing `@claudevid/bench`.

import { performance } from "node:perf_hooks";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { compileTimeline } from "@claudevid/core";
import { createRenderer, createFrameBuffer } from "@claudevid/renderer-canvas";
import { probe, createEncodePipe, createTempRun } from "@claudevid/encoder-ffmpeg";
import type { ProgressEvent } from "@claudevid/encoder-ffmpeg";

import { parseArgs, ArgError } from "./args.js";
import { referenceSpec } from "./reference-spec.js";

/** The doc's stated targets (spec.md Overview/FR11) are for a 30-minute 1080p30 reference —
 * this harness's own reference spec is much shorter (AC13), so `report()` scales these down
 * proportionally rather than comparing wall clock against them literally. */
const FULL_REFERENCE_DURATION_SECONDS = 30 * 60;
const TARGET_MINUTES = { primary: 15, aggressive10min: 10, aggressive5min: 5 } as const;

function percentile(samplesMs: number[], p: number): number {
  if (samplesMs.length === 0) return 0;
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function formatMs(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}

interface BenchResult {
  frameCount: number;
  renderMsSamples: number[];
  wallMs: number;
  lastProgress: ProgressEvent | null;
  specDurationSeconds: number;
}

/** Prints render ms/frame p50/p95, render fps, encode fps, total wall clock, and the
 * scaled-target comparison — the documented report format (spec.md AC13, design.md). */
function report(result: BenchResult): void {
  const { frameCount, renderMsSamples, wallMs, lastProgress, specDurationSeconds } = result;

  const renderMsTotal = renderMsSamples.reduce((sum, ms) => sum + ms, 0);
  const renderFps = renderMsTotal > 0 ? frameCount / (renderMsTotal / 1000) : 0;
  const p50 = percentile(renderMsSamples, 50);
  const p95 = percentile(renderMsSamples, 95);

  // Encode fps, derived from ProgressEvents (FR11): FFmpeg's own `frame=` counter from the
  // last observed progress line, divided by total wall-clock seconds — a practical proxy built
  // from exactly the fields `pipe.ts`'s `ProgressEvent` contract exposes (no separate
  // encode-only timer is threaded through `createEncodePipe`).
  const encodeFps = lastProgress ? lastProgress.frame / (wallMs / 1000) : null;

  const scale = specDurationSeconds / FULL_REFERENCE_DURATION_SECONDS;

  console.log("=== claudevid bench report ===");
  console.log(`frames rendered:        ${frameCount}`);
  console.log(`render ms/frame (p50):  ${formatMs(p50)}`);
  console.log(`render ms/frame (p95):  ${formatMs(p95)}`);
  console.log(`render fps:             ${renderFps.toFixed(2)}`);
  console.log(`encode fps:             ${encodeFps !== null ? encodeFps.toFixed(2) : "n/a (no progress events observed)"}`);
  console.log(`total wall clock:       ${formatMs(wallMs)} (${(wallMs / 1000).toFixed(2)}s)`);
  console.log("");
  console.log(
    `reference spec duration: ${specDurationSeconds}s — NOT the full 30-minute reference the ` +
      `<15/<10/<5min targets below describe (spec.md AC13/Notes' deferral to a real run on ` +
      `Apple Silicon). Targets are scaled by this spec's duration / 1800s = ${scale.toFixed(6)}x ` +
      `for a like-for-like comparison; this scaled PASS/FAIL is indicative only, not the real gate.`
  );
  for (const [name, minutes] of Object.entries(TARGET_MINUTES)) {
    const targetMs = minutes * 60 * 1000 * scale;
    const pass = wallMs < targetMs;
    console.log(`  ${name.padEnd(16)} scaled target: ${formatMs(targetMs)} — ${pass ? "PASS" : "FAIL"}`);
  }
}

export async function runBench(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  const spec = referenceSpec();
  const specDurationSeconds = spec.scenes.reduce(
    (sum, scene) => sum + (typeof scene.duration === "number" ? scene.duration : 0),
    0
  );
  const timeline = compileTimeline(spec);

  const capabilities = await probe();
  const renderer = createRenderer(spec.width, spec.height);
  const frame = createFrameBuffer(spec.width, spec.height);
  const tempRun = createTempRun();

  let lastProgress: ProgressEvent | null = null;

  try {
    const pipe = createEncodePipe({
      profileName: args.profile,
      geometry: { width: spec.width, height: spec.height, fps: spec.fps },
      outputPath: path.join(tempRun.dir, "bench-out.mp4"),
      capabilities,
      cpuEncode: args.cpuEncode,
      tempRun,
    });
    pipe.onProgress((event) => {
      lastProgress = event;
    });

    const renderMsSamples: number[] = [];
    const t0 = performance.now();
    for (let f = 0; f < timeline.frameCount; f++) {
      const rt0 = performance.now();
      await renderer.renderFrame(timeline, f, frame);
      renderMsSamples.push(performance.now() - rt0);
      await pipe.write(frame.data);
    }
    await pipe.finish();
    const wallMs = performance.now() - t0;

    report({ frameCount: timeline.frameCount, renderMsSamples, wallMs, lastProgress, specDurationSeconds });
  } finally {
    renderer.dispose();
    await tempRun.cleanup();
  }
}

async function main(): Promise<void> {
  await runBench(process.argv.slice(2));
}

const isDirectRun =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof ArgError ? `bench: ${err.message}` : err);
    process.exitCode = 1;
  });
}
