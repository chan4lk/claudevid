import { describe, expect, it } from "vitest";
import { resolvePreset, exportCatalogue } from "../src/presets.js";
import { evaluate } from "../src/track.js";
import { resolveEasing } from "../src/easing.js";
import type { ResolvedTrack, Track } from "../src/track.js";

const FPS = 30;

function toResolved(tracks: Track[]): ResolvedTrack[] {
  return tracks.map((t) => ({
    property: t.property,
    from: t.from,
    to: t.to,
    delayFrames: Math.round((t.delay ?? 0) * FPS),
    durationFrames: Math.round(t.duration * FPS),
    easingFn: resolveEasing(t.easing as string),
  }));
}

describe("presets (AC1)", () => {
  it("fade-up starts at opacity 0 / y +distance and ends at opacity 1 / y 0", () => {
    const resolved = toResolved(resolvePreset("fade-up")!);
    const start = evaluate(resolved, 0, 0);
    expect(start.opacity).toBeCloseTo(0);
    expect(start.y).toBeCloseTo(48);

    const end = evaluate(resolved, resolved[0]!.durationFrames, 0);
    expect(end.opacity).toBeCloseTo(1);
    expect(end.y).toBeCloseTo(0);
  });

  it("pop scales from 0 to 1 on both axes", () => {
    const resolved = toResolved(resolvePreset("pop")!);
    const start = evaluate(resolved, 0, 0);
    expect(start.scaleX).toBeCloseTo(0);
    expect(start.scaleY).toBeCloseTo(0);
    const end = evaluate(resolved, resolved[0]!.durationFrames, 0);
    expect(end.scaleX).toBeCloseTo(1);
    expect(end.scaleY).toBeCloseTo(1);
  });

  it("returns undefined for an unknown preset name", () => {
    expect(resolvePreset("not-a-real-preset")).toBeUndefined();
  });

  it("every shipped preset resolves to tracks touching only v1 free channels", () => {
    const FREE = new Set(["opacity", "x", "y", "scaleX", "scaleY", "rotation"]);
    for (const entry of exportCatalogue()) {
      for (const t of resolvePreset(entry.name)!) expect(FREE.has(t.property)).toBe(true);
    }
  });

  it("accepts a duration override that applies to every track in the preset", () => {
    const tracks = resolvePreset("fade-up", { duration: 1.2 })!;
    for (const t of tracks) expect(t.duration).toBe(1.2);
  });
});
