// Minimal sanity coverage for T5's own builders (this module compiles and produces the shapes
// its later consumers expect). Full, exhaustive AC-mapped coverage (AC5/AC6, Edge Cases'
// out-of-range focus/scroll/annotation lines) is T12's job per design.md's Architecture.
import { describe, expect, it } from "vitest";
import { layoutCode } from "../src/layout.js";
import {
  annotationLineOutOfRangeDiagnostic,
  checkLayoutDiagnostics,
  focusLinesOutOfRangeDiagnostic,
  lineOverflowDiagnostic,
  lineTooLongDiagnostic,
  scrollToLineOutOfRangeDiagnostic,
  unsupportedLangDiagnostic,
  unsupportedThemeDiagnostic,
} from "../src/diagnostics.js";

describe("unsupportedLangDiagnostic / unsupportedThemeDiagnostic (FR2/FR13, AC3)", () => {
  it("lists all 8 bundled langs by name", () => {
    const d = unsupportedLangDiagnostic("scenes/0/layers/0", "cobol");
    expect(d.path).toBe("/scenes/0/layers/0/lang");
    expect(d.message).toMatch(/cobol/);
    for (const lang of ["typescript", "javascript", "tsx", "jsx", "python", "bash", "json", "yaml"]) {
      expect(d.suggestion).toMatch(new RegExp(lang));
    }
  });

  it("lists all 3 bundled themes by name", () => {
    const d = unsupportedThemeDiagnostic("scenes/0/layers/0", "solarized");
    expect(d.path).toBe("/scenes/0/layers/0/theme");
    for (const theme of ["github-dark", "github-light", "high-contrast"]) {
      expect(d.suggestion).toMatch(new RegExp(theme));
    }
  });
});

describe("lineOverflowDiagnostic / lineTooLongDiagnostic (FR6)", () => {
  it("names the actual line count and the max that fits, with a 3-option suggestion", () => {
    const d = lineOverflowDiagnostic("scenes/0/layers/0", 40, 20);
    expect(d.message).toMatch(/40/);
    expect(d.message).toMatch(/20/);
    expect(d.suggestion).toMatch(/shorten/);
    expect(d.suggestion).toMatch(/height/);
    expect(d.suggestion).toMatch(/scroll/);
  });

  it("names the longest line's char count and the floored fontSize", () => {
    const d = lineTooLongDiagnostic("scenes/0/layers/0", 500, 12);
    expect(d.message).toMatch(/500/);
    expect(d.message).toMatch(/12/);
  });
});

describe("checkLayoutDiagnostics (FR6/FR7, AC5/AC6)", () => {
  it("blocks and diagnoses a 40-line block sized for 20 with no scroll (AC5)", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `console.log(${i});`);
    const fontSize = 20;
    const lineHeightPx = fontSize * 1.5;
    const height = 20 * lineHeightPx + 76; // + CHROME_VERTICAL_PX, yields availableLines = 20
    const layout = layoutCode(lines, { width: 1600, height, fontSize, wrap: "none" });

    const { diagnostics, blocked } = checkLayoutDiagnostics("scenes/0/layers/0", layout, { hasScroll: false });

    expect(blocked).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(/40/);
    expect(diagnostics[0]?.message).toMatch(/20/);
  });

  it("does not diagnose overflow when a scroll config is present (AC6's exemption)", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `console.log(${i});`);
    const fontSize = 20;
    const lineHeightPx = fontSize * 1.5;
    const height = 20 * lineHeightPx + 76;
    const layout = layoutCode(lines, { width: 1600, height, fontSize, wrap: "none" });

    const { diagnostics, blocked } = checkLayoutDiagnostics("scenes/0/layers/0", layout, { hasScroll: true });

    expect(diagnostics).toEqual([]);
    expect(blocked).toBe(false);
  });

  it("blocks with a line-too-long diagnostic when no fontSize down to the floor fits", () => {
    const longLine = "x".repeat(500);
    const layout = layoutCode([longLine], { width: 300, height: 900, fontSize: 20, wrap: "none" });

    const { diagnostics, blocked } = checkLayoutDiagnostics("scenes/0/layers/0", layout, { hasScroll: false });

    expect(layout.widthFits).toBe(false);
    expect(blocked).toBe(true);
    expect(diagnostics.some((d) => d.message.includes("500"))).toBe(true);
  });

  it("lets an explicit maxLines lower than the height-derived availability win", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i}`);
    const layout = layoutCode(lines, { width: 1600, height: 900, fontSize: 20, wrap: "none" });

    const { diagnostics, blocked } = checkLayoutDiagnostics("scenes/0/layers/0", layout, {
      hasScroll: false,
      maxLines: 3,
    });

    expect(blocked).toBe(true);
    expect(diagnostics[0]?.message).toMatch(/3/);
  });
});

describe("out-of-range line diagnostics (FR12/FR13, Edge Cases)", () => {
  it("focus.lines / scroll.toLine / annotations[].line each get a distinct JSON-pointer path", () => {
    expect(focusLinesOutOfRangeDiagnostic("scenes/0/layers/0", 99, 5).path).toBe("/scenes/0/layers/0/focus/lines");
    expect(scrollToLineOutOfRangeDiagnostic("scenes/0/layers/0", 99, 5).path).toBe(
      "/scenes/0/layers/0/scroll/toLine",
    );
    expect(annotationLineOutOfRangeDiagnostic("scenes/0/layers/0", 2, 99, 5).path).toBe(
      "/scenes/0/layers/0/annotations/2/line",
    );
  });

  it("names the offending line and the valid range in the message", () => {
    const d = focusLinesOutOfRangeDiagnostic("scenes/0/layers/0", 99, 5);
    expect(d.message).toMatch(/99/);
    expect(d.message).toMatch(/1, 5/);
  });
});
