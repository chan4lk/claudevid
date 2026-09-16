// `claudevid validate` tests (spec.md FR2/AC2). No filesystem access — `readFile` is an injected
// fake, following tools/motion-preview's dependency-injection test style (see test/config.test.ts).

import { describe, expect, it, vi } from "vitest";

import { runValidate } from "../src/commands/validate.js";
import type { resolveSceneAudioPaths as ResolveSceneAudioPaths } from "../src/scene-audio-paths.js";

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

  it("reports no narration-normalization line when every scene's narration is under the auto-split threshold (011 AC6)", () => {
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
    expect(result.message).not.toContain("normalized");
    expect(result.message).toBe("2 scenes, ~3s (1 auto-duration)");
  });

  it("reports the scene id and authored-vs-resolved block counts when narration is auto-split (011 AC5)", () => {
    const longSentence = "This is one sentence with several words in it to build up the count. ";
    const longNarration = longSentence.repeat(15); // well over MAX_SAFE_NARRATION_WORDS (90)

    const spec = JSON.stringify({
      version: 1,
      width: 1920,
      height: 1080,
      fps: 30,
      scenes: [{ id: "intro", duration: "auto", layers: [], narration: longNarration }],
    });

    const result = runValidate("spec.json", { readFile: () => spec });

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/scene "intro": narration normalized from 1 authored block to \d+ sub-blocks/);
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

  it("reports the FR6 diagnostics for a bad scene.audio.src and exits non-zero (AC7)", () => {
    const resolveSceneAudioPaths = vi.fn<typeof ResolveSceneAudioPaths>(() => ({
      ok: false,
      diagnostics: [{ path: "/scenes/0/audio/src", message: 'audio file not found: "missing.wav"' }],
    }));

    const result = runValidate("spec.json", { readFile: () => VALID_SPEC, resolveSceneAudioPaths });

    expect(result.ok).toBe(false);
    expect(result.sceneCount).toBe(0);
    expect(result.message).toContain("/scenes/0/audio/src");
    expect(result.message).toContain("not found");
  });

  it("is unaffected by resolveSceneAudioPaths for a spec without audio (AC7)", () => {
    const resolveSceneAudioPaths = vi.fn<typeof ResolveSceneAudioPaths>((spec) => ({ ok: true, spec }));

    const result = runValidate("spec.json", { readFile: () => VALID_SPEC, resolveSceneAudioPaths });

    expect(result.ok).toBe(true);
    expect(result.sceneCount).toBe(2);
    expect(resolveSceneAudioPaths).toHaveBeenCalledTimes(1);
  });

  it("passes --audio-root through to resolveSceneAudioPaths (FR8)", () => {
    const resolveSceneAudioPaths = vi.fn<typeof ResolveSceneAudioPaths>((spec) => ({ ok: true, spec }));

    runValidate("spec.json", { readFile: () => VALID_SPEC, resolveSceneAudioPaths }, { audioRoot: "/audio" });

    expect(resolveSceneAudioPaths.mock.calls[0]![1]).toMatchObject({ audioRoot: "/audio" });
  });
});
