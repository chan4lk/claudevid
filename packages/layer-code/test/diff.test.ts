// Covers FR11/AC9 directly — the golden fixture spec.md pins verbatim, plus the pure-LCS
// properties (determinism, both-sides-changed, wholly-added/removed tails, no-op diff) that
// back it. Full render-time diff-fade coverage (AC9's "cache fixture" half) is T13's job.
import { describe, expect, it } from "vitest";
import { diffLines } from "../src/diff.js";

describe("diffLines (FR11, AC9)", () => {
  it("matches AC9's exact golden fixture", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc")).toEqual([
      { text: "a", kind: "unchanged" },
      { text: "b", kind: "removed" },
      { text: "x", kind: "added" },
      { text: "c", kind: "unchanged" },
    ]);
  });

  it("is pure and deterministic — same inputs, same output, repeatedly", () => {
    const a = diffLines("a\nb\nc", "a\nx\nc");
    const b = diffLines("a\nb\nc", "a\nx\nc");
    expect(a).toEqual(b);
  });

  it("returns every line unchanged when before === after (Edge Cases: diff.before === code)", () => {
    const code = "one\ntwo\nthree";
    expect(diffLines(code, code)).toEqual([
      { text: "one", kind: "unchanged" },
      { text: "two", kind: "unchanged" },
      { text: "three", kind: "unchanged" },
    ]);
  });

  it("marks a wholly-added tail when after has extra trailing lines", () => {
    expect(diffLines("a\nb", "a\nb\nc\nd")).toEqual([
      { text: "a", kind: "unchanged" },
      { text: "b", kind: "unchanged" },
      { text: "c", kind: "added" },
      { text: "d", kind: "added" },
    ]);
  });

  it("marks a wholly-removed tail when before has extra trailing lines", () => {
    expect(diffLines("a\nb\nc\nd", "a\nb")).toEqual([
      { text: "a", kind: "unchanged" },
      { text: "b", kind: "unchanged" },
      { text: "c", kind: "removed" },
      { text: "d", kind: "removed" },
    ]);
  });

  it("diffs a single-line before/after pair with no common line as one removed + one added", () => {
    expect(diffLines("foo", "bar")).toEqual([
      { text: "foo", kind: "removed" },
      { text: "bar", kind: "added" },
    ]);
  });

  it("handles multiple interleaved changes, preserving document order", () => {
    const before = "1\n2\n3\n4\n5";
    const after = "1\n9\n3\n8\n5";
    expect(diffLines(before, after)).toEqual([
      { text: "1", kind: "unchanged" },
      { text: "2", kind: "removed" },
      { text: "9", kind: "added" },
      { text: "3", kind: "unchanged" },
      { text: "4", kind: "removed" },
      { text: "8", kind: "added" },
      { text: "5", kind: "unchanged" },
    ]);
  });
});
