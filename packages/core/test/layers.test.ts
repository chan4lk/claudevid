import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerLayer } from "../src/layers.js";
import { parseSpec } from "../src/diagnostics.js";

describe("registerLayer (AC9)", () => {
  it("lets parseSpec accept a new layer type without editing layers.ts", () => {
    const captionLayerSchema = z.object({
      type: z.literal("caption"),
      text: z.string(),
      words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })),
    });
    registerLayer("caption", captionLayerSchema);

    const result = parseSpec({
      version: 1,
      width: 1920,
      height: 1080,
      fps: 30,
      scenes: [
        {
          id: "s1",
          duration: 3,
          layers: [{ type: "caption", text: "hi", words: [{ word: "hi", start: 0, end: 0.4 }] }],
        },
      ],
    });

    expect(result.ok).toBe(true);
  });
});
