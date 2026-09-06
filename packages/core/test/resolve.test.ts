import { describe, expect, it } from "vitest";
import { resolveAxis, resolveSceneBackground } from "../src/resolve.js";

describe("resolveAxis", () => {
  it("resolves \"center\" to half the dimension", () => {
    expect(resolveAxis("center", 1920)).toBe(960);
  });

  it("resolves undefined to half the dimension (defaults to centered)", () => {
    expect(resolveAxis(undefined, 1080)).toBe(540);
  });

  it("resolves a percentage string against the dimension", () => {
    expect(resolveAxis("50%", 1920)).toBe(960);
    expect(resolveAxis("25%", 1080)).toBe(270);
  });

  it("passes a plain number through unchanged", () => {
    expect(resolveAxis(42, 1920)).toBe(42);
  });
});

describe("resolveSceneBackground", () => {
  it("prefers the scene's own background", () => {
    expect(resolveSceneBackground("#111", "#000")).toBe("#111");
  });

  it("falls back to the spec-level background", () => {
    expect(resolveSceneBackground(undefined, "#000")).toBe("#000");
  });
});
