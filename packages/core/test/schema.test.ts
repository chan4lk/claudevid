import { describe, expect, it } from "vitest";
import { videoSpecSchema } from "../src/schema.js";

describe("videoSpecSchema", () => {
  it("defaults width/height/fps when omitted", () => {
    const result = videoSpecSchema.safeParse({
      version: 1,
      scenes: [{ id: "a", duration: 1, layers: [] }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.width).toBe(1920);
      expect(result.data.height).toBe(1080);
      expect(result.data.fps).toBe(30);
    }
  });

  it("rejects an empty scenes array", () => {
    const result = videoSpecSchema.safeParse({ version: 1, scenes: [] });
    expect(result.success).toBe(false);
  });

  it("accepts a scene with duration: \"auto\"", () => {
    const result = videoSpecSchema.safeParse({
      version: 1,
      scenes: [{ id: "a", duration: "auto", layers: [] }],
    });
    expect(result.success).toBe(true);
  });
});
