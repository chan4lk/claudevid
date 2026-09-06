import { describe, expect, it } from "vitest";
import { compileTimeline, MissingAudioDurationError } from "../src/timeline.js";
import type { VideoSpec } from "../src/types.js";

function makeSpec(overrides: Partial<VideoSpec> = {}): VideoSpec {
  return {
    version: 1,
    width: 1920,
    height: 1080,
    fps: 30,
    scenes: [],
    ...overrides,
  };
}

describe("compileTimeline — golden frame windows (AC4)", () => {
  it("produces contiguous, correctly-rounded frame windows for fractional durations", () => {
    const spec = makeSpec({
      scenes: [
        { id: "a", duration: 2.5, layers: [] },
        { id: "b", duration: 3.333, layers: [] },
        { id: "c", duration: 1.0, layers: [] },
      ],
    });

    const timeline = compileTimeline(spec);

    expect(timeline.sceneWindows).toEqual([
      { sceneId: "a", startFrame: 0, endFrame: 75 },
      { sceneId: "b", startFrame: 75, endFrame: 175 },
      { sceneId: "c", startFrame: 175, endFrame: 205 },
    ]);
    expect(timeline.frameCount).toBe(205);

    for (let i = 1; i < timeline.sceneWindows.length; i++) {
      expect(timeline.sceneWindows[i]!.startFrame).toBe(timeline.sceneWindows[i - 1]!.endFrame);
    }
  });
});

describe("compileTimeline — no drift over many scenes (AC5)", () => {
  it("accumulates exact integer frame counts across a 1-hour, 3600-scene timeline", () => {
    const scenes = Array.from({ length: 3600 }, (_, i) => ({
      id: `s${i}`,
      duration: 1,
      layers: [],
    }));
    const spec = makeSpec({ fps: 24, scenes });

    const timeline = compileTimeline(spec);

    expect(timeline.sceneWindows).toHaveLength(3600);
    expect(timeline.frameCount).toBe(3600 * 24);
    expect(timeline.sceneWindows[3599]!.endFrame).toBe(86400);
  });
});

describe("compileTimeline — duration: \"auto\" (AC6, AC7)", () => {
  it("throws MissingAudioDurationError when no audioDurations entry matches", () => {
    const spec = makeSpec({
      scenes: [{ id: "voiceover", duration: "auto", layers: [] }],
    });

    expect(() => compileTimeline(spec)).toThrowError(MissingAudioDurationError);
    try {
      compileTimeline(spec);
    } catch (error) {
      expect(error).toBeInstanceOf(MissingAudioDurationError);
      expect((error as MissingAudioDurationError).sceneId).toBe("voiceover");
    }
  });

  it("sizes the frame window from the audioDurations entry, not a default", () => {
    const spec = makeSpec({
      fps: 30,
      scenes: [{ id: "voiceover", duration: "auto", layers: [] }],
    });

    const timeline = compileTimeline(spec, { audioDurations: { voiceover: 4.2 } });

    expect(timeline.sceneWindows[0]).toEqual({ sceneId: "voiceover", startFrame: 0, endFrame: 126 });
  });
});

describe("compileTimeline — activeAt (AC8)", () => {
  it("returns exactly the layers whose resolved window contains the frame", () => {
    const spec = makeSpec({
      fps: 30,
      scenes: [
        {
          id: "scene-1",
          duration: 5,
          layers: [
            { type: "text", text: "always on" },
            { type: "text", text: "first half only", start: 0, duration: 2 },
            { type: "text", text: "second half only", start: 2, duration: 3 },
          ],
        },
      ],
    });

    const timeline = compileTimeline(spec);

    const atFrame10 = timeline.activeAt(10).map((l) => l.layer.type === "text" ? l.layer.text : undefined);
    expect(atFrame10).toContain("always on");
    expect(atFrame10).toContain("first half only");
    expect(atFrame10).not.toContain("second half only");

    const atFrame100 = timeline.activeAt(100).map((l) => l.layer.type === "text" ? l.layer.text : undefined);
    expect(atFrame100).toContain("always on");
    expect(atFrame100).toContain("second half only");
    expect(atFrame100).not.toContain("first half only");
  });

  it("returns no layers for a frame outside every scene window", () => {
    const spec = makeSpec({
      scenes: [{ id: "only", duration: 1, layers: [{ type: "text", text: "hi" }] }],
    });
    const timeline = compileTimeline(spec);
    expect(timeline.activeAt(timeline.frameCount + 10)).toEqual([]);
  });
});

describe("compileTimeline — edge cases", () => {
  it("compiles a zero-length scene to a zero-length frame window without throwing", () => {
    const spec = makeSpec({
      scenes: [
        { id: "zero", duration: 0, layers: [{ type: "text", text: "never shown" }] },
        { id: "after", duration: 1, layers: [] },
      ],
    });

    const timeline = compileTimeline(spec);

    expect(timeline.sceneWindows[0]).toEqual({ sceneId: "zero", startFrame: 0, endFrame: 0 });
    expect(timeline.activeAt(0)).toEqual([]);
  });

  it("keeps frame offsets monotonically non-decreasing for an fps that doesn't divide evenly", () => {
    const scenes = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, duration: 1, layers: [] }));
    const spec = makeSpec({ fps: 23.976, scenes });

    const timeline = compileTimeline(spec);

    for (let i = 1; i < timeline.sceneWindows.length; i++) {
      expect(timeline.sceneWindows[i]!.startFrame).toBeGreaterThanOrEqual(timeline.sceneWindows[i - 1]!.startFrame);
    }
    expect(timeline.frameCount).toBeGreaterThan(0);
  });
});
