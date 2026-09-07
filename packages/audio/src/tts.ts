// synthesize() — the FR2 injection seam (spec.md FR2, design.md's Technical Approach diagram
// and Risks section). In production this is backed by Kokoro (`kokoro-js`, running on
// `onnxruntime-node`); downstream code (cache.ts/durations.ts, not written yet) accepts a
// `synthesize`-shaped function as a parameter rather than importing this module directly, so
// every test except the gated live-model integration test (AC9, a later task's tts.live.test.ts)
// substitutes a fixture instead of loading Kokoro at all.
//
// Model resolution (spec.md FR6, design.md D2/D5): the model id loaded here is `models.ts`'s
// `PINNED_MODEL.id` — the single committed source of truth for "which model" — and the
// underlying `@huggingface/transformers` runtime's cache directory is pointed at this package's
// shared cache root (`resolveCacheSubdir("models")`, the same helper `models.ts` uses), so a
// Kokoro download lands in the project's own cache, not an arbitrary OS-level HF cache, and is
// reused (no re-download) on every subsequent call — this is what makes D2's "one cache root"
// hold for Kokoro's own downloads too, not just `models.ts`'s standalone install/verify path.
//
// Scope boundary, stated plainly: `@huggingface/transformers`'s own hub client manages a
// multi-file cache tree (config, tokenizer, ONNX weight shards) for a model id, which has no
// single byte sequence to check against `PINNED_MODEL.digest`. `models.ts`'s `installModels`/
// `verifyInstalledModel` remain real, tested, single-file digest verification primitives, but
// this module does not (and cannot, without replacing transformers.js's hub client) call them
// per-load against Kokoro's own multi-file download. Digest-verified installation as tested in
// models.test.ts applies to an explicit single-file fetch scenario, not to Kokoro's own resolver.

import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import * as path from "node:path";

import { resolveCacheSubdir } from "./cache-root.js";
import { PINNED_MODEL } from "./models.js";
import type { SynthesisRequest } from "./types.js";

/** Module-level lazy singleton (design.md's Risks section: isolate the native-runtime seam so
 * nothing outside this module ever needs a working `onnxruntime-node` build). Loaded at most
 * once per process, on the first call to `synthesize()` — never at import time, so importing
 * this module (e.g. from a test) never triggers a model download or native inference. */
let kokoroPromise: Promise<KokoroTTS> | null = null;

function loadKokoro(): Promise<KokoroTTS> {
  if (!kokoroPromise) {
    // Route `@huggingface/transformers`'s hub client through this package's shared cache root
    // (design.md D2) instead of its own default `./.cache` — set once, before the first load.
    env.cacheDir = resolveCacheSubdir("models") + path.sep;
    // `device: "cpu"` — this package runs under `onnxruntime-node`, not a browser, so neither
    // "wasm" nor "webgpu" (kokoro-js's other two device options) applies.
    kokoroPromise = KokoroTTS.from_pretrained(PINNED_MODEL.id, { dtype: "fp32", device: "cpu" });
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
