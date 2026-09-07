// T12: `codeLayerSchema` itself (spec.md FR1) — the sub-schemas (`reveal`/`focus`/`diff`/
// `scroll`/`annotations`), the required `width`/`height` guardrail (FR1's grounding: matches
// `rect`'s required pair, not `image`'s optional one), and the `registerLayer("code", ...)` side
// effect actually extending `@claudevid/core`'s runtime layer union (mirrors
// `packages/core/test/layers.test.ts`'s own `registerLayer` pattern, applied to this package's
// real registration call instead of a throwaway test schema).
import { describe, expect, it } from "vitest";
import { parseSpec } from "@claudevid/core";
import { codeLayerSchema } from "../src/schema.js";
import "../src/schema.js"; // side effect: registerLayer("code", codeLayerSchema) at module load

function minimalCode(overrides: Record<string, unknown> = {}) {
  return {
    type: "code" as const,
    code: "const x = 1;",
    lang: "typescript",
    width: 800,
    height: 400,
    ...overrides,
  };
}

describe("codeLayerSchema — minimal valid layer", () => {
  it("parses a minimal code layer (only the required fields)", () => {
    const result = codeLayerSchema.safeParse(minimalCode());
    expect(result.success).toBe(true);
  });

  it("defaults theme to undefined (highlight.ts applies the \"github-dark\" default, not the schema)", () => {
    const result = codeLayerSchema.safeParse(minimalCode());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.theme).toBeUndefined();
  });

  it("defaults showLineNumbers to undefined at the schema level (render.ts applies the false default)", () => {
    const result = codeLayerSchema.safeParse(minimalCode());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.showLineNumbers).toBeUndefined();
  });

  it("rejects an empty code string (min 1)", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ code: "" })).success).toBe(false);
  });

  it("rejects a code string over 20000 characters", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ code: "x".repeat(20001) })).success).toBe(false);
  });

  it("accepts a code string at exactly the 20000-character max", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ code: "x".repeat(20000) })).success).toBe(true);
  });
});

describe("codeLayerSchema — required width/height (FR1)", () => {
  it("rejects a layer missing width", () => {
    const { width, ...rest } = minimalCode();
    void width;
    expect(codeLayerSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a layer missing height", () => {
    const { height, ...rest } = minimalCode();
    void height;
    expect(codeLayerSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects non-positive width/height", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ width: 0 })).success).toBe(false);
    expect(codeLayerSchema.safeParse(minimalCode({ height: -10 })).success).toBe(false);
  });
});

describe("codeLayerSchema — reveal sub-schema", () => {
  it("accepts a typewriter reveal with all optional fields", () => {
    const result = codeLayerSchema.safeParse(
      minimalCode({ reveal: { mode: "typewriter", unit: "char", rate: 30, startDelay: 0.5, caret: true } }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a bare typewriter reveal (only the discriminant)", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ reveal: { mode: "typewriter" } })).success).toBe(true);
  });

  it("accepts a line-stagger reveal", () => {
    expect(
      codeLayerSchema.safeParse(minimalCode({ reveal: { mode: "line-stagger", each: 0.1, from: "first" } })).success,
    ).toBe(true);
  });

  it("rejects an unknown reveal mode", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ reveal: { mode: "fade" } })).success).toBe(false);
  });

  it("rejects line-stagger missing its required 'each' field", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ reveal: { mode: "line-stagger" } })).success).toBe(false);
  });

  // Edge Cases: "reveal.mode: 'typewriter' with rate <= 0: rejected by the Zod schema
  // (z.number().positive()), not reachable as a runtime diagnostic."
  it("rejects a typewriter reveal with rate <= 0", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ reveal: { mode: "typewriter", rate: 0 } })).success).toBe(false);
    expect(codeLayerSchema.safeParse(minimalCode({ reveal: { mode: "typewriter", rate: -5 } })).success).toBe(false);
  });
});

describe("codeLayerSchema — focus sub-schema", () => {
  it("accepts a static focus.lines tuple", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ focus: { lines: [2, 4] } })).success).toBe(true);
  });

  it("accepts an animated focus with dimOpacity and easing", () => {
    const result = codeLayerSchema.safeParse(
      minimalCode({
        focus: {
          lines: [3, 5],
          dimOpacity: 0.2,
          animate: { from: [1, 1], duration: 1, delay: 0.2, easing: "ease-in" },
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects focus.lines missing the second tuple element", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ focus: { lines: [2] } })).success).toBe(false);
  });

  it("rejects a non-positive focus.lines entry", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ focus: { lines: [0, 3] } })).success).toBe(false);
  });

  it("rejects dimOpacity outside [0, 1]", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ focus: { lines: [1, 2], dimOpacity: 1.5 } })).success).toBe(false);
  });

  it("rejects focus.animate missing its required duration", () => {
    expect(
      codeLayerSchema.safeParse(minimalCode({ focus: { lines: [1, 2], animate: { from: [1, 1] } } })).success,
    ).toBe(false);
  });
});

describe("codeLayerSchema — diff sub-schema", () => {
  it("accepts a diff with only the required 'before' field", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ diff: { before: "const x = 0;" } })).success).toBe(true);
  });

  it("accepts a diff with all optional fields", () => {
    const result = codeLayerSchema.safeParse(
      minimalCode({
        diff: { before: "const x = 0;", addedBg: "#0f0", removedBg: "#f00", revealDelay: 0.5, duration: 1 },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a diff missing 'before'", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ diff: {} })).success).toBe(false);
  });

  it("rejects an empty 'before' string", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ diff: { before: "" } })).success).toBe(false);
  });
});

describe("codeLayerSchema — scroll sub-schema", () => {
  it("accepts a scroll with only the required toLine/duration", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ scroll: { toLine: 10, duration: 1 } })).success).toBe(true);
  });

  it("accepts a scroll with fromLine/delay/easing", () => {
    const result = codeLayerSchema.safeParse(
      minimalCode({ scroll: { toLine: 10, fromLine: 1, duration: 1, delay: 0.2, easing: "linear" } }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a scroll missing the required toLine", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ scroll: { duration: 1 } })).success).toBe(false);
  });

  it("rejects a scroll missing the required duration", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ scroll: { toLine: 10 } })).success).toBe(false);
  });

  it("rejects a non-positive toLine", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ scroll: { toLine: 0, duration: 1 } })).success).toBe(false);
  });
});

describe("codeLayerSchema — annotations sub-schema", () => {
  it("accepts an annotations array with only the required line/text", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ annotations: [{ line: 1, text: "note" }] })).success).toBe(true);
  });

  it("accepts an annotation with side/color/delay", () => {
    const result = codeLayerSchema.safeParse(
      minimalCode({ annotations: [{ line: 2, text: "note", side: "right", color: "#fff", delay: 0.3 }] }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an annotation missing 'text'", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ annotations: [{ line: 1 }] })).success).toBe(false);
  });

  it("rejects an annotation with a non-positive line", () => {
    expect(codeLayerSchema.safeParse(minimalCode({ annotations: [{ line: 0, text: "note" }] })).success).toBe(false);
  });

  it("rejects an annotation with an unknown side", () => {
    expect(
      codeLayerSchema.safeParse(minimalCode({ annotations: [{ line: 1, text: "note", side: "top" }] })).success,
    ).toBe(false);
  });
});

describe("registerLayer(\"code\", codeLayerSchema) side effect (FR1)", () => {
  it("lets @claudevid/core's parseSpec accept a spec containing a code layer", () => {
    const result = parseSpec({
      version: 1,
      width: 1920,
      height: 1080,
      fps: 30,
      scenes: [
        {
          id: "s1",
          duration: 3,
          layers: [minimalCode()],
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("still surfaces a diagnostic (not a thrown error) for an invalid code layer inside a full spec", () => {
    const result = parseSpec({
      version: 1,
      width: 1920,
      height: 1080,
      fps: 30,
      scenes: [
        {
          id: "s1",
          duration: 3,
          layers: [minimalCode({ width: undefined })],
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});
