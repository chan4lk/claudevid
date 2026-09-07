// Narrow, fast tests for tts.ts (spec.md FR2, NFR2). This file must never load the real Kokoro
// model or run real ONNX inference — that is the gated live-model integration tier (AC9), owned
// by a later task's isolated tts.live.test.ts (design.md's Architecture section), not this file.
//
// Importing `../src/tts.js` here is safe: `synthesize()` only loads Kokoro lazily, on its first
// *call* (see tts.ts's module-level `kokoroPromise` singleton) — module import alone never
// triggers a download or native inference. Neither test below calls `synthesize()`, so nothing
// here ever touches the network or a native onnxruntime build.

import { describe, expect, it } from "vitest";

import { float32ToInt16PcmBuffer, synthesize } from "../src/tts.js";

describe("synthesize (FR2 seam)", () => {
  it("is exported as an async function taking exactly one argument", () => {
    expect(typeof synthesize).toBe("function");
    expect(synthesize.length).toBe(1);
    // Calling it with no arguments (which we never do) would still return a Promise given its
    // declared arity — confirming it's an async function without invoking it for real.
    expect(synthesize.constructor.name).toBe("AsyncFunction");
  });
});

describe("float32ToInt16PcmBuffer (PCM conversion, no model required)", () => {
  it("converts an empty sample array to an empty buffer", () => {
    const buffer = float32ToInt16PcmBuffer(new Float32Array(0));
    expect(buffer.length).toBe(0);
  });

  it("maps [-1, 0, 1] to the expected 16-bit signed little-endian values", () => {
    const buffer = float32ToInt16PcmBuffer(new Float32Array([-1, 0, 1]));
    expect(buffer.length).toBe(6);
    expect(buffer.readInt16LE(0)).toBe(-32768); // -1 -> min int16
    expect(buffer.readInt16LE(2)).toBe(0); // 0 -> 0
    expect(buffer.readInt16LE(4)).toBe(32767); // 1 -> max int16
  });

  it("clamps out-of-range samples instead of overflowing/wrapping", () => {
    const buffer = float32ToInt16PcmBuffer(new Float32Array([-2, 2]));
    expect(buffer.readInt16LE(0)).toBe(-32768);
    expect(buffer.readInt16LE(2)).toBe(32767);
  });

  it("produces exactly 2 bytes per input sample (16-bit mono PCM)", () => {
    const samples = new Float32Array([0.1, -0.2, 0.3, -0.4, 0.5]);
    const buffer = float32ToInt16PcmBuffer(samples);
    expect(buffer.length).toBe(samples.length * 2);
  });
});
