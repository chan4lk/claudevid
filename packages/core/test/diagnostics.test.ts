import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/diagnostics.js";

function minimalSpec() {
  return {
    version: 1,
    width: 1920,
    height: 1080,
    fps: 30,
    scenes: [
      {
        id: "intro",
        duration: 3,
        layers: [{ type: "text", text: "Hello" }],
      },
    ],
  };
}

describe("parseSpec (AC1)", () => {
  it("accepts a minimal valid spec", () => {
    const result = parseSpec(minimalSpec());
    expect(result.ok).toBe(true);
  });
});

describe("parseSpec (AC2)", () => {
  it("rejects an out-of-range fontSize with a JSON pointer to the offending field", () => {
    const spec = minimalSpec();
    (spec.scenes[0]!.layers[0] as any).fontSize = -5;

    const result = parseSpec(spec);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diagnostic = result.diagnostics.find((d) => d.path.includes("fontSize"));
      expect(diagnostic).toBeDefined();
      expect(diagnostic!.path).toBe("/scenes/0/layers/0/fontSize");
    }
  });
});

describe("parseSpec (AC3)", () => {
  it("rejects a group nested 3 levels deep with a diagnostic naming the path", () => {
    const spec = minimalSpec();
    spec.scenes[0]!.layers = [
      {
        type: "group",
        id: "g1",
        children: [
          {
            type: "group",
            id: "g2",
            children: [
              {
                type: "group",
                id: "g3",
                children: [{ type: "text", text: "too deep" }],
              },
            ],
          },
        ],
      },
    ] as any;

    const result = parseSpec(spec);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.diagnostics[0]!.message).toMatch(/nesting/i);
      expect(result.diagnostics[0]!.path).toMatch(/^\/scenes\/0\/layers/);
    }
  });
});

describe("parseSpec — duplicate scene ids", () => {
  it("rejects two scenes sharing an id, pointing at the second occurrence", () => {
    const spec = minimalSpec();
    spec.scenes.push({ id: "intro", duration: 2, layers: [] });

    const result = parseSpec(spec);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diagnostic = result.diagnostics.find((d) => d.message.includes("Duplicate scene id"));
      expect(diagnostic).toBeDefined();
      expect(diagnostic!.path).toBe("/scenes/1/id");
    }
  });
});
