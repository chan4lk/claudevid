import { describe, expect, it } from "vitest";
import { generateSpec, GenerationFailedError } from "../src/generate.js";
import type { CreateStructuredMessageOptions } from "../src/anthropic-client.js";

const VALID_SPEC = {
  version: 1,
  scenes: [{ id: "s1", duration: 1, layers: [] }],
};

const baseOpts = { model: "claude-opus-4-8", apiKey: "test-key" };

describe("generateSpec", () => {
  it("resolves with the correct spec and attempts:2 after one repair round-trip", async () => {
    let calls = 0;
    const createMessage = async (_opts: CreateStructuredMessageOptions): Promise<unknown> => {
      calls++;
      if (calls === 1) {
        // missing required "scenes" field
        return { version: 1 };
      }
      return VALID_SPEC;
    };

    const result = await generateSpec("make a video", {
      ...baseOpts,
      systemPrompt: "system",
      createMessage,
    });

    expect(calls).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.spec.scenes).toHaveLength(1);
    expect(result.spec.scenes[0]?.id).toBe("s1");
  });

  it("rejects with only the last attempt's diagnostics when always invalid", async () => {
    let calls = 0;
    const createMessage = async (_opts: CreateStructuredMessageOptions): Promise<unknown> => {
      calls++;
      // Each attempt is invalid in a different way, so we can distinguish first vs last.
      if (calls === 1) {
        // missing "scenes" entirely
        return { version: 1 };
      }
      if (calls === 2) {
        // scenes present but missing required "id" on the scene
        return { version: 1, scenes: [{ duration: 1, layers: [] }] };
      }
      // final (3rd) attempt: scenes present but missing required "layers" on the scene
      return { version: 1, scenes: [{ id: "s1", duration: 1 }] };
    };

    await expect(
      generateSpec("make a video", {
        ...baseOpts,
        systemPrompt: "system",
        createMessage,
      }),
    ).rejects.toThrow(GenerationFailedError);

    expect(calls).toBe(3);

    // Re-run to inspect the thrown error's diagnostics directly.
    calls = 0;
    try {
      await generateSpec("make a video", {
        ...baseOpts,
        systemPrompt: "system",
        createMessage,
      });
      expect.unreachable("generateSpec should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GenerationFailedError);
      const failure = err as GenerationFailedError;
      // The last (3rd) attempt was missing "layers" on the scene — assert the diagnostics
      // reflect that failure, not the first attempt's "missing scenes" failure.
      const paths = failure.diagnostics.map((d) => d.path);
      expect(paths.some((p) => p.includes("layers"))).toBe(true);
      expect(paths.some((p) => p === "/scenes")).toBe(false);
    }
  });

  it("respects a custom repairAttempts count", async () => {
    let calls = 0;
    const createMessage = async (_opts: CreateStructuredMessageOptions): Promise<unknown> => {
      calls++;
      return { version: 1 };
    };

    await expect(
      generateSpec("make a video", {
        ...baseOpts,
        systemPrompt: "system",
        repairAttempts: 1,
        createMessage,
      }),
    ).rejects.toThrow(GenerationFailedError);

    expect(calls).toBe(1);
  });
});
