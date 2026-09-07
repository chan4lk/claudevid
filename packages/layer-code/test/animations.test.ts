import { orderIndices } from "@claudevid/motion";
import { describe, expect, it } from "vitest";
import {
  focusState,
  lineStaggerDelays,
  scrollOffsetPx,
  typewriterState,
  type TypewriterReveal,
} from "../src/animations.js";
import type { CodeFocus, CodeScroll } from "../src/schema.js";

const FPS = 30;

describe("typewriterState (FR10)", () => {
  it("defaults to unit \"char\" at 30 char/s", () => {
    const reveal: TypewriterReveal = { mode: "typewriter" };
    // 0.5s elapsed * 30 char/s = 15 chars revealed across [10, 10, 10].
    const state = typewriterState(reveal, FPS * 0.5, FPS, [10, 10, 10]);
    expect(state.revealedLines).toBe(1);
    expect(state.partialLineChars).toBe(5);
  });

  it("reveals nothing before startDelay elapses", () => {
    const reveal: TypewriterReveal = { mode: "typewriter", startDelay: 1 };
    const state = typewriterState(reveal, FPS * 0.5, FPS, [10, 10, 10]);
    expect(state.revealedLines).toBe(0);
    expect(state.partialLineChars).toBe(0);
    expect(state.caretOn).toBe(false);
  });

  it("resumes counting from zero once startDelay elapses", () => {
    const reveal: TypewriterReveal = { mode: "typewriter", startDelay: 1, rate: 30 };
    // 1.5s elapsed - 1s delay = 0.5s revealing * 30 char/s = 15 chars.
    const state = typewriterState(reveal, FPS * 1.5, FPS, [10, 10, 10]);
    expect(state.revealedLines).toBe(1);
    expect(state.partialLineChars).toBe(5);
  });

  it("clamps to fully revealed once elapsed time exceeds total content", () => {
    const reveal: TypewriterReveal = { mode: "typewriter", rate: 30 };
    const state = typewriterState(reveal, FPS * 10, FPS, [10, 10, 10]);
    expect(state.revealedLines).toBe(3);
    expect(state.partialLineChars).toBe(0);
  });

  it("unit \"line\" reveals whole lines at the line rate, ignoring char lengths", () => {
    const reveal: TypewriterReveal = { mode: "typewriter", unit: "line", rate: 2 };
    // 1.5s * 2 line/s = 3 lines.
    const state = typewriterState(reveal, FPS * 1.5, FPS, [500, 1, 500, 500]);
    expect(state.revealedLines).toBe(3);
    expect(state.partialLineChars).toBe(0);
  });

  it("unit \"token\" uses the default 8 token/s rate", () => {
    const reveal: TypewriterReveal = { mode: "typewriter", unit: "token" };
    // 1s * 8 token/s = 8 tokens revealed across [5, 5].
    const state = typewriterState(reveal, FPS * 1, FPS, [5, 5]);
    expect(state.revealedLines).toBe(1);
    expect(state.partialLineChars).toBe(3);
  });

  it("caret blinks at a fixed 2Hz once revealing has started", () => {
    const reveal: TypewriterReveal = { mode: "typewriter" };
    expect(typewriterState(reveal, 0, FPS, [10]).caretOn).toBe(true);
    expect(typewriterState(reveal, FPS / 4, FPS, [10]).caretOn).toBe(false);
    expect(typewriterState(reveal, (FPS / 4) * 2, FPS, [10]).caretOn).toBe(true);
    expect(typewriterState(reveal, (FPS / 4) * 3, FPS, [10]).caretOn).toBe(false);
  });

  it("caret is never on when reveal.caret is false", () => {
    const reveal: TypewriterReveal = { mode: "typewriter", caret: false };
    expect(typewriterState(reveal, 0, FPS, [10]).caretOn).toBe(false);
    expect(typewriterState(reveal, (FPS / 4) * 2, FPS, [10]).caretOn).toBe(false);
  });

  it("is deterministic: identical inputs always produce identical output", () => {
    const reveal: TypewriterReveal = { mode: "typewriter", rate: 12 };
    const a = typewriterState(reveal, 17, FPS, [8, 3, 12]);
    const b = typewriterState(reveal, 17, FPS, [8, 3, 12]);
    expect(a).toEqual(b);
  });
});

describe("lineStaggerDelays (FR10)", () => {
  it("delegates to @claudevid/motion's orderIndices rather than reimplementing ordering", () => {
    const childCount = 5;
    const each = 0.1;
    for (const from of ["first", "last", "center", "random"] as const) {
      const expectedRanks = orderIndices(
        Array.from({ length: childCount }, (_, i) => String(i)),
        from,
      );
      expect(lineStaggerDelays(childCount, each, from)).toEqual(expectedRanks.map((r) => r * each));
    }
  });

  it("defaults to \"first\" (identity order, index i * each)", () => {
    const delays = lineStaggerDelays(4, 0.05);
    [0, 0.05, 0.1, 0.15].forEach((expected, i) => expect(delays[i]).toBeCloseTo(expected, 10));
  });

  it("\"last\" reverses the order", () => {
    const delays = lineStaggerDelays(4, 0.05, "last");
    [0.15, 0.1, 0.05, 0].forEach((expected, i) => expect(delays[i]).toBeCloseTo(expected, 10));
  });

  it("is deterministic across repeated calls with the same inputs (NFR4)", () => {
    const a = lineStaggerDelays(9, 0.03, "random");
    const b = lineStaggerDelays(9, 0.03, "random");
    expect(a).toEqual(b);
  });
});

describe("focusState (FR10)", () => {
  it("returns the static focus.lines range when there is no focus.animate", () => {
    const focus: CodeFocus = { lines: [3, 7], dimOpacity: 0.2 };
    const state = focusState(focus, 123, FPS);
    expect(state.range).toEqual([3, 7]);
    expect(state.dimOpacity).toBe(0.2);
  });

  it("defaults dimOpacity to 0.35", () => {
    const focus: CodeFocus = { lines: [1, 1] };
    expect(focusState(focus, 0, FPS).dimOpacity).toBe(0.35);
  });

  it("starts at focus.animate.from before the animation begins", () => {
    const focus: CodeFocus = {
      lines: [10, 12],
      animate: { from: [1, 2], duration: 1, easing: "linear" },
    };
    expect(focusState(focus, 0, FPS).range).toEqual([1, 2]);
  });

  it("reaches focus.lines exactly once the animation duration has elapsed", () => {
    const focus: CodeFocus = {
      lines: [10, 12],
      animate: { from: [1, 2], duration: 1, easing: "linear" },
    };
    expect(focusState(focus, FPS * 2, FPS).range).toEqual([10, 12]);
  });

  it("lerps linearly at the midpoint under linear easing", () => {
    const focus: CodeFocus = {
      lines: [10, 20],
      animate: { from: [0, 0], duration: 2, easing: "linear" },
    };
    const state = focusState(focus, FPS * 1, FPS); // halfway through a 2s animation
    expect(state.range[0]).toBeCloseTo(5, 5);
    expect(state.range[1]).toBeCloseTo(10, 5);
  });

  it("respects focus.animate.delay before starting", () => {
    const focus: CodeFocus = {
      lines: [10, 12],
      animate: { from: [1, 2], duration: 1, delay: 1, easing: "linear" },
    };
    expect(focusState(focus, FPS * 0.5, FPS).range).toEqual([1, 2]);
  });
});

describe("scrollOffsetPx (FR10)", () => {
  const lineHeightPx = 24;

  it("defaults fromLine to 1, giving a 0 offset at the start", () => {
    const scroll: CodeScroll = { toLine: 21, duration: 1, easing: "linear" };
    expect(scrollOffsetPx(scroll, 0, FPS, lineHeightPx)).toBe(0);
  });

  it("reaches (toLine - 1) * lineHeightPx once the animation completes", () => {
    const scroll: CodeScroll = { toLine: 21, duration: 1, easing: "linear" };
    expect(scrollOffsetPx(scroll, FPS * 2, FPS, lineHeightPx)).toBeCloseTo(20 * lineHeightPx, 5);
  });

  it("lerps linearly at the midpoint under linear easing", () => {
    const scroll: CodeScroll = { toLine: 11, fromLine: 1, duration: 2, easing: "linear" };
    const offset = scrollOffsetPx(scroll, FPS * 1, FPS, lineHeightPx); // halfway through 2s
    expect(offset).toBeCloseTo(5 * lineHeightPx, 5);
  });

  it("respects delay before starting", () => {
    const scroll: CodeScroll = { toLine: 21, fromLine: 1, duration: 1, delay: 1, easing: "linear" };
    expect(scrollOffsetPx(scroll, FPS * 0.5, FPS, lineHeightPx)).toBe(0);
  });

  it("is deterministic: identical inputs always produce identical output", () => {
    const scroll: CodeScroll = { toLine: 8, duration: 0.5 };
    const a = scrollOffsetPx(scroll, 7, FPS, lineHeightPx);
    const b = scrollOffsetPx(scroll, 7, FPS, lineHeightPx);
    expect(a).toBe(b);
  });
});
