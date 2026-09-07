import { describe, expect, it } from "vitest";
import { mergeChapters, outline, SceneIdCollisionError } from "../src/chapters.js";
import type { VideoSpec } from "@claudevid/core";
import type { CreateStructuredMessageOptions } from "../src/anthropic-client.js";

const baseSpec = (overrides: Partial<VideoSpec>): VideoSpec => ({
  version: 1,
  width: 1920,
  height: 1080,
  fps: 30,
  scenes: [],
  ...overrides,
});

describe("mergeChapters", () => {
  it("concatenates disjoint chapters' scenes, in chapter order, using the first spec's top-level fields", () => {
    const chapter1 = baseSpec({
      scenes: [
        { id: "intro", duration: 3, layers: [] },
        { id: "topic", duration: 4, layers: [] },
      ],
    });
    const chapter2 = baseSpec({
      width: 1280,
      height: 720,
      fps: 24,
      scenes: [{ id: "outro", duration: 2, layers: [] }],
    });

    const merged = mergeChapters([chapter1, chapter2]);

    expect(merged.scenes.map((s) => s.id)).toEqual(["intro", "topic", "outro"]);
    // Top-level fields come from the first spec, mismatches in later specs are not reconciled.
    expect(merged.width).toBe(1920);
    expect(merged.height).toBe(1080);
    expect(merged.fps).toBe(30);
  });

  it("throws SceneIdCollisionError naming a shared scene id and does not return a partial merge", () => {
    const chapter1 = baseSpec({
      scenes: [{ id: "intro", duration: 3, layers: [] }],
    });
    const chapter2 = baseSpec({
      scenes: [{ id: "intro", duration: 2, layers: [] }],
    });

    let result: VideoSpec | undefined;
    let thrown: unknown;
    try {
      result = mergeChapters([chapter1, chapter2]);
    } catch (err) {
      thrown = err;
    }

    expect(result).toBeUndefined();
    expect(thrown).toBeInstanceOf(SceneIdCollisionError);
    expect((thrown as SceneIdCollisionError).collidingIds).toEqual(["intro"]);
    expect((thrown as Error).message).toContain("intro");
  });

  it("names every colliding id, not just the first", () => {
    const chapter1 = baseSpec({
      scenes: [
        { id: "a", duration: 1, layers: [] },
        { id: "b", duration: 1, layers: [] },
      ],
    });
    const chapter2 = baseSpec({
      scenes: [
        { id: "a", duration: 1, layers: [] },
        { id: "b", duration: 1, layers: [] },
      ],
    });

    expect(() => mergeChapters([chapter1, chapter2])).toThrow(SceneIdCollisionError);
    try {
      mergeChapters([chapter1, chapter2]);
      expect.unreachable("mergeChapters should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SceneIdCollisionError);
      expect((err as SceneIdCollisionError).collidingIds.sort()).toEqual(["a", "b"]);
    }
  });
});

describe("outline", () => {
  const fakeCreateMessage = (result: unknown) => async (_opts: CreateStructuredMessageOptions) => result;

  it("resolves with the chapters array from a well-formed response", async () => {
    const chapters = [
      { title: "Intro", summary: "Sets up the problem." },
      { title: "The Fix", summary: "Walks through the solution." },
    ];

    const result = await outline("Explain the fix", {
      model: "test-model",
      apiKey: "test-key",
      createMessage: fakeCreateMessage({ chapters }),
    });

    expect(result).toEqual(chapters);
  });

  it("rejects when the response is missing the chapters array", async () => {
    await expect(
      outline("Explain the fix", {
        model: "test-model",
        apiKey: "test-key",
        createMessage: fakeCreateMessage({}),
      }),
    ).rejects.toThrow(/chapters/);
  });

  it("rejects when a chapter is missing a title or summary", async () => {
    await expect(
      outline("Explain the fix", {
        model: "test-model",
        apiKey: "test-key",
        createMessage: fakeCreateMessage({
          chapters: [{ title: "Intro" /* missing summary */ }],
        }),
      }),
    ).rejects.toThrow(/title|summary/);
  });
});
