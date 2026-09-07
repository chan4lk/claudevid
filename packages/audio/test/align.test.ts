// Tests for align.ts (spec.md FR1-FR4, AC1-AC4, NFR2). Every test injects its own `asrFn` fixture
// via `align()`'s `opts` seam — never the real Whisper-backed `runWhisperAsr` — so nothing here
// loads a model or performs real inference. Only reconciliation (edit-distance DP alignment) and
// validation (monotonic/non-negative/bounded, fail-closed/estimated) are exercised, and both are
// pure logic that runs identically regardless of where the raw recognized word stream came from.

import { describe, expect, it } from "vitest";

import { align, AlignmentValidationError, LowConfidenceSpanError, type RawAsrWord } from "../src/align.js";
import type { AlignRequest } from "../src/word-timing-types.js";

const SAMPLE_RATE = 100;

/** Builds a silent 16-bit PCM mono buffer `durationSeconds` long at `SAMPLE_RATE` — only its
 * length matters (`audio.length / 2 / sampleRate` is align.ts's own duration formula, matching
 * 006's PCM format), so all-zero samples are fine. */
function makeAudioBuffer(durationSeconds: number): Buffer {
  return Buffer.alloc(Math.round(durationSeconds * SAMPLE_RATE) * 2);
}

function baseRequest(overrides: Partial<AlignRequest> & { referenceText: string }): AlignRequest {
  return {
    audio: makeAudioBuffer(2),
    sampleRate: SAMPLE_RATE,
    ...overrides,
  };
}

describe("align() — AC1: clean 1:1 recognized stream", () => {
  it("produces one WordTiming per reference word, all estimated: false", async () => {
    const recognized: RawAsrWord[] = [
      { word: " the", start: 0, end: 0.4 },
      { word: " quick", start: 0.4, end: 0.8 },
      { word: " brown", start: 0.8, end: 1.2 },
      { word: " fox", start: 1.2, end: 1.6 },
    ];
    const result = await align(baseRequest({ referenceText: "the quick brown fox" }), {
      asrFn: async () => recognized,
    });

    expect(result.timings).toHaveLength(4);
    expect(result.timings.map((t) => t.word)).toEqual(["the", "quick", "brown", "fox"]);
    expect(result.timings.every((t) => t.estimated === false)).toBe(true);
    expect(result.estimatedSpans).toEqual([]);
    expect(result.timings[0]).toMatchObject({ start: 0, end: 0.4 });
    expect(result.timings[3]).toMatchObject({ start: 1.2, end: 1.6 });
  });
});

describe("align() — AC2: dropped / inserted / reordered recognized words", () => {
  it("dropped recognized word: still produces one WordTiming per reference word", async () => {
    // "quick" never appears in the recognized stream at all.
    const recognized: RawAsrWord[] = [
      { word: "the", start: 0, end: 0.3 },
      { word: "brown", start: 0.6, end: 1.0 },
      { word: "fox", start: 1.0, end: 1.4 },
    ];
    const result = await align(
      baseRequest({ referenceText: "the quick brown fox", allowEstimated: true }),
      { asrFn: async () => recognized },
    );

    expect(result.timings).toHaveLength(4);
    expect(result.timings.map((t) => t.word)).toEqual(["the", "quick", "brown", "fox"]);
    expect(result.timings[0]!.estimated).toBe(false);
    expect(result.timings[1]!.estimated).toBe(true); // "quick" — proportionally filled
    expect(result.timings[2]!.estimated).toBe(false);
    expect(result.timings[3]!.estimated).toBe(false);
    expect(result.estimatedSpans).toEqual([{ startIndex: 1, endIndex: 1 }]);
    // Filled within the gap between "the"'s end (0.3) and "brown"'s start (0.6).
    expect(result.timings[1]!.start).toBeCloseTo(0.3);
    expect(result.timings[1]!.end).toBeCloseTo(0.6);
  });

  it("inserted extra recognized word: still produces one WordTiming per reference word", async () => {
    // "extra" appears in the recognized stream but has no reference counterpart.
    const recognized: RawAsrWord[] = [
      { word: "the", start: 0, end: 0.3 },
      { word: "extra", start: 0.3, end: 0.5 },
      { word: "quick", start: 0.5, end: 0.9 },
      { word: "brown", start: 0.9, end: 1.3 },
      { word: "fox", start: 1.3, end: 1.7 },
    ];
    const result = await align(
      baseRequest({ referenceText: "the quick brown fox", allowEstimated: true }),
      { asrFn: async () => recognized },
    );

    expect(result.timings).toHaveLength(4);
    expect(result.timings.map((t) => t.word)).toEqual(["the", "quick", "brown", "fox"]);
    // The insertion is cleanly skipped — every reference word gets a confident (non-estimated)
    // match, nothing needed the estimated fallback.
    expect(result.timings.every((t) => t.estimated === false)).toBe(true);
    expect(result.estimatedSpans).toEqual([]);
    expect(result.timings[1]).toMatchObject({ start: 0.5, end: 0.9 });
  });

  it("reordered adjacent pair: still produces one WordTiming per reference word", async () => {
    // Recognized stream has "brown" and "quick" swapped relative to the reference order.
    const recognized: RawAsrWord[] = [
      { word: "the", start: 0, end: 0.3 },
      { word: "brown", start: 0.3, end: 0.7 },
      { word: "quick", start: 0.7, end: 1.1 },
      { word: "fox", start: 1.1, end: 1.5 },
    ];
    const result = await align(
      baseRequest({ referenceText: "the quick brown fox", allowEstimated: true }),
      { asrFn: async () => recognized },
    );

    expect(result.timings).toHaveLength(4);
    expect(result.timings.map((t) => t.word)).toEqual(["the", "quick", "brown", "fox"]);
    // A reordered pair is not confidently matched by an edit-distance alignment (design.md D2) —
    // both "quick" and "brown" fall out as one unmatched span, filled proportionally.
    expect(result.timings[1]!.estimated).toBe(true);
    expect(result.timings[2]!.estimated).toBe(true);
    expect(result.estimatedSpans).toEqual([{ startIndex: 1, endIndex: 2 }]);
    // Filled monotonically within the gap between "the"'s end (0.3) and "fox"'s start (1.1).
    expect(result.timings[1]!.start).toBeCloseTo(0.3);
    expect(result.timings[2]!.end).toBeCloseTo(1.1);
    expect(result.timings[1]!.end).toBeLessThanOrEqual(result.timings[2]!.start);
  });
});

describe("align() — AC3: invalid timestamps are rejected", () => {
  it("throws naming the 'monotonic' check on a non-monotonic timestamp", async () => {
    const recognized: RawAsrWord[] = [
      { word: "hello", start: 0, end: 1.0 },
      { word: "world", start: 0.5, end: 0.8 }, // starts before the previous word ended
    ];
    const request = baseRequest({ referenceText: "hello world", audio: makeAudioBuffer(2) });

    await expect(align(request, { asrFn: async () => recognized })).rejects.toThrow(
      AlignmentValidationError,
    );
    try {
      await align(request, { asrFn: async () => recognized });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AlignmentValidationError);
      expect((err as AlignmentValidationError).check).toBe("monotonic");
      expect((err as AlignmentValidationError).wordIndex).toBe(1);
      expect((err as AlignmentValidationError).message).toMatch(/monotonic/);
    }
  });

  it("throws naming the 'non-negative' check on a negative timestamp", async () => {
    const recognized: RawAsrWord[] = [
      { word: "hello", start: -0.1, end: 0.5 },
      { word: "world", start: 0.5, end: 1.0 },
    ];
    const request = baseRequest({ referenceText: "hello world", audio: makeAudioBuffer(2) });

    try {
      await align(request, { asrFn: async () => recognized });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AlignmentValidationError);
      expect((err as AlignmentValidationError).check).toBe("non-negative");
      expect((err as AlignmentValidationError).wordIndex).toBe(0);
      expect((err as AlignmentValidationError).message).toMatch(/non-negative/);
    }
  });

  it("throws naming the 'bounded' check on a timestamp past the audio's duration", async () => {
    const recognized: RawAsrWord[] = [
      { word: "hello", start: 0, end: 0.5 },
      { word: "world", start: 0.5, end: 1.5 }, // audio is only 1.0s long
    ];
    const request = baseRequest({ referenceText: "hello world", audio: makeAudioBuffer(1) });

    try {
      await align(request, { asrFn: async () => recognized });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AlignmentValidationError);
      expect((err as AlignmentValidationError).check).toBe("bounded");
      expect((err as AlignmentValidationError).wordIndex).toBe(1);
      expect((err as AlignmentValidationError).message).toMatch(/bounded/);
    }
  });
});

describe("align() — AC4: fail-closed default vs. allowEstimated opt-in", () => {
  const recognized: RawAsrWord[] = [
    { word: "the", start: 0, end: 0.3 },
    // "quick" is entirely missing from the recognized stream (a low-confidence span).
    { word: "brown", start: 0.6, end: 1.0 },
    { word: "fox", start: 1.0, end: 1.4 },
  ];

  it("throws LowConfidenceSpanError when allowEstimated is false/absent (default)", async () => {
    const request = baseRequest({ referenceText: "the quick brown fox" });

    await expect(align(request, { asrFn: async () => recognized })).rejects.toThrow(
      LowConfidenceSpanError,
    );
  });

  it("returns successfully with the span marked estimated: true when allowEstimated is true", async () => {
    const request = baseRequest({ referenceText: "the quick brown fox", allowEstimated: true });

    const result = await align(request, { asrFn: async () => recognized });

    expect(result.timings).toHaveLength(4);
    expect(result.timings[1]!.word).toBe("quick");
    expect(result.timings[1]!.estimated).toBe(true);
    expect(result.estimatedSpans).toEqual([{ startIndex: 1, endIndex: 1 }]);
  });
});

describe("align() — misc", () => {
  it("returns an empty result for empty referenceText without calling asrFn", async () => {
    const request = baseRequest({ referenceText: "   " });
    let called = false;

    const result = await align(request, {
      asrFn: async () => {
        called = true;
        return [];
      },
    });

    expect(result).toEqual({ timings: [], estimatedSpans: [] });
    expect(called).toBe(false);
  });
});
