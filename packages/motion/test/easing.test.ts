import { describe, expect, it } from "vitest";
import { linear, easeOutCubic } from "@claudevid/core";
import { resolveEasing, bakeSpring, MotionConfigError } from "../src/easing.js";

describe("resolveEasing (FR5 — delegates to core, no duplicated math)", () => {
  it("resolves named easings to core's own exported functions", () => {
    expect(resolveEasing("linear")).toBe(linear);
    expect(resolveEasing("ease-out-cubic")).toBe(easeOutCubic);
  });

  it("parses cubic-bezier(...) into a working easing function", () => {
    const fn = resolveEasing("cubic-bezier(0.25,0.1,0.25,1)");
    expect(fn(0)).toBeCloseTo(0);
    expect(fn(1)).toBeCloseTo(1);
  });

  it("parses steps(n, jump) into a working easing function", () => {
    const fn = resolveEasing("steps(4, end)");
    expect(fn(0)).toBe(0);
    expect(fn(1)).toBe(1);
  });

  it("throws MotionConfigError for an unknown name — never a silent fallback", () => {
    expect(() => resolveEasing("not-a-real-easing")).toThrow(MotionConfigError);
  });
});

describe("bakeSpring (AC3/AC4, FR4)", () => {
  it("settles to ~1 within a finite frame count for typical params", () => {
    const { frames, settled } = bakeSpring({ stiffness: 170, damping: 26, mass: 1 }, 30);
    expect(settled).toBe(true);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[frames.length - 1]).toBeCloseTo(1, 2);
  });

  it("reports unsettled (not a silent truncation) for a pathologically low damping", () => {
    const { settled, frames } = bakeSpring({ stiffness: 1, damping: 0.001, mass: 1 }, 30);
    expect(settled).toBe(false);
    expect(frames.length).toBe(Math.round(30 * 5));
  });

  it("rejects out-of-range spring parameters instead of clamping them", () => {
    expect(() => bakeSpring({ stiffness: 0, damping: 10, mass: 1 }, 30)).toThrow(MotionConfigError);
    expect(() => bakeSpring({ stiffness: 10, damping: 200, mass: 1 }, 30)).toThrow(MotionConfigError);
    expect(() => bakeSpring({ stiffness: 10, damping: 10, mass: 0 }, 30)).toThrow(MotionConfigError);
  });
});
