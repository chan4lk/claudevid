import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { parseSpec, compileTimeline } from "@claudevid/core";
import type { TextLayer, Timeline } from "@claudevid/core";
import { createRenderer, createFrameBuffer } from "../src/index.js";
import type { FrameBuffer } from "../src/index.js";
import { measureAndWrap } from "../src/text.js";

// Integration tests: every `Timeline` below comes from real `parseSpec`/`compileTimeline`
// output (never a hand-built `Timeline` fixture), per AC1/AC3/AC5/AC6/AC9 of
// .specclaw/changes/002-canvas-render-engine/spec.md.

const WIDTH = 1920;
const HEIGHT = 1080;
const BLACK: [number, number, number, number] = [0, 0, 0, 255]; // DEFAULT_BACKGROUND, opaque

function compile(specInput: unknown): Timeline {
  const result = parseSpec(specInput);
  if (!result.ok) {
    throw new Error(`spec parse failed: ${JSON.stringify(result.diagnostics)}`);
  }
  return compileTimeline(result.spec);
}

function textSpec() {
  return {
    version: 1,
    width: WIDTH,
    height: HEIGHT,
    fps: 30,
    scenes: [
      {
        id: "scene-1",
        duration: 2,
        layers: [
          { type: "text", text: "Hello Claudevid", fontSize: 120, color: "#ffffff", x: 100, y: 100 },
        ],
      },
    ],
  };
}

function rectSpec() {
  return {
    version: 1,
    width: WIDTH,
    height: HEIGHT,
    fps: 30,
    scenes: [
      {
        id: "scene-1",
        duration: 1,
        layers: [{ type: "rect", x: 200, y: 150, width: 400, height: 300, fill: "#ff0000" }],
      },
    ],
  };
}

interface BBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Scans the whole buffer for pixels that differ from `bg` (RGB only) and returns their bounding box. */
function nonBackgroundBBox(fb: FrameBuffer, bg: [number, number, number]): BBox | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let y = 0; y < fb.height; y++) {
    for (let x = 0; x < fb.width; x++) {
      const idx = (y * fb.width + x) * 4;
      if (fb.data[idx] !== bg[0] || fb.data[idx + 1] !== bg[1] || fb.data[idx + 2] !== bg[2]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (minX === Infinity) return null;
  return { minX, maxX, minY, maxY };
}

describe("Renderer — paints real Timeline output (AC1)", () => {
  it("produces non-background pixels within the text layer's resolved x/y area", async () => {
    const timeline = compile(textSpec());
    const textLayer = timeline.layers.find((l) => l.type === "text")!;

    const renderer = createRenderer(WIDTH, HEIGHT);
    const target = createFrameBuffer(WIDTH, HEIGHT);
    await renderer.renderFrame(timeline, 10, target);

    // Overall proof something was painted at all.
    let nonBackgroundCount = 0;
    for (let i = 0; i < target.data.length; i += 4) {
      if (
        target.data[i] !== BLACK[0] ||
        target.data[i + 1] !== BLACK[1] ||
        target.data[i + 2] !== BLACK[2] ||
        target.data[i + 3] !== BLACK[3]
      ) {
        nonBackgroundCount++;
      }
    }
    expect(nonBackgroundCount).toBeGreaterThan(0);

    // Narrower proof: within the exact resolved box for this text layer's bitmap
    // (layer.x/layer.y plus the layout's rounded width/height), at least one pixel differs
    // from the background — i.e. glyphs actually landed where the layer resolved to, not
    // just "somewhere on the canvas."
    const layout = measureAndWrap(createCanvas(1, 1).getContext("2d"), textLayer.layer as TextLayer);
    const boxX0 = textLayer.x;
    const boxY0 = textLayer.y;
    const boxX1 = Math.min(WIDTH, boxX0 + Math.ceil(layout.totalWidth));
    const boxY1 = Math.min(HEIGHT, boxY0 + Math.ceil(layout.totalHeight));

    let foundInBox = false;
    for (let y = boxY0; y < boxY1 && !foundInBox; y++) {
      for (let x = boxX0; x < boxX1 && !foundInBox; x++) {
        const idx = (y * WIDTH + x) * 4;
        if (target.data[idx] !== BLACK[0] || target.data[idx + 1] !== BLACK[1] || target.data[idx + 2] !== BLACK[2]) {
          foundInBox = true;
        }
      }
    }
    expect(foundInBox).toBe(true);
  });
});

describe("Renderer — determinism (AC3)", () => {
  it("renders byte-identical FrameBuffer data for the same (timeline, frame) across two independent renderers", async () => {
    const timeline = compile(textSpec());

    const rendererA = createRenderer(WIDTH, HEIGHT);
    const rendererB = createRenderer(WIDTH, HEIGHT);
    const a = createFrameBuffer(WIDTH, HEIGHT);
    const b = createFrameBuffer(WIDTH, HEIGHT);

    await rendererA.renderFrame(timeline, 5, a);
    await rendererB.renderFrame(timeline, 5, b);

    expect(Buffer.compare(a.data, b.data)).toBe(0);
  });
});

describe("Renderer — hold-frame reuse (AC5)", () => {
  it("reuses the previous frame's output byte-identically when the active layer-key set is unchanged", async () => {
    // Single static text layer with no start/duration override spans the entire scene
    // window, so any two consecutive frames within it share an identical activeAt() set —
    // v1 has no per-frame variation (that's change 003's job), so this is the general case,
    // not a special one.
    const timeline = compile(textSpec());
    const renderer = createRenderer(WIDTH, HEIGHT);
    const frameA = createFrameBuffer(WIDTH, HEIGHT);
    const frameB = createFrameBuffer(WIDTH, HEIGHT);

    await renderer.renderFrame(timeline, 10, frameA);
    await renderer.renderFrame(timeline, 11, frameB);

    expect(Buffer.compare(frameA.data, frameB.data)).toBe(0);
    expect(renderer.stats().holdFrames).toBeGreaterThanOrEqual(1);
  });
});

describe("Renderer — resolution scaling (AC6)", () => {
  it("scales the non-background bounding box proportionally to `scale`", async () => {
    const timeline = compile(rectSpec());

    const fullRenderer = createRenderer(WIDTH, HEIGHT);
    const fullTarget = createFrameBuffer(WIDTH, HEIGHT);
    await fullRenderer.renderFrame(timeline, 0, fullTarget);

    const halfWidth = WIDTH / 2;
    const halfHeight = HEIGHT / 2;
    const halfRenderer = createRenderer(halfWidth, halfHeight);
    const halfTarget = createFrameBuffer(halfWidth, halfHeight);
    await halfRenderer.renderFrame(timeline, 0, halfTarget, { scale: 0.5 });

    const bg: [number, number, number] = [0, 0, 0];
    const fullBox = nonBackgroundBBox(fullTarget, bg);
    const halfBox = nonBackgroundBBox(halfTarget, bg);

    expect(fullBox).not.toBeNull();
    expect(halfBox).not.toBeNull();

    const fullW = fullBox!.maxX - fullBox!.minX;
    const fullH = fullBox!.maxY - fullBox!.minY;
    const halfW = halfBox!.maxX - halfBox!.minX;
    const halfH = halfBox!.maxY - halfBox!.minY;

    // Coarse geometric check (not pixel-exact): the half-resolution render's bounding box
    // should be roughly half the full-resolution one in both dimensions.
    const tolerance = 0.15;
    expect(halfW / fullW).toBeGreaterThan(0.5 - tolerance);
    expect(halfW / fullW).toBeLessThan(0.5 + tolerance);
    expect(halfH / fullH).toBeGreaterThan(0.5 - tolerance);
    expect(halfH / fullH).toBeLessThan(0.5 + tolerance);
  });
});

describe("Renderer — dispose (AC9)", () => {
  it("resets stats to zero on dispose and still renders correctly afterward, without throwing", async () => {
    const timeline = compile(textSpec());
    const renderer = createRenderer(WIDTH, HEIGHT);
    const target = createFrameBuffer(WIDTH, HEIGHT);

    await renderer.renderFrame(timeline, 0, target);
    expect(renderer.stats().cacheMisses).toBeGreaterThan(0);

    renderer.dispose();
    const resetStats = renderer.stats();
    expect(resetStats.cacheHits).toBe(0);
    expect(resetStats.cacheMisses).toBe(0);

    // Documented dispose contract (index.ts): a subsequent renderFrame call still works —
    // it just repaints everything into an empty cache. It must not throw.
    await expect(renderer.renderFrame(timeline, 0, target)).resolves.toBeUndefined();
    expect(renderer.stats().cacheMisses).toBeGreaterThan(0);
  });
});
