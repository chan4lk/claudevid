// `claudevid validate` tests (spec.md FR2/AC2). No filesystem access — `readFile` is an injected
// fake, following tools/motion-preview's dependency-injection test style (see test/config.test.ts).

import { describe, expect, it } from "vitest";

import { runValidate } from "../src/commands/validate.js";

const VALID_SPEC = JSON.stringify({
  version: 1,
  width: 1920,
  height: 1080,
  fps: 30,
  scenes: [
    {
      id: "intro",
      duration: 3,
      layers: [{ type: "text", text: "Hello", x: "center", y: "center" }],
    },
    {
      id: "outro",
      duration: 2.5,
      layers: [{ type: "text", text: "Bye", x: "center", y: "center" }],
    },
  ],
});

// Missing the required top-level "version" field.
const INVALID_SPEC = JSON.stringify({
  width: 1920,
  height: 1080,
  fps: 30,
  scenes: [{ id: "intro", duration: 3, layers: [] }],
});

const MALFORMED_JSON = "{ this is not json";

describe("runValidate (FR2/AC2)", () => {
  it("reports ok and the scene count/duration summary for a valid spec", () => {
    const result = runValidate("spec.json", { readFile: () => VALID_SPEC });

    expect(result.ok).toBe(true);
    expect(result.sceneCount).toBe(2);
    expect(result.message).toContain("2 scenes");
    expect(result.message).toContain("5.5s");
  });

  it("reports auto-duration scenes separately from the timed total", () => {
    const spec = JSON.stringify({
      version: 1,
      width: 1920,
      height: 1080,
      fps: 30,
      scenes: [
        { id: "a", duration: 3, layers: [] },
        { id: "b", duration: "auto", layers: [], narration: "hi" },
      ],
    });

    const result = runValidate("spec.json", { readFile: () => spec });

    expect(result.ok).toBe(true);
    expect(result.sceneCount).toBe(2);
    expect(result.message).toContain("3s");
    expect(result.message).toContain("1 auto-duration");
  });

  it("reports failure with the missing field's JSON pointer for an invalid spec", () => {
    const result = runValidate("spec.json", { readFile: () => INVALID_SPEC });

    expect(result.ok).toBe(false);
    expect(result.sceneCount).toBe(0);
    expect(result.message).toContain("/version");
  });

  it("reports failure at pointer / for malformed JSON, without throwing", () => {
    expect(() =>
      runValidate("spec.json", { readFile: () => MALFORMED_JSON }),
    ).not.toThrow();

    const result = runValidate("spec.json", { readFile: () => MALFORMED_JSON });

    expect(result.ok).toBe(false);
    expect(result.sceneCount).toBe(0);
    expect(result.message).toContain("/:");
    expect(result.message).toContain("invalid JSON");
  });
});
