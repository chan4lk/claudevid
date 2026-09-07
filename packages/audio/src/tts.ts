// synthesize() — the FR2 injection seam (spec.md FR2, design.md's Technical Approach diagram
// and Risks section). In production this is backed by Kokoro (`kokoro-js`, running on
// `onnxruntime-node`); downstream code (cache.ts/durations.ts, not written yet) accepts a
// `synthesize`-shaped function as a parameter rather than importing this module directly, so
// every test except the gated live-model integration test (AC9, a later task's tts.live.test.ts)
// substitutes a fixture instead of loading Kokoro at all.
//
// Model resolution note (T4 follow-up): `request.modelId`/`request.modelDigest` are NOT wired to
// real model loading/verification here — that pinning/verification is FR6, owned by a later
// task's `models.ts`. For now this module always loads kokoro-js's own recommended default model
// via `KokoroTTS.from_pretrained`, ignoring those two fields entirely. `models.ts` will replace
// `DEFAULT_MODEL_ID` below with a call into its pinned-and-verified model path as a follow-up
// integration step.
//
// Output format note: `synthesize()` returns raw **16-bit signed PCM, little-endian, mono, no
// WAV/header framing** in `audio`, alongside the actual `sampleRate` Kokoro produced. This
// (rather than a self-describing WAV buffer) is a deliberate, non-obvious convention: it keeps
// the cache entry (FR4) and duration measurement (a later step, per design.md's diagram) both
// reducible to `audio.length / 2 / sampleRate` seconds — a plain byte-length arithmetic, no
// header to parse or strip first. Any later code that writes these bytes to disk as a `.wav` (or
// feeds them to FFmpeg) must add its own WAV header / tell FFmpeg the raw format explicitly.

import { KokoroTTS } from "kokoro-js";

import type { SynthesisRequest } from "./types.js";

/** kokoro-js's own documented recommended model id (see node_modules/kokoro-js/README.md's
 * usage example) — used as-is until `models.ts` (FR6) supplants this with the pinned,
 * digest-verified local model path. */
const DEFAULT_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Module-level lazy singleton (design.md's Risks section: isolate the native-runtime seam so
 * nothing outside this module ever needs a working `onnxruntime-node` build). Loaded at most
 * once per process, on the first call to `synthesize()` — never at import time, so importing
 * this module (e.g. from a test) never triggers a model download or native inference. */
let kokoroPromise: Promise<KokoroTTS> | null = null;

function loadKokoro(): Promise<KokoroTTS> {
  if (!kokoroPromise) {
    // `device: "cpu"` — this package runs under `onnxruntime-node`, not a browser, so neither
    // "wasm" nor "webgpu" (kokoro-js's other two device options) applies.
    kokoroPromise = KokoroTTS.from_pretrained(DEFAULT_MODEL_ID, { dtype: "fp32", device: "cpu" });
  }
  return kokoroPromise;
}

/** Converts Kokoro's `RawAudio.audio` (a `Float32Array` of samples in [-1, 1]) into the 16-bit
 * signed PCM little-endian `Buffer` this module returns (see the format note above). Exported
 * so it can be unit-tested directly, without loading Kokoro at all (NFR2). */
export function float32ToInt16PcmBuffer(samples: Float32Array): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    const intSample = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    buffer.writeInt16LE(intSample, i * 2);
  }
  return buffer;
}

/** Synthesizes `request.text` into audio via Kokoro (production backend for FR2's seam).
 * `request.voice` and `request.speed` map directly onto kokoro-js's `generate(text, { voice,
 * speed })` options; `request.modelId`/`request.modelDigest` are currently unused (see the T4
 * note above). */
export async function synthesize(request: SynthesisRequest): Promise<{ audio: Buffer; sampleRate: number }> {
  const tts = await loadKokoro();
  const rawAudio = await tts.generate(request.text, {
    voice: request.voice as Parameters<KokoroTTS["generate"]>[1] extends { voice?: infer V } ? V : never,
    speed: request.speed,
  });
  return {
    audio: float32ToInt16PcmBuffer(rawAudio.audio),
    sampleRate: rawAudio.sampling_rate,
  };
}
