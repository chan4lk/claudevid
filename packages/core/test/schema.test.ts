import { describe, expect, it } from "vitest";
import { videoSpecSchema } from "../src/schema.js";
import { chunkNarrationText } from "../src/narration-chunking.js";

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

  it("accepts a text layer's wrap/line-height/align fields (change 002's word-wrap consumes these)", () => {
    const result = videoSpecSchema.safeParse({
      version: 1,
      scenes: [
        {
          id: "a",
          duration: 1,
          layers: [{ type: "text", text: "hello", maxWidth: 400, lineHeight: 1.4, align: "left" }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  describe("scene.narration", () => {
    it("parses without a narration field at all (existing specs without narration still work)", () => {
      const result = videoSpecSchema.safeParse({
        version: 1,
        scenes: [{ id: "a", duration: 1, layers: [] }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.scenes[0]!.narration).toBeUndefined();
      }
    });

    it("normalizes a bare string to a one-item NarrationBlock[] (AC1)", () => {
      const result = videoSpecSchema.safeParse({
        version: 1,
        scenes: [{ id: "a", duration: 1, layers: [], narration: "hello world" }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.scenes[0]!.narration).toEqual([{ text: "hello world" }]);
      }
    });

    it("normalizes a single NarrationBlock object to a one-item array", () => {
      const result = videoSpecSchema.safeParse({
        version: 1,
        scenes: [{ id: "a", duration: 1, layers: [], narration: { text: "a", voice: "x" } }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.scenes[0]!.narration).toEqual([{ text: "a", voice: "x" }]);
      }
    });

    it("passes an array of NarrationBlock through unmodified (AC2)", () => {
      const narration = [{ text: "a" }, { text: "b", voice: "x" }];
      const result = videoSpecSchema.safeParse({
        version: 1,
        scenes: [{ id: "a", duration: 1, layers: [], narration }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.scenes[0]!.narration).toEqual(narration);
      }
    });

    it("rejects a narration block missing required text", () => {
      const result = videoSpecSchema.safeParse({
        version: 1,
        scenes: [{ id: "a", duration: 1, layers: [], narration: [{ voice: "x" }] }],
      });
      expect(result.success).toBe(false);
    });

    it("leaves a single under-threshold narration block unaffected — same single-block shape as before chunking (AC2)", () => {
      const text = "A short line of narration well under the chunking threshold.";
      const result = videoSpecSchema.safeParse({
        version: 1,
        scenes: [
          { id: "a", duration: 1, layers: [], narration: { text, voice: "narrator-1", speed: 1.2 } },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.scenes[0]!.narration).toEqual([{ text, voice: "narrator-1", speed: 1.2 }]);
      }
    });

    it("splits an over-length narration block into multiple NarrationBlocks carrying the original voice/speed (AC1)", () => {
      const sentence =
        "This is a test sentence used only to pad out the narration text so it exceeds the safe word threshold and triggers chunking.";
      const longText = `${sentence} ${sentence} ${sentence} ${sentence} ${sentence}`;
      const expectedChunks = chunkNarrationText(longText);
      expect(expectedChunks.length).toBeGreaterThan(1);

      const result = videoSpecSchema.safeParse({
        version: 1,
        scenes: [
          {
            id: "a",
            duration: 1,
            layers: [],
            narration: { text: longText, voice: "narrator-1", speed: 1.2 },
          },
        ],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.scenes[0]!.narration).toEqual(
          expectedChunks.map((text) => ({ text, voice: "narrator-1", speed: 1.2 }))
        );
      }
    });
  });
});
