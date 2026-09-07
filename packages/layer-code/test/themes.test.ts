import { describe, expect, it } from "vitest";
import { BUNDLED_THEMES, checkThemeContrast, contrastRatio } from "../src/themes.js";

describe("BUNDLED_THEMES (spec.md FR2)", () => {
  it("is exactly the 3 bundled theme ids, sourced from schema.ts (single source of truth)", () => {
    expect(BUNDLED_THEMES).toEqual(["github-dark", "github-light", "high-contrast"]);
  });
});

describe("contrastRatio (WCAG 2.1 relative-luminance contrast ratio)", () => {
  it("is 21 for black vs. white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });

  it("is 1 for identical colours", () => {
    expect(contrastRatio("#336699", "#336699")).toBeCloseTo(1, 5);
  });

  it("is symmetric regardless of argument order", () => {
    expect(contrastRatio("#123456", "#abcdef")).toBeCloseTo(contrastRatio("#abcdef", "#123456"), 10);
  });

  it("supports 3-digit shorthand hex (e.g. github-light's #fff background)", () => {
    expect(contrastRatio("#fff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#000", "#000000")).toBeCloseTo(1, 5);
  });
});

describe("checkThemeContrast (spec.md FR15 / AC12)", () => {
  it("returns a non-empty { colorHex, ratio } entry per distinct token colour, for every bundled theme", () => {
    for (const theme of BUNDLED_THEMES) {
      const entries = checkThemeContrast(theme);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.colorHex).toMatch(/^#[0-9a-f]{3,6}$/i);
        expect(Number.isFinite(entry.ratio)).toBe(true);
        expect(entry.ratio).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("AC12 — zero entries below the 3.0 large-text WCAG AA threshold, for each of the 3 bundled themes", () => {
    for (const theme of BUNDLED_THEMES) {
      const failing = checkThemeContrast(theme).filter((entry) => entry.ratio < 3.0);
      expect(failing).toEqual([]);
    }
  });

  it("colours within one theme are unique (no duplicate token-colour entries)", () => {
    for (const theme of BUNDLED_THEMES) {
      const hexes = checkThemeContrast(theme).map((entry) => entry.colorHex);
      expect(new Set(hexes).size).toBe(hexes.length);
    }
  });
});
