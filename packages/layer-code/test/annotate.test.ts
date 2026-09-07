import { describe, expect, it } from "vitest";
import { annotationPosition } from "../src/annotate.js";
import { GUTTER_PADDING_PX, layoutCode, measureLine } from "../src/layout.js";

// Minimal sanity coverage for T10's own contract — full AC-mapped coverage (AC11) lands in
// T13's dedicated `annotate.test.ts` per design.md's Architecture (Wave 5); this proves the
// shape and core guarantee hold before that wave.

describe("annotationPosition (FR12 / AC11)", () => {
  const sourceLines = ["const a = 1;", "const b = 2;", "const c = 3;", "return a + b + c;"];
  const layout = layoutCode(sourceLines, { width: 800, height: 600, fontSize: 20 });

  it("AC11: y is within 1px of layout's own recorded offset for the target line", () => {
    const pos = annotationPosition({ line: 3, text: "note", side: "left" }, layout);
    const expectedLine = layout.lines[2];
    expect(expectedLine).toBeDefined();
    expect(Math.abs(pos.y - expectedLine!.y)).toBeLessThanOrEqual(1);
  });

  it("reads y verbatim from layout.lines, never re-deriving line * lineHeightPx", () => {
    for (let line = 1; line <= sourceLines.length; line++) {
      const pos = annotationPosition({ line, text: "x" }, layout);
      expect(pos.y).toBe(layout.lines[line - 1]!.y);
    }
  });

  it('side "left" (default) is gutter-adjacent: x is 0, the content box\'s own left edge', () => {
    const explicit = annotationPosition({ line: 1, text: "note", side: "left" }, layout);
    const defaulted = annotationPosition({ line: 1, text: "note" }, layout);
    expect(explicit.x).toBe(0);
    expect(defaulted.x).toBe(0);
  });

  it('side "right" is past the longest line: longest line width + GUTTER_PADDING_PX', () => {
    const pos = annotationPosition({ line: 1, text: "note", side: "right" }, layout);
    const expectedX = measureLine(layout.longestLineCharCount, layout.fontSize) + GUTTER_PADDING_PX;
    expect(pos.x).toBeCloseTo(expectedX, 5);
  });

  it("throws for an out-of-range line rather than silently clamping (FR12)", () => {
    expect(() => annotationPosition({ line: 999, text: "note" }, layout)).toThrow(RangeError);
  });
});
