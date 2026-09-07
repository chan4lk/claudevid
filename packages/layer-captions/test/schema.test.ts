// T5: `captionsLayerSchema` itself (spec.md FR6) and the `registerLayer("captions", ...)` side
// effect actually extending `@claudevid/core`'s runtime layer union (AC5's schema half — mirrors
// `packages/layer-code/test/schema.test.ts`'s own `registerLayer` pattern, applied to this
// package's real registration call instead of a throwaway test schema).
import { describe, expect, it } from "vitest";
import { parseSpec } from "@claudevid/core";
import { captionsLayerSchema } from "../src/schema.js";
import "../src/schema.js"; // side effect: registerLayer("captions", captionsLayerSchema) at module load

function minimalCaptions(overrides: Record<string, unknown> = {}) {
  return {
    type: "captions" as const,
    words: [
      { word: "hello", start: 0, end: 0.4, estimated: false },
      { word: "world", start: 0.4, end: 0.9, estimated: false, confidence: 0.97 },
    ],
    ...overrides,
  };
}

describe("captionsLayerSchema — minimal valid layer", () => {
  it("parses a minimal captions layer (only the required fields)", () => {
    const result = captionsLayerSchema.safeParse(minimalCaptions());
    expect(result.success).toBe(true);
  });

  it("accepts a word timing entry without an optional confidence", () => {
    const result = captionsLayerSchema.safeParse(
      minimalCaptions({ words: [{ word: "hi", start: 0, end: 0.2, estimated: true }] }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a layer with an empty words array", () => {
    expect(captionsLayerSchema.safeParse(minimalCaptions({ words: [] })).success).toBe(false);
  });

  it("rejects a word timing entry missing 'estimated'", () => {
    const result = captionsLayerSchema.safeParse(
      minimalCaptions({ words: [{ word: "hi", start: 0, end: 0.2 }] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a negative start/end", () => {
    expect(
      captionsLayerSchema.safeParse(
        minimalCaptions({ words: [{ word: "hi", start: -1, end: 0.2, estimated: false }] }),
      ).success,
    ).toBe(false);
    expect(
      captionsLayerSchema.safeParse(
        minimalCaptions({ words: [{ word: "hi", start: 0, end: -0.2, estimated: false }] }),
      ).success,
    ).toBe(false);
  });

  it("rejects confidence outside [0, 1]", () => {
    expect(
      captionsLayerSchema.safeParse(
        minimalCaptions({ words: [{ word: "hi", start: 0, end: 0.2, estimated: false, confidence: 1.5 }] }),
      ).success,
    ).toBe(false);
  });

  it("rejects an empty word string", () => {
    expect(
      captionsLayerSchema.safeParse(
        minimalCaptions({ words: [{ word: "", start: 0, end: 0.2, estimated: false }] }),
      ).success,
    ).toBe(false);
  });
});

describe('registerLayer("captions", captionsLayerSchema) side effect (FR6, AC5)', () => {
  it("lets @claudevid/core's parseSpec accept a spec containing a captions layer", () => {
    const result = parseSpec({
      version: 1,
      width: 1920,
      height: 1080,
      fps: 30,
      scenes: [
        {
          id: "s1",
          duration: 3,
          layers: [minimalCaptions()],
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("still surfaces a diagnostic (not a thrown error) for an invalid captions layer inside a full spec", () => {
    const result = parseSpec({
      version: 1,
      width: 1920,
      height: 1080,
      fps: 30,
      scenes: [
        {
          id: "s1",
          duration: 3,
          layers: [minimalCaptions({ words: [] })],
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});
