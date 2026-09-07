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
      { sceneId: "a", startFrame: 0, endFrame: 75, transitionInFrames: 0 },
      { sceneId: "b", startFrame: 75, endFrame: 175, transitionInFrames: 0 },
      { sceneId: "c", startFrame: 175, endFrame: 205, transitionInFrames: 0 },
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

    expect(timeline.sceneWindows[0]).toEqual({ sceneId: "voiceover", startFrame: 0, endFrame: 126, transitionInFrames: 0 });
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

    expect(timeline.sceneWindows[0]).toEqual({ sceneId: "zero", startFrame: 0, endFrame: 0, transitionInFrames: 0 });
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

describe("compileTimeline — scene transitions (change 003, AC7)", () => {
  it("a cross-fade overlaps scene durations: 3s + 3s with a 0.5s cross-fade totals 5.5s, not 6.5s", () => {
    const spec = makeSpec({
      fps: 30,
      scenes: [
        { id: "a", duration: 3, layers: [] },
        { id: "b", duration: 3, layers: [], transition: { kind: "cross-fade", duration: 0.5 } },
      ],
    });

    const timeline = compileTimeline(spec);

    expect(timeline.frameCount).toBe(Math.round(5.5 * 30));
    expect(timeline.sceneWindows[1]!.transitionInFrames).toBe(15);
    expect(timeline.sceneWindows[1]!.startFrame).toBe(timeline.sceneWindows[0]!.endFrame - 15);
  });

  it("kind: 'cut' (default, no transition field) reproduces byte-identical output to pre-change behavior", () => {
    const scenesNoTransition = [
      { id: "a", duration: 2.5, layers: [] },
      { id: "b", duration: 3.333, layers: [] },
      { id: "c", duration: 1.0, layers: [] },
    ];
    const scenesExplicitCut = scenesNoTransition.map((s) => ({ ...s, transition: { kind: "cut" as const, duration: 0 } }));

    const withoutField = compileTimeline(makeSpec({ scenes: scenesNoTransition }));
    const withExplicitCut = compileTimeline(makeSpec({ scenes: scenesExplicitCut }));

    expect(withoutField.frameCount).toBe(205);
    expect(withoutField.sceneWindows).toEqual([
      { sceneId: "a", startFrame: 0, endFrame: 75, transitionInFrames: 0 },
      { sceneId: "b", startFrame: 75, endFrame: 175, transitionInFrames: 0 },
      { sceneId: "c", startFrame: 175, endFrame: 205, transitionInFrames: 0 },
    ]);
    expect(withExplicitCut.frameCount).toBe(withoutField.frameCount);
    expect(withExplicitCut.sceneWindows).toEqual(withoutField.sceneWindows);
  });

  it("clamps a transition longer than either neighbour's own duration instead of producing a negative-length scene", () => {
    const spec = makeSpec({
      fps: 30,
      scenes: [
        { id: "a", duration: 1, layers: [] }, // 30 frames
        { id: "b", duration: 0.2, layers: [], transition: { kind: "cross-fade", duration: 10 } }, // 6 frames
      ],
    });

    const timeline = compileTimeline(spec);

    // min(requested=300, prevFrames-1=29, sceneFrames-1=5) = 5
    expect(timeline.sceneWindows[1]!.transitionInFrames).toBe(5);
    expect(timeline.sceneWindows[1]!.endFrame).toBeGreaterThan(timeline.sceneWindows[1]!.startFrame);
    expect(timeline.sceneWindows[0]!.endFrame).toBeGreaterThan(timeline.sceneWindows[0]!.startFrame);
  });

  it("transitionAt returns null outside any overlap window", () => {
    const spec = makeSpec({
      fps: 30,
      scenes: [
        { id: "a", duration: 3, layers: [{ type: "text", text: "A" }] },
        { id: "b", duration: 3, layers: [{ type: "text", text: "B" }], transition: { kind: "cross-fade", duration: 0.5 } },
      ],
    });

    const timeline = compileTimeline(spec);

    expect(timeline.transitionAt(0)).toBeNull();
    expect(timeline.transitionAt(timeline.sceneWindows[1]!.endFrame - 1)).toBeNull();
  });

  it("transitionAt returns both scenes' layers and a progressing t inside the overlap window", () => {
    const spec = makeSpec({
      fps: 30,
      scenes: [
        { id: "a", duration: 3, layers: [{ type: "text", text: "A" }] },
        { id: "b", duration: 3, layers: [{ type: "text", text: "B" }], transition: { kind: "cross-fade", duration: 0.5 } },
      ],
    });

    const timeline = compileTimeline(spec);
    const overlapStart = timeline.sceneWindows[1]!.startFrame;
    const overlapFrames = timeline.sceneWindows[1]!.transitionInFrames;

    const first = timeline.transitionAt(overlapStart);
    expect(first).not.toBeNull();
    expect(first!.t).toBe(0);
    expect(first!.outgoing.some((l) => l.sceneId === "a")).toBe(true);
    expect(first!.incoming.some((l) => l.sceneId === "b")).toBe(true);

    const last = timeline.transitionAt(overlapStart + overlapFrames - 1);
    expect(last!.t).toBeGreaterThan(0);
    expect(last!.t).toBeLessThan(1);
  });
});
