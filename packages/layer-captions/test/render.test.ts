// T6: unit tests for `findActiveWordIndex` — the pure active-word lookup `paintCaptionsLayer`
// drives every frame (spec.md FR6; design.md Key Decision D7's "direct frame-time comparison").
// Extracted as its own pure function specifically so it's testable without a full canvas context
// — see render.ts's own header comment.
import { describe, expect, it } from "vitest";
import type { WordTiming } from "@claudevid/audio";
import { findActiveWordIndex } from "../src/render.js";

function word(word: string, start: number, end: number): WordTiming {
  return { word, start, end, estimated: false };
}

describe("findActiveWordIndex", () => {
  const words: WordTiming[] = [word("hello", 0, 0.4), word("world", 0.5, 0.9), word("today", 0.9, 1.3)];

  it("returns the word whose [start, end) window contains the current time", () => {
    expect(findActiveWordIndex(words, 0.2)).toBe(0);
    expect(findActiveWordIndex(words, 0.6)).toBe(1);
    expect(findActiveWordIndex(words, 1.0)).toBe(2);
  });

  it("treats a word's own start as active (inclusive lower bound)", () => {
    expect(findActiveWordIndex(words, 0)).toBe(0);
    expect(findActiveWordIndex(words, 0.5)).toBe(1);
  });

  it("treats a word's own end as NOT active — the next word's start owns that instant, or no word does (exclusive upper bound)", () => {
    expect(findActiveWordIndex(words, 0.4)).toBe(null); // gap between word 0 and word 1
    expect(findActiveWordIndex(words, 0.9)).toBe(2); // word 1's end === word 2's start, so word 2 owns it
  });

  it("returns null in a gap between two words", () => {
    expect(findActiveWordIndex(words, 0.45)).toBe(null);
  });

  it("returns null before the first word", () => {
    expect(findActiveWordIndex(words, -0.1)).toBe(null);
  });

  it("returns null at and after the last word's end", () => {
    expect(findActiveWordIndex(words, 1.3)).toBe(null);
    expect(findActiveWordIndex(words, 5)).toBe(null);
  });

  it("returns null for an empty words array", () => {
    expect(findActiveWordIndex([], 0)).toBe(null);
  });

  it("handles a single-word layer's own edges", () => {
    const single = [word("hi", 1, 2)];
    expect(findActiveWordIndex(single, 0.9)).toBe(null);
    expect(findActiveWordIndex(single, 1)).toBe(0);
    expect(findActiveWordIndex(single, 1.5)).toBe(0);
    expect(findActiveWordIndex(single, 2)).toBe(null);
  });
});
