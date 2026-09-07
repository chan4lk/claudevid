import { describe, expect, it, vi } from "vitest";
import type { Timeline, TimelineLayer } from "@claudevid/core";
import { createFrameBuffer, createRenderer, getPainter, registerPainter } from "../src/index.js";

// registry get/set + unknown-type no-op (design.md 004 Key Decision D3, tasks.md T6/T14).

describe("painters registry — registerPainter / getPainter", () => {
  it("round-trips a registered painter for its type", () => {
    const paint = vi.fn();
    registerPainter("__test-widget-a__", paint);

    expect(getPainter("__test-widget-a__")).toBe(paint);
  });

  it("returns undefined for a type nothing has registered", () => {
    expect(getPainter("__test-never-registered__")).toBeUndefined();
  });

  it("a second registration for the same type overwrites the first (last write wins)", () => {
    const first = vi.fn();
    const second = vi.fn();
    registerPainter("__test-widget-b__", first);
    registerPainter("__test-widget-b__", second);

    expect(getPainter("__test-widget-b__")).toBe(second);
  });
});

const WIDTH = 64;
const HEIGHT = 64;

function fakeTimeline(layers: TimelineLayer[]): Timeline {
  return {
    frameCount: 30,
    sceneWindows: [],
    layers,
    activeAt: () => layers,
    transitionAt: () => null,
  };
}

function fakeLayer(type: string, extra: Record<string, unknown> = {}): TimelineLayer {
  return {
    layerKey: `scene-1/${type}`,
    sceneId: "scene-1",
    type,
    startFrame: 0,
    endFrame: 30,
    x: 10,
    y: 20,
    // `layer.type` is a runtime string not present in core's closed `Layer` union for a
    // registered-only type — same structural gap `registerLayer`'s own design accepts
    // (design.md 004 "TimelineLayer.layer narrowing").
    layer: { type, ...extra } as unknown as TimelineLayer["layer"],
  };
}

describe("renderer-canvas index.ts — default switch branch consults getPainter()", () => {
  it("calls a registered painter with (entry, timelineLayer, frame, ctx) and it actually draws", async () => {
    registerPainter("__render-test-fill__", (entry, timelineLayer, frame, ctx) => {
      expect(entry).toEqual({ type: "__render-test-fill__" });
      expect(timelineLayer.layerKey).toBe("scene-1/__render-test-fill__");
      expect(frame).toBe(7);
      ctx.fillStyle = "#00ff00";
      ctx.fillRect(0, 0, 10, 10);
    });

    const renderer = createRenderer(WIDTH, HEIGHT);
    const timeline = fakeTimeline([fakeLayer("__render-test-fill__")]);
    const target = createFrameBuffer(WIDTH, HEIGHT);

    await renderer.renderFrame(timeline, 7, target);

    // The painter drew a 10x10 green square whose top-left corner is the layer's (x, y) =
    // (10, 20) — confirms the switch branch translated ctx to the layer's anchor before
    // handing it to the painter, same as the built-in branches translate before drawImage.
    const idx = (20 * WIDTH + 10) * 4;
    expect([target.data[idx], target.data[idx + 1], target.data[idx + 2]]).toEqual([0, 255, 0]);

    const stats = renderer.stats();
    expect(stats.perLayerTypeMs["__render-test-fill__"]).toBeGreaterThanOrEqual(0);
  });

  it("still silently skips a layer type with no registered painter (regression: same as the pre-existing group/unknown-type behavior)", async () => {
    const renderer = createRenderer(WIDTH, HEIGHT);
    const timeline = fakeTimeline([fakeLayer("__never-registered-type__")]);
    const target = createFrameBuffer(WIDTH, HEIGHT);

    await expect(renderer.renderFrame(timeline, 0, target)).resolves.toBeUndefined();

    // Nothing painted at the layer's anchor beyond the opaque black background.
    const idx = (20 * WIDTH + 10) * 4;
    expect([target.data[idx], target.data[idx + 1], target.data[idx + 2]]).toEqual([0, 0, 0]);
  });
});
