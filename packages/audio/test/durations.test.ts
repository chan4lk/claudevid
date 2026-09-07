// Tests for durations.ts (spec.md FR5, AC7, AC8, Edge Cases: "narration array is empty on an auto
// scene"). Every test injects a fake `synthesizeFn` — never tts.ts's real `synthesize()` — so
// nothing here triggers real Kokoro inference (NFR2), and every test passes an explicit
// `projectRoot` under a fresh `os.tmpdir()` directory (same isolation pattern as cache.test.ts),
// so nothing here touches this repo's real `.claudevid/cache/`.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { VideoSpec } from "@claudevid/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  computeAudioDurations,
  EmptyNarrationError,
  MaxDurationExceededError,
} from "../src/durations.js";
import type { SynthesisRequest } from "../src/types.js";

/** Builds a fake `synthesizeFn` that returns fixed-length PCM audio for every request — same
 * shape/intent as cache.test.ts's `fakeSynthesizeFn`, sized here so that `samplesPerBlock` at
 * `sampleRate` produces a known, easy-to-assert-on `durationSeconds` (samplesPerBlock / sampleRate
 * seconds per block, since duration = audio.length / 2 / sampleRate and audio.length = samples * 2). */
function fakeSynthesizeFn(samplesPerBlock: number, sampleRate = 100) {
  const audio = Buffer.alloc(samplesPerBlock * 2); // all-zero samples; only the length matters
  const fn = vi.fn(async (_req: SynthesisRequest) => ({ audio, sampleRate }));
  return fn;
}

function baseSpec(scenes: VideoSpec["scenes"]): VideoSpec {
  return {
    version: 1,
    width: 1920,
    height: 1080,
    fps: 30,
    scenes,
  };
}

describe("durations.ts (FR5)", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claudevid-durations-test-"));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("AC7: returns a duration for every 'auto' scene, computed from the fixture's audio length plus padding", async () => {
    const fn = fakeSynthesizeFn(100, 100); // 100 samples @ 100/sec = 1 second per block
    const spec = baseSpec([
      {
        id: "scene-1",
        duration: "auto",
        layers: [],
        narration: [{ text: "block a" }, { text: "block b" }],
      },
      {
        id: "scene-2",
        duration: "auto",
        layers: [],
        narration: [{ text: "solo block" }],
      },
    ]);

    const result = await computeAudioDurations(spec, {
      synthesizeFn: fn,
      projectRoot,
      headPaddingSeconds: 0.5,
      tailPaddingSeconds: 0.25,
    });

    // scene-1: 2 blocks * 1s each + 0.75s padding = 2.75s
    expect(result["scene-1"]).toBeCloseTo(2.75, 10);
    // scene-2: 1 block * 1s + 0.75s padding = 1.75s
    expect(result["scene-2"]).toBeCloseTo(1.75, 10);
    expect(Object.keys(result).sort()).toEqual(["scene-1", "scene-2"]);
  });

  it("absent from the returned record: a scene with a numeric duration is never included", async () => {
    const fn = fakeSynthesizeFn(100, 100);
    const spec = baseSpec([
      { id: "fixed-scene", duration: 5, layers: [] },
      { id: "auto-scene", duration: "auto", layers: [], narration: [{ text: "hi" }] },
    ]);

    const result = await computeAudioDurations(spec, { synthesizeFn: fn, projectRoot });

    expect(Object.prototype.hasOwnProperty.call(result, "fixed-scene")).toBe(false);
    expect(result["auto-scene"]).toBeCloseTo(1, 10);
  });

  it("AC8 (floor direction): a computed total below minDurationSeconds is silently raised to the minimum", async () => {
    const fn = fakeSynthesizeFn(10, 100); // 10 samples @ 100/sec = 0.1s per block
    const spec = baseSpec([{ id: "short-scene", duration: "auto", layers: [], narration: [{ text: "hi" }] }]);

    const result = await computeAudioDurations(spec, {
      synthesizeFn: fn,
      projectRoot,
      minDurationSeconds: 3,
    });

    expect(result["short-scene"]).toBe(3);
  });

  it("AC8 (ceiling direction): a computed total above maxDurationSeconds throws, naming the scene id and computed value", async () => {
    const fn = fakeSynthesizeFn(1000, 100); // 1000 samples @ 100/sec = 10s per block
    const spec = baseSpec([{ id: "long-scene", duration: "auto", layers: [], narration: [{ text: "hi" }] }]);

    await expect(
      computeAudioDurations(spec, { synthesizeFn: fn, projectRoot, maxDurationSeconds: 5 }),
    ).rejects.toThrow(MaxDurationExceededError);

    try {
      await computeAudioDurations(spec, { synthesizeFn: fn, projectRoot, maxDurationSeconds: 5 });
      expect.unreachable("expected computeAudioDurations to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MaxDurationExceededError);
      const typed = err as MaxDurationExceededError;
      expect(typed.sceneId).toBe("long-scene");
      expect(typed.computedSeconds).toBeCloseTo(10, 10);
      expect(typed.maxDurationSeconds).toBe(5);
      expect(typed.message).toContain("long-scene");
      expect(typed.message).toContain("10");
    }
  });

  it("does not silently clamp on the ceiling even when the scene would also be below the floor without padding", async () => {
    // Guards against an implementation that checks min before max (or vice versa) incorrectly —
    // a total that exceeds max must throw regardless of where minDurationSeconds is set.
    const fn = fakeSynthesizeFn(1000, 100); // 10s per block
    const spec = baseSpec([{ id: "over-max", duration: "auto", layers: [], narration: [{ text: "hi" }] }]);

    await expect(
      computeAudioDurations(spec, {
        synthesizeFn: fn,
        projectRoot,
        minDurationSeconds: 0,
        maxDurationSeconds: 5,
      }),
    ).rejects.toThrow(MaxDurationExceededError);
  });

  it("edge case: an 'auto' scene with narration entirely absent throws, naming the scene id", async () => {
    const fn = fakeSynthesizeFn(100, 100);
    const spec = baseSpec([{ id: "no-narration-field", duration: "auto", layers: [] }]);

    await expect(computeAudioDurations(spec, { synthesizeFn: fn, projectRoot })).rejects.toThrow(
      EmptyNarrationError,
    );
    await expect(computeAudioDurations(spec, { synthesizeFn: fn, projectRoot })).rejects.toThrow(
      /no-narration-field/,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it("edge case: an 'auto' scene with an empty narration array throws, naming the scene id", async () => {
    const fn = fakeSynthesizeFn(100, 100);
    const spec = baseSpec([{ id: "empty-narration-array", duration: "auto", layers: [], narration: [] }]);

    await expect(computeAudioDurations(spec, { synthesizeFn: fn, projectRoot })).rejects.toThrow(
      EmptyNarrationError,
    );
    await expect(computeAudioDurations(spec, { synthesizeFn: fn, projectRoot })).rejects.toThrow(
      /empty-narration-array/,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it("resolves per-block voice/speed, falling back to opts defaults and then the hardcoded fallback", async () => {
    const fn = fakeSynthesizeFn(100, 100);
    const spec = baseSpec([
      {
        id: "voice-scene",
        duration: "auto",
        layers: [],
        narration: [
          { text: "explicit voice/speed", voice: "custom-voice", speed: 1.5 },
          { text: "spec-level default voice/speed" },
        ],
      },
    ]);

    await computeAudioDurations(spec, {
      synthesizeFn: fn,
      projectRoot,
      defaultVoice: "spec-default-voice",
      defaultSpeed: 0.9,
    });

    const calls = fn.mock.calls.map(([req]) => req);
    const explicit = calls.find((c) => c.text === "explicit voice/speed")!;
    const defaulted = calls.find((c) => c.text === "spec-level default voice/speed")!;

    expect(explicit.voice).toBe("custom-voice");
    expect(explicit.speed).toBe(1.5);
    expect(defaulted.voice).toBe("spec-default-voice");
    expect(defaulted.speed).toBe(0.9);
  });

  it("two scenes with byte-identical narration reuse the same cache entry (only one synthesizeFn call for shared text/voice/speed)", async () => {
    const fn = fakeSynthesizeFn(100, 100);
    const spec = baseSpec([
      { id: "scene-a", duration: "auto", layers: [], narration: [{ text: "shared line" }] },
      { id: "scene-b", duration: "auto", layers: [], narration: [{ text: "shared line" }] },
    ]);

    const result = await computeAudioDurations(spec, { synthesizeFn: fn, projectRoot });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result["scene-a"]).toBeCloseTo(result["scene-b"]!, 10);
  });
});
