import { describe, expect, it } from "vitest";
import {
  AUTO_FIT_FLOOR_PX,
  computeAvailableLines,
  expandTabs,
  layoutCode,
  measureLine,
  _advanceWidthCacheSizeForTests,
} from "../src/layout.js";

// Minimal sanity coverage for T4's own contracts — full AC-mapped coverage lands in T12's
// dedicated `layout.test.ts` per design.md's Architecture (this file just proves the shapes and
// core guarantees hold before that wave).

describe("measureLine (FR5 / AC4)", () => {
  it("is exactly linear in charCount for a fixed fontSizePx", () => {
    const fontSizePx = 20;
    const unit = measureLine(1, fontSizePx);
    for (const charCount of [1, 10, 80]) {
      expect(Math.abs(measureLine(charCount, fontSizePx) - charCount * unit)).toBeLessThanOrEqual(0.01);
    }
  });

  it("caches the advance width per fontSize instead of recomputing it per call", () => {
    const before = _advanceWidthCacheSizeForTests();
    measureLine(1, 37);
    measureLine(5, 37);
    measureLine(100, 37);
    const after = _advanceWidthCacheSizeForTests();
    expect(after).toBe(before + 1);
  });
});

describe("expandTabs (FR5 / Edge Cases)", () => {
  it("expands each tab to exactly tabSize spaces", () => {
    expect(expandTabs("a\tb", 2)).toBe("a  b");
    expect(expandTabs("\t\tx", 4)).toBe("        x");
  });

  it("is a no-op for lines with no tabs", () => {
    expect(expandTabs("no tabs here", 2)).toBe("no tabs here");
  });
});

describe("computeAvailableLines (FR6 / AC5)", () => {
  it("returns floor((height - chromeVerticalPx) / lineHeightPx), clamped at 0", () => {
    expect(computeAvailableLines(1000, 20, false)).toBeGreaterThan(0);
    expect(computeAvailableLines(1, 20, false)).toBe(0);
  });

  it("grows monotonically with height at a fixed fontSize", () => {
    const small = computeAvailableLines(400, 20, false);
    const large = computeAvailableLines(1200, 20, false);
    expect(large).toBeGreaterThan(small);
  });
});

describe("layoutCode", () => {
  it("returns one LayoutLine per source line, with y offsets increasing by lineHeightPx", () => {
    const lines = ["const a = 1;", "const b = 2;", "const c = 3;"];
    const result = layoutCode(lines, { width: 1600, height: 900, fontSize: 20 });

    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]?.y).toBe(0);
    expect(result.lines[1]?.y).toBeCloseTo((result.lines[0]?.y ?? 0) + result.lineHeightPx);
    expect(result.lines[2]?.y).toBeCloseTo((result.lines[1]?.y ?? 0) + result.lineHeightPx);
    expect(result.lineCharCounts).toEqual(lines.map((l) => l.length));
  });

  it("expands tabs before measuring, matching expandTabs directly", () => {
    const result = layoutCode(["a\tb"], { width: 1600, height: 900, tabSize: 4 });
    expect(result.lines[0]?.charCount).toBe(expandTabs("a\tb", 4).length);
  });

  it("auto-fits fontSize down to the floor when wrap is 'none' and a line is too wide (FR6)", () => {
    const longLine = "x".repeat(500);
    const result = layoutCode([longLine], { width: 300, height: 900, fontSize: 20, wrap: "none" });

    expect(result.fontSize).toBeGreaterThanOrEqual(AUTO_FIT_FLOOR_PX);
    expect(result.fontSize).toBeLessThanOrEqual(20);
    if (!result.widthFits) expect(result.fontSize).toBe(AUTO_FIT_FLOOR_PX);
  });

  it("wraps an over-width line with a continuation indent instead of shrinking fontSize when wrap is 'soft'", () => {
    const longLine = "x".repeat(500);
    const result = layoutCode([longLine], { width: 300, height: 900, fontSize: 20, wrap: "soft" });

    expect(result.fontSize).toBe(20);
    expect(result.widthFits).toBe(true);
    expect(result.lines[0]?.rows.length).toBeGreaterThan(1);
    // continuation rows carry the shared leading-space indent
    for (const row of result.lines[0]?.rows.slice(1) ?? []) {
      expect(row.startsWith(" ")).toBe(true);
    }
    expect(result.totalRows).toBe(result.lines[0]?.rows.length);
  });

  it("reports a larger gutterWidthPx when showLineNumbers is true than when false", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const withNumbers = layoutCode(lines, { width: 1600, height: 900, showLineNumbers: true });
    const withoutNumbers = layoutCode(lines, { width: 1600, height: 900, showLineNumbers: false });

    expect(withoutNumbers.gutterWidthPx).toBe(0);
    expect(withNumbers.gutterWidthPx).toBeGreaterThan(0);
    expect(withNumbers.contentWidthPx).toBeLessThan(withoutNumbers.contentWidthPx);
  });

  it("surfaces availableLines for a 40-line block sized for 20 (AC5's setup)", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `console.log(${i});`);
    const fontSize = 20;
    const lineHeightPx = fontSize * 1.5;
    // Solve height so availableLines comes out to exactly 20.
    const height = 20 * lineHeightPx + 76; // + CHROME_VERTICAL_PX
    const result = layoutCode(lines, { width: 1600, height, fontSize, wrap: "none" });

    expect(result.availableLines).toBe(20);
    expect(result.totalRows).toBe(40);
  });
});
