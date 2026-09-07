import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { parseSpec, compileTimeline } from "@claudevid/core";
import type { Timeline } from "@claudevid/core";
import { createRenderer, createFrameBuffer } from "../src/index.js";

// CI-gated performance test (AC7): a representative 1080p scene renders fast on a warm
// raster cache, measured over >= 10 consecutive frames via RenderStats/collected samples.

const WIDTH = 1920;
const HEIGHT = 1080;
const SCENE_COUNT = 12;

function makeImageDataUrl(): string {
  // Same in-memory synthetic-PNG-as-data-URL approach as draw-image.test.ts — no checked-in
  // binary asset needed for a representative "image layer".
  const source = createCanvas(8, 8);
  const ctx = source.getContext("2d");
  ctx.fillStyle = "#3366ff";
  ctx.fillRect(0, 0, 8, 8);
  const pngBuffer = source.toBuffer("image/png");
  return `data:image/png;base64,${pngBuffer.toString("base64")}`;
}

function buildRepresentativeSpec() {
  const imageSrc = makeImageDataUrl();

  // `SCENE_COUNT` distinct 1-frame-long scenes, each repeating the *identical* title-text +
  // rect + image content. fps=30 and duration=1/30s means framesFor(1/30, 30) rounds to
  // exactly 1 frame per scene, so scene `i` occupies exactly timeline frame `i`.
  //
  // Why distinct scenes with identical content, rather than one long static scene: v1's
  // hold-frame reuse (FR11) means a single static scene would degenerate into byte-copy
  // reuse from frame 1 onward (that mechanism is already covered by AC5 in render.test.ts)
  // and would never exercise the raster-cache *blit* path — the actual "central performance
  // claim" this AC is meant to guard. Distinct scenes give each frame a different
  // `layerKey` set (so hold-frame never fires) while the identical text/fill/src content
  // still hits the same content-hash cache keys (raster-cache.ts) after the first scene's
  // frame, so frames 1..N-1 are genuine cache-hit repaints, not copies.
  const scenes = Array.from({ length: SCENE_COUNT }, (_, i) => ({
    id: `scene-${i}`,
    duration: 1 / 30,
    layers: [
      { type: "text", text: "Representative Title", fontSize: 96, color: "#ffffff", x: 120, y: 100 },
      { type: "rect", x: 120, y: 400, width: 500, height: 300, fill: "#224488", radius: 24 },
      { type: "image", src: imageSrc, x: 700, y: 400, width: 400, height: 300, fit: "cover" as const },
    ],
  }));

  return {
    version: 1 as const,
    width: WIDTH,
    height: HEIGHT,
    fps: 30,
    scenes,
  };
}

function compile(specInput: unknown): Timeline {
  const result = parseSpec(specInput);
  if (!result.ok) {
    throw new Error(`spec parse failed: ${JSON.stringify(result.diagnostics)}`);
  }
  return compileTimeline(result.spec);
}

describe("Renderer performance — representative 1080p scene (AC7)", () => {
  it("renders cache-warm frames under the calibrated p95 ceiling", async () => {
    const timeline = compile(buildRepresentativeSpec());
    const renderer = createRenderer(WIDTH, HEIGHT);
    const target = createFrameBuffer(WIDTH, HEIGHT);

    // Frame 0 is the only real cache-miss frame (text layout+raster, rect raster, one
    // image decode). Discard its timing — it pays for the whole cache's warm-up, and AC7
    // is explicitly about the warm-cache steady state, not the first frame.
    await renderer.renderFrame(timeline, 0, target);

    const samples: number[] = [];
    for (let frame = 1; frame < SCENE_COUNT; frame++) {
      const start = performance.now();
      await renderer.renderFrame(timeline, frame, target);
      samples.push(performance.now() - start);
    }

    expect(samples.length).toBeGreaterThanOrEqual(10);

    const sorted = [...samples].sort((a, b) => a - b);
    const p95Index = Math.floor(0.95 * (sorted.length - 1));
    const p95 = sorted[p95Index]!;

    // Ceiling calibration: repeated local runs of this exact loop (11 cache-hit frames,
    // 1080p working canvas, 3 layers/frame: text blit + rect blit + image drawImage) on
    // this sandboxed environment observed individual samples ranging ~5.6-18.3ms and a
    // per-run p95 usually 9.8-14.0ms, occasionally spiking past 20ms under shared-CPU
    // scheduling noise (observed ~1-in-25 runs at a 25ms ceiling). spec.md AC7's stated
    // target is "under 20ms/frame" measured on an M3; 35ms keeps real margin above the
    // noisy tail actually observed here (a flaky perf gate is worse than a slightly looser
    // one) while remaining far tighter than a value that would miss an order-of-magnitude
    // regression in the cache-hit paint path.
    const CEILING_MS = 35;
    expect(p95).toBeLessThan(CEILING_MS);

    // Sanity check RenderStats agrees there were exactly SCENE_COUNT frames recorded
    // (frame 0's miss + the SCENE_COUNT-1 timed cache-hit frames) and reports a sane p95.
    const stats = renderer.stats();
    expect(stats.msPerFrame.length).toBe(SCENE_COUNT);
    expect(stats.p95).toBeGreaterThanOrEqual(0);
    expect(stats.cacheMisses).toBeGreaterThan(0);
    expect(stats.cacheHits).toBeGreaterThan(0);
  });
});
