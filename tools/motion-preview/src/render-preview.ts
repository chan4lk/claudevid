import { readFileSync, writeFileSync } from "node:fs";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { parseSpec, compileTimeline } from "@claudevid/core";
import { compileMotion, createResolver } from "@claudevid/motion";
import { createRenderer, createFrameBuffer } from "@claudevid/renderer-canvas";

const TILE_WIDTH = 320;

export interface RenderPreviewOptions {
  specPath: string;
  outPath: string;
  sceneId?: string;
  frames: number;
}

/** Renders `frames` evenly-spaced frames of one scene to a single PNG contact sheet, using
 * the real render/motion stack (spec.md FR17) — deliberately not part of `@claudevid/
 * motion`'s own test suite (NFR1), which stays canvas-free. */
export async function renderPreview(opts: RenderPreviewOptions): Promise<void> {
  const raw = JSON.parse(readFileSync(opts.specPath, "utf-8"));
  const parsed = parseSpec(raw);
  if (!parsed.ok) {
    throw new Error(`spec parse failed: ${JSON.stringify(parsed.diagnostics)}`);
  }

  const spec = parsed.spec;
  const timeline = compileTimeline(spec);
  const { compiled, diagnostics } = compileMotion(spec, timeline);
  if (diagnostics.length > 0) {
    throw new Error(`motion diagnostics: ${JSON.stringify(diagnostics)}`);
  }
  const resolver = createResolver(compiled, timeline);

  const window = opts.sceneId
    ? timeline.sceneWindows.find((w) => w.sceneId === opts.sceneId)
    : timeline.sceneWindows[0];
  if (!window) throw new Error(`scene "${opts.sceneId ?? ""}" not found`);

  const tileWidth = TILE_WIDTH;
  const tileHeight = Math.round((tileWidth / spec.width) * spec.height);
  const scale = tileWidth / spec.width;

  const renderer = createRenderer(tileWidth, tileHeight);
  const grid = createCanvas(tileWidth * opts.frames, tileHeight);
  const gridCtx = grid.getContext("2d");

  const windowFrameCount = window.endFrame - window.startFrame;
  for (let i = 0; i < opts.frames; i++) {
    const step = opts.frames > 1 ? (i * Math.max(0, windowFrameCount - 1)) / (opts.frames - 1) : 0;
    const frame = window.startFrame + Math.round(step);

    const target = createFrameBuffer(tileWidth, tileHeight);
    await renderer.renderFrame(timeline, frame, target, { scale, motion: resolver });

    const imageData = new ImageData(new Uint8ClampedArray(target.data), tileWidth, tileHeight);
    gridCtx.putImageData(imageData, i * tileWidth, 0);
  }

  writeFileSync(opts.outPath, grid.toBuffer("image/png"));
}
