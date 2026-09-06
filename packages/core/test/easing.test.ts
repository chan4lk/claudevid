import { describe, expect, it } from "vitest";
import { cubicBezier, easeInOutQuad, linear, steps } from "../src/easing.js";

describe("easing catalogue", () => {
  it("linear is the identity function", () => {
    expect(linear(0)).toBe(0);
    expect(linear(0.5)).toBe(0.5);
    expect(linear(1)).toBe(1);
  });

  it("easeInOutQuad passes through the midpoint", () => {
    expect(easeInOutQuad(0)).toBe(0);
    expect(easeInOutQuad(0.5)).toBeCloseTo(0.5, 5);
    expect(easeInOutQuad(1)).toBe(1);
  });

  it("cubicBezier(0,0,1,1) behaves like linear (CSS 'linear' control points)", () => {
    const ease = cubicBezier(0, 0, 1, 1);
    expect(ease(0)).toBeCloseTo(0, 3);
    expect(ease(0.25)).toBeCloseTo(0.25, 2);
    expect(ease(0.5)).toBeCloseTo(0.5, 2);
    expect(ease(1)).toBeCloseTo(1, 3);
  });

  it("steps(4, 'end') holds each of 4 discrete levels", () => {
    const step = steps(4, "end");
    expect(step(0)).toBe(0);
    expect(step(0.24)).toBe(0);
    expect(step(0.26)).toBeCloseTo(0.25, 5);
    expect(step(0.99)).toBeCloseTo(0.75, 5);
    expect(step(1)).toBe(1);
  });
});
