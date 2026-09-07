// spec.md FR9, AC9 — SRT/VTT export from a WordTiming[]. Pure formatting functions, no
// inference/IO involved.

import { describe, expect, it } from "vitest";

import { exportSrt, exportVtt } from "../src/export.js";
import type { WordTiming } from "../src/word-timing-types.js";

function word(overrides: Partial<WordTiming> & Pick<WordTiming, "word" | "start" | "end">): WordTiming {
  return { estimated: false, ...overrides };
}

describe("exportSrt", () => {
  it("produces sequentially numbered cues with correct HH:MM:SS,mmm timestamps", () => {
    const timings: WordTiming[] = [
      word({ word: "Hello", start: 0, end: 0.5 }),
      word({ word: "world", start: 0.5, end: 1.25 }),
    ];

    expect(exportSrt(timings)).toBe(
      "1\n00:00:00,000 --> 00:00:00,500\nHello\n\n" + "2\n00:00:00,500 --> 00:00:01,250\nworld\n",
    );
  });

  it("computes HH:MM:SS correctly across a minute boundary", () => {
    const timings: WordTiming[] = [word({ word: "later", start: 65.5, end: 66.75 })];

    expect(exportSrt(timings)).toBe("1\n00:01:05,500 --> 00:01:06,750\nlater\n");
  });

  it("returns an empty string for an empty array", () => {
    expect(exportSrt([])).toBe("");
  });

  it("handles a single word cleanly", () => {
    const timings: WordTiming[] = [word({ word: "solo", start: 1, end: 2 })];

    expect(exportSrt(timings)).toBe("1\n00:00:01,000 --> 00:00:02,000\nsolo\n");
  });

  it("marks only the estimated word distinctly (AC9)", () => {
    const timings: WordTiming[] = [
      word({ word: "measured", start: 0, end: 0.5, estimated: false }),
      word({ word: "guessed", start: 0.5, end: 1, estimated: true }),
      word({ word: "also-measured", start: 1, end: 1.5, estimated: false }),
    ];

    const output = exportSrt(timings);
    expect(output).toContain("[estimated]guessed[/estimated]");
    expect(output).not.toContain("[estimated]measured");
    expect(output).not.toContain("[estimated]also-measured");
    expect(output.match(/\[estimated\]/g)).toHaveLength(1);
  });
});

describe("exportVtt", () => {
  it("produces a WEBVTT header and dot-separated HH:MM:SS.mmm timestamps", () => {
    const timings: WordTiming[] = [
      word({ word: "Hello", start: 0, end: 0.5 }),
      word({ word: "world", start: 0.5, end: 1.25 }),
    ];

    expect(exportVtt(timings)).toBe(
      "WEBVTT\n\n" +
        "00:00:00.000 --> 00:00:00.500\nHello\n\n" +
        "00:00:00.500 --> 00:00:01.250\nworld\n",
    );
  });

  it("computes HH:MM:SS correctly across a minute boundary", () => {
    const timings: WordTiming[] = [word({ word: "later", start: 65.5, end: 66.75 })];

    expect(exportVtt(timings)).toBe("WEBVTT\n\n00:01:05.500 --> 00:01:06.750\nlater\n");
  });

  it("returns a header-only VTT for an empty array", () => {
    expect(exportVtt([])).toBe("WEBVTT\n");
  });

  it("handles a single word cleanly", () => {
    const timings: WordTiming[] = [word({ word: "solo", start: 1, end: 2 })];

    expect(exportVtt(timings)).toBe("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nsolo\n");
  });

  it("marks only the estimated word distinctly (AC9)", () => {
    const timings: WordTiming[] = [
      word({ word: "measured", start: 0, end: 0.5, estimated: false }),
      word({ word: "guessed", start: 0.5, end: 1, estimated: true }),
      word({ word: "also-measured", start: 1, end: 1.5, estimated: false }),
    ];

    const output = exportVtt(timings);
    expect(output).toContain("[estimated]guessed[/estimated]");
    expect(output).not.toContain("[estimated]measured");
    expect(output).not.toContain("[estimated]also-measured");
    expect(output.match(/\[estimated\]/g)).toHaveLength(1);
  });
});
