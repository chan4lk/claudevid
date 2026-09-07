import { describe, expect, it } from "vitest";
import { evaluate } from "../src/track.js";
import type { ResolvedTrack } from "../src/track.js";

function linearTrack(overrides: Partial<ResolvedTrack> = {}): ResolvedTrack {
  return {
    property: "opacity",
    from: 0,
    to: 1,
    delayFrames: 0,
    durationFrames: 10,
    easingFn: (t: number) => t,
    ...overrides,
  };
}

describe("evaluate", () => {
  it("returns the from value at the start of the track", () => {
    expect(evaluate([linearTrack()], 0, 0).opacity).toBeCloseTo(0);
  });

  it("returns the to value once the track's duration has elapsed", () => {
    expect(evaluate([linearTrack()], 10, 0).opacity).toBeCloseTo(1);
  });

  it("clamps to the to value past the track's duration (no overshoot)", () => {
    expect(evaluate([linearTrack()], 1000, 0).opacity).toBeCloseTo(1);
  });

  it("interpolates linearly mid-track", () => {
    expect(evaluate([linearTrack()], 5, 0).opacity).toBeCloseTo(0.5);
  });

  it("holds the from value before delay elapses", () => {
    expect(evaluate([linearTrack({ delayFrames: 5 })], 2, 0).opacity).toBeCloseTo(0);
  });

  it("is offset correctly by a non-zero trackStartFrame", () => {
    expect(evaluate([linearTrack()], 105, 100).opacity).toBeCloseTo(0.5);
  });

  it("is pure: identical inputs produce deep-equal output (AC2)", () => {
    const tracks = [linearTrack()];
    expect(evaluate(tracks, 5, 0)).toEqual(evaluate(tracks, 5, 0));
  });

  it("clamps to the last baked frame past a spring track's end (FR4)", () => {
    const track = linearTrack({ easingFn: undefined, bakedFrames: [0, 0.5, 0.9, 1.0] });
    expect(evaluate([track], 100, 0).opacity).toBeCloseTo(1.0);
  });

  it("resolves each track to its own property key", () => {
    const bag = evaluate(
      [linearTrack({ property: "opacity" }), linearTrack({ property: "y", from: 48, to: 0 })],
      5,
      0
    );
    expect(bag.opacity).toBeCloseTo(0.5);
    expect(bag.y).toBeCloseTo(24);
  });
});
