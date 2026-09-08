import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { parseSpec, compileTimeline } from "@claudevid/core";
import type { TextLayer, Timeline } from "@claudevid/core";
import { createRenderer, createFrameBuffer } from "../src/index.js";
import type { FrameBuffer, MotionResolver } from "../src/index.js";
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

// Change 003 (motion) integration — a fake `MotionResolver` (structural, no dependency on
// @claudevid/motion) exercising the renderer-side wiring only: FR15's transform bracket,
// FR16's hold-frame bypass, and the transition two-pass paint (design.md Key Decision D5).
function fakeResolver(byKey: Record<string, ReturnType<MotionResolver["resolve"]>>): MotionResolver {
  return { resolve: (layerKey) => byKey[layerKey] };
}

describe("Renderer — motion resolver applies opacity (AC8)", () => {
  it("a resolved opacity visibly changes the painted pixels vs. no resolver", async () => {
    const timeline = compile(rectSpec());
    const rectLayer = timeline.layers.find((l) => l.type === "rect")!;
    const centerX = rectLayer.x + 200;
    const centerY = rectLayer.y + 150;

    const rendererFull = createRenderer(WIDTH, HEIGHT);
    const targetFull = createFrameBuffer(WIDTH, HEIGHT);
    await rendererFull.renderFrame(timeline, 0, targetFull);

    const rendererDim = createRenderer(WIDTH, HEIGHT);
    const targetDim = createFrameBuffer(WIDTH, HEIGHT);
    const motion = fakeResolver({ [rectLayer.layerKey]: { opacity: 0.3 } });
    await rendererDim.renderFrame(timeline, 0, targetDim, { motion });

    const idx = (centerY * WIDTH + centerX) * 4;
    const fullRed = targetFull.data[idx]!;
    const dimRed = targetDim.data[idx]!;

    expect(fullRed).toBe(255); // opaque red rect, no resolver
    expect(dimRed).toBeGreaterThan(0); // still partially visible
    expect(dimRed).toBeLessThan(fullRed); // measurably dimmer — opacity was applied
  });
});

describe("Renderer — motion resolver bypasses hold-frame reuse (AC9)", () => {
  it("does not reuse the previous frame when a resolved PropertyBag differs between frames", async () => {
    const timeline = compile(textSpec());
    const textLayer = timeline.layers.find((l) => l.type === "text")!;
    const renderer = createRenderer(WIDTH, HEIGHT);
    const frameA = createFrameBuffer(WIDTH, HEIGHT);
    const frameB = createFrameBuffer(WIDTH, HEIGHT);

    // Same activeAt() layer-key set at frames 10/11 (identical to the plain hold-frame test
    // above) — the only difference is a motion resolver reporting a different opacity per
    // frame, which must defeat the fast path 002 built for the no-motion case.
    const motion: MotionResolver = {
      resolve: (layerKey, frame) => (layerKey === textLayer.layerKey ? { opacity: frame === 10 ? 0.2 : 0.8 } : undefined),
    };

    await renderer.renderFrame(timeline, 10, frameA, { motion });
    await renderer.renderFrame(timeline, 11, frameB, { motion });

    expect(renderer.stats().holdFrames).toBe(0);
    expect(Buffer.compare(frameA.data, frameB.data)).not.toBe(0);
  });
});

describe("Renderer — cross-fade scene transition (change 003)", () => {
  it("blends both scenes' non-background pixels inside the transition's overlap window", async () => {
    const spec = {
      version: 1 as const,
      width: WIDTH,
      height: HEIGHT,
      fps: 30,
      scenes: [
        {
          id: "a",
          duration: 2,
          layers: [{ type: "rect" as const, x: 100, y: 100, width: 200, height: 200, fill: "#ff0000" }],
        },
        {
          id: "b",
          duration: 2,
          transition: { kind: "cross-fade" as const, duration: 0.5 },
          layers: [{ type: "rect" as const, x: 800, y: 100, width: 200, height: 200, fill: "#0000ff" }],
        },
      ],
    };
    const timeline = compile(spec);
    const overlapStart = timeline.sceneWindows[1]!.startFrame;
    const overlapFrames = timeline.sceneWindows[1]!.transitionInFrames;
    expect(overlapFrames).toBeGreaterThan(0);

    const renderer = createRenderer(WIDTH, HEIGHT);
    const target = createFrameBuffer(WIDTH, HEIGHT);
    await renderer.renderFrame(timeline, overlapStart + Math.floor(overlapFrames / 2), target);

    const redIdx = (200 * WIDTH + 200) * 4;
    const blueIdx = (200 * WIDTH + 900) * 4;

    // Both scenes' rects show non-background color mid-transition — the outgoing scene's
    // red rect hasn't vanished, and the incoming scene's blue rect has already appeared.
    expect(target.data[redIdx]).toBeGreaterThan(0);
    expect(target.data[blueIdx + 2]).toBeGreaterThan(0);
  });
});

// Change 009 — `align` anchors a text layer's box *placement*, not just intra-box line
// justification. Tolerance accounts for glyph side-bearing/anti-aliasing at the bitmap's edges,
// not for any imprecision in the anchor math itself (mirrors this file's existing 15%-tolerance
// precedent for AC6's geometric scaling check).
describe("Renderer — text layer align anchors placement (change 009)", () => {
  const ANCHOR_TOLERANCE_PX = 12;

  function alignedTextSpec(x: number | "center", align: "left" | "center" | "right") {
    return {
      version: 1 as const,
      width: WIDTH,
      height: HEIGHT,
      fps: 30,
      scenes: [
        {
          id: "s1",
          duration: 1,
          layers: [{ type: "text" as const, text: "Center Me", x, y: 400, fontSize: 80, color: "#ffffff", align }],
        },
      ],
    };
  }

  it("AC1: align 'center' with a numeric x centers the bitmap on x", async () => {
    const timeline = compile(alignedTextSpec(700, "center"));
    const renderer = createRenderer(WIDTH, HEIGHT);
    const target = createFrameBuffer(WIDTH, HEIGHT);
    await renderer.renderFrame(timeline, 0, target);

    const box = nonBackgroundBBox(target, [0, 0, 0]);
    expect(box).not.toBeNull();
    expect(Math.abs((box!.minX + box!.maxX) / 2 - 700)).toBeLessThan(ANCHOR_TOLERANCE_PX);
  });

  it("AC2: align 'center' with x: 'center' centers the bitmap on the canvas midpoint", async () => {
    const timeline = compile(alignedTextSpec("center", "center"));
    const renderer = createRenderer(WIDTH, HEIGHT);
    const target = createFrameBuffer(WIDTH, HEIGHT);
    await renderer.renderFrame(timeline, 0, target);

    const box = nonBackgroundBBox(target, [0, 0, 0]);
    expect(box).not.toBeNull();
    expect(Math.abs((box!.minX + box!.maxX) / 2 - WIDTH / 2)).toBeLessThan(ANCHOR_TOLERANCE_PX);
  });

  it("AC3: align 'right' with a numeric x places the bitmap's right edge at x", async () => {
    const timeline = compile(alignedTextSpec(1200, "right"));
    const renderer = createRenderer(WIDTH, HEIGHT);
    const target = createFrameBuffer(WIDTH, HEIGHT);
    await renderer.renderFrame(timeline, 0, target);

    const box = nonBackgroundBBox(target, [0, 0, 0]);
    expect(box).not.toBeNull();
    expect(Math.abs(box!.maxX - 1200)).toBeLessThan(ANCHOR_TOLERANCE_PX);
  });

  it("AC4: align 'left' (default) keeps x as the bitmap's left edge, unchanged", async () => {
    const timeline = compile(alignedTextSpec(300, "left"));
    const renderer = createRenderer(WIDTH, HEIGHT);
    const target = createFrameBuffer(WIDTH, HEIGHT);
    await renderer.renderFrame(timeline, 0, target);

    const box = nonBackgroundBBox(target, [0, 0, 0]);
    expect(box).not.toBeNull();
    expect(Math.abs(box!.minX - 300)).toBeLessThan(ANCHOR_TOLERANCE_PX);
  });

  it("AC5: the 'center' anchor also applies on the motion (applyMotionTransform) path", async () => {
    const timeline = compile(alignedTextSpec(700, "center"));
    const textLayer = timeline.layers.find((l) => l.type === "text")!;
    const renderer = createRenderer(WIDTH, HEIGHT);
    const target = createFrameBuffer(WIDTH, HEIGHT);
    // Identity PropertyBag: exercises the applyMotionTransform branch without itself moving
    // anything, isolating "does the align anchor still apply under motion" from "does motion
    // math work at all" (already covered by the AC8/AC9 motion tests above).
    const motion: MotionResolver = {
      resolve: (layerKey) =>
        layerKey === textLayer.layerKey ? { opacity: 1, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } : undefined,
    };
    await renderer.renderFrame(timeline, 0, target, { motion });

    const box = nonBackgroundBBox(target, [0, 0, 0]);
    expect(box).not.toBeNull();
    expect(Math.abs((box!.minX + box!.maxX) / 2 - 700)).toBeLessThan(ANCHOR_TOLERANCE_PX);
  });
});
