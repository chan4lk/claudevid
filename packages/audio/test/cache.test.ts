// Tests for cache.ts (spec.md FR4, AC3, AC4, AC5, AC6). Every test injects a fake
// `synthesizeFn` — never tts.ts's real `synthesize()` — so nothing here triggers real Kokoro
// inference (NFR2), and every test passes an explicit `projectRoot` under a fresh `os.tmpdir()`
// directory, so nothing here touches this repo's real `.claudevid/cache/` (same isolation
// pattern as cache-root.test.ts/models.test.ts's explicit `projectRoot` override).

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getOrSynthesize, hashSynthesisRequest, resolveCacheEntryPath } from "../src/cache.js";
import type { SynthesisRequest } from "../src/types.js";

/** Builds a fake `synthesizeFn` (the FR2 injection seam) that returns a fixed, small
 * Float32-derived PCM buffer and records how many times — and with which requests — it was
 * called, so tests can assert on cache-hit/miss behavior via call count (AC3, AC4, AC5) instead
 * of any real inference. */
function fakeSynthesizeFn(samples: number[], sampleRate = 100) {
  const calls: SynthesisRequest[] = [];
  const audio = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) audio.writeInt16LE(samples[i]!, i * 2);

  const fn = vi.fn(async (req: SynthesisRequest) => {
    calls.push(req);
    return { audio, sampleRate };
  });
  return { fn, calls };
}

function baseRequest(overrides?: Partial<SynthesisRequest>): SynthesisRequest {
  return {
    text: "hello world",
    voice: "af_heart",
    speed: 1,
    modelId: "test-model",
    modelDigest: "a".repeat(64),
    ...overrides,
  };
}

describe("cache.ts (FR4)", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claudevid-cache-test-"));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("computes durationSeconds as audio.length / 2 / sampleRate on a cache miss (16-bit mono PCM)", async () => {
    const { fn } = fakeSynthesizeFn([0, 100, -100, 200], 100); // 4 samples * 2 bytes = 8 bytes
    const request = baseRequest();

    const result = await getOrSynthesize(request, fn, { projectRoot });

    expect(result.durationSeconds).toBeCloseTo(8 / 2 / 100, 10);
    expect(result.audio.length).toBe(8);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("AC3: a second call with an identical request is a cache hit — no second call to synthesizeFn", async () => {
    const { fn } = fakeSynthesizeFn([1, 2, 3, 4], 8000);
    const request = baseRequest();

    const first = await getOrSynthesize(request, fn, { projectRoot });
    const second = await getOrSynthesize({ ...request }, fn, { projectRoot }); // fresh object, same values

    expect(fn).toHaveBeenCalledTimes(1);
    expect(second.durationSeconds).toBe(first.durationSeconds);
    expect(second.audio.equals(first.audio)).toBe(true);
  });

  it("AC3: writes exactly one cache file for one request synthesized twice", async () => {
    const { fn } = fakeSynthesizeFn([1, 2], 8000);
    const request = baseRequest();

    await getOrSynthesize(request, fn, { projectRoot });
    await getOrSynthesize(request, fn, { projectRoot });

    const entryPath = resolveCacheEntryPath(request, projectRoot);
    const stat = await fs.stat(entryPath);
    expect(stat.isFile()).toBe(true);
  });

  it("AC4: a different `speed` produces a different cache key and a fresh synthesizeFn call", async () => {
    const { fn } = fakeSynthesizeFn([9, 9, 9], 8000);
    const requestA = baseRequest({ speed: 1 });
    const requestB = baseRequest({ speed: 1.25 });

    expect(hashSynthesisRequest(requestA)).not.toBe(hashSynthesisRequest(requestB));

    await getOrSynthesize(requestA, fn, { projectRoot });
    await getOrSynthesize(requestB, fn, { projectRoot });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("AC4: a different `modelDigest` produces a different cache key and a fresh synthesizeFn call", async () => {
    const { fn } = fakeSynthesizeFn([9, 9, 9], 8000);
    const requestA = baseRequest({ modelDigest: "a".repeat(64) });
    const requestB = baseRequest({ modelDigest: "b".repeat(64) });

    expect(hashSynthesisRequest(requestA)).not.toBe(hashSynthesisRequest(requestB));

    await getOrSynthesize(requestA, fn, { projectRoot });
    await getOrSynthesize(requestB, fn, { projectRoot });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("AC4: key order in the caller's object literal never changes the hash (canonical ordering)", () => {
    const inOrder: SynthesisRequest = {
      text: "hi",
      voice: "v",
      speed: 1,
      modelId: "m",
      modelDigest: "d",
    };
    const reordered: SynthesisRequest = {
      modelDigest: "d",
      modelId: "m",
      speed: 1,
      voice: "v",
      text: "hi",
    };

    expect(hashSynthesisRequest(inOrder)).toBe(hashSynthesisRequest(reordered));
  });

  it("AC5: editing one narration block's text re-synthesizes only that block — the other's cache entry is untouched", async () => {
    const { fn: fnA, calls: callsA } = fakeSynthesizeFn([1, 1], 8000);
    const { fn: fnB, calls: callsB } = fakeSynthesizeFn([2, 2], 8000);

    const blockA = baseRequest({ text: "block a, version 1" });
    const blockB = baseRequest({ text: "block b, unchanged" });

    // Initial synthesis of both blocks.
    const firstA = await getOrSynthesize(blockA, fnA, { projectRoot });
    const firstB = await getOrSynthesize(blockB, fnB, { projectRoot });
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);

    // Edit block A's text only; re-request both.
    const editedBlockA = baseRequest({ text: "block a, version 2 (edited)" });
    const secondA = await getOrSynthesize(editedBlockA, fnA, { projectRoot });
    const secondB = await getOrSynthesize(blockB, fnB, { projectRoot });

    // Block A: text changed -> a genuine second synthesizeFn call for the new key.
    expect(fnA).toHaveBeenCalledTimes(2);
    expect(callsA.map((c) => c.text)).toEqual(["block a, version 1", "block a, version 2 (edited)"]);
    expect(secondA.audio.equals(firstA.audio)).toBe(true); // same fixture audio, different cache entries

    // Block B: unchanged request -> still a single call total (cache hit on the second lookup).
    expect(fnB).toHaveBeenCalledTimes(1);
    expect(callsB).toHaveLength(1);
    expect(secondB.durationSeconds).toBe(firstB.durationSeconds);
    expect(secondB.audio.equals(firstB.audio)).toBe(true);
  });

  it("AC6: a corrupted cache file (simulating an interrupted write) is treated as a cache miss, not corrupted audio", async () => {
    const request = baseRequest({ text: "AC6 corrupted-entry case" });
    const entryPath = resolveCacheEntryPath(request, projectRoot);

    // Simulate a write that was interrupted before completing cleanly (e.g. crash mid-write, or
    // a rename that landed a truncated/garbage file) — deliberately place invalid JSON at the
    // exact final path a real write would have renamed into (mirrors models.test.ts's
    // "deliberately corrupted local cache file" AC10 pattern).
    await fs.mkdir(path.dirname(entryPath), { recursive: true });
    await fs.writeFile(entryPath, "{ not valid json, truncated mid-wri");

    const { fn } = fakeSynthesizeFn([3, 3, 3, 3], 8000);
    const result = await getOrSynthesize(request, fn, { projectRoot });

    // Treated as a miss: synthesizeFn was called (not skipped), and the result is the freshly
    // synthesized audio, not an attempt to parse the corrupted bytes.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.audio.length).toBe(8);

    // The corrupted file has now been atomically replaced by a valid entry.
    const raw = await fs.readFile(entryPath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("AC6: a cache file with valid JSON but the wrong shape is treated as a cache miss", async () => {
    const request = baseRequest({ text: "AC6 wrong-shape case" });
    const entryPath = resolveCacheEntryPath(request, projectRoot);

    await fs.mkdir(path.dirname(entryPath), { recursive: true });
    await fs.writeFile(entryPath, JSON.stringify({ unexpected: "shape" }));

    const { fn } = fakeSynthesizeFn([4, 4], 8000);
    const result = await getOrSynthesize(request, fn, { projectRoot });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.audio.length).toBe(4);
  });

  it("AC6: a leftover temp file (as if a crash happened before rename) is never picked up as a cache entry", async () => {
    const request = baseRequest({ text: "AC6 leftover-temp-file case" });
    const entryPath = resolveCacheEntryPath(request, projectRoot);

    // Simulate the state right after a crash between "write temp file" and "rename": the temp
    // file exists, but the final path does not.
    await fs.mkdir(path.dirname(entryPath), { recursive: true });
    const leftoverTempPath = `${entryPath}.99999.123456.tmp`;
    await fs.writeFile(leftoverTempPath, JSON.stringify({ durationSeconds: 999, audioBase64: "not-real" }));

    const { fn } = fakeSynthesizeFn([5, 5, 5], 8000);
    const result = await getOrSynthesize(request, fn, { projectRoot });

    // The leftover temp file must never be read as if it were the cache entry.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.durationSeconds).not.toBe(999);
    expect(result.audio.length).toBe(6);
  });
});
