// Live-Kokoro integration test for tts.ts (spec.md AC9), deliberately isolated from
// tts.test.ts's fixture-only tests (design.md's Architecture section: "tts.live.test.ts —
// isolated file, real Kokoro, gated/skippable like 005's pipe.live.test.ts precedent").
//
// This file is the one place in the whole @claudevid/audio suite that may need a real network
// fetch (kokoro-js's own model resolution against huggingface.co, via `KokoroTTS.from_pretrained`
// — see tts.ts's "Model resolution note (T4 follow-up)": that resolution is NOT yet wired to
// models.ts's pinned/verified path, so this genuinely hits the network the first time it runs)
// and a working onnxruntime-node native build. Neither is guaranteed in every sandbox/CI runner
// this repo's tests might execute in, so — mirroring pipe.live.test.ts's "probe a real capability
// once, up front, and skip gracefully rather than fail the build if it's unavailable" intent,
// adapted here from a synchronous binary/flag probe to this file's async/network shape — this
// file attempts one bounded-time warmup synthesis call at module load time (top-level await;
// vitest test files are ESM) and lets that outcome decide whether the real AC9 assertions run or
// are skipped with a clear explanatory message.
//
// Whatever happens, this file must never hang the workspace-wide `pnpm -r run test` run: the
// warmup is wrapped in both a try/catch (network failure, missing native binary, malformed
// response, etc. all resolve to "skip", not "fail") and a hard timeout (a stalled fetch or hung
// native call also resolves to "skip" rather than hanging forever).

import { describe, expect, it } from "vitest";

import { PINNED_MODEL } from "../src/models.js";
import { synthesize } from "../src/tts.js";

const SAMPLE_TEXT = "Hello world, this is a test.";

// Generous headroom for a first-run model download (design.md's Risks section: "per-block
// wall-clock cost unknown ... run an indicative bench"). Kept comfortably under this describe
// block's own `it(...)` timeout below so a genuine timeout surfaces as a clean warmup failure
// (caught below) rather than the test runner's own timeout firing first.
const WARMUP_TIMEOUT_MS = 110_000;
const TEST_TIMEOUT_MS = 120_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

let warmupResult: { audio: Buffer; sampleRate: number; elapsedMs: number } | null = null;
let warmupError: Error | null = null;

try {
  const start = Date.now();
  const result = await withTimeout(
    synthesize({
      text: SAMPLE_TEXT,
      voice: "af_heart", // kokoro-js README's own example voice id — a real, always-available voice.
      speed: 1,
      // modelDigest is not independently verified per-request by tts.ts (see its Scope boundary
      // comment: Kokoro's multi-file hub cache has no single byte sequence to check against a
      // pinned digest) but is still a required field of SynthesisRequest (FR3) — pass the real
      // pinned values. modelId IS the actual model tts.ts loads (PINNED_MODEL.id, single source
      // of truth, no separate DEFAULT_MODEL_ID constant).
      modelId: PINNED_MODEL.id,
      modelDigest: PINNED_MODEL.digest,
      lexiconDigest: "",
    }),
    WARMUP_TIMEOUT_MS,
    "Kokoro warmup synthesis",
  );
  warmupResult = { ...result, elapsedMs: Date.now() - start };
} catch (err) {
  warmupError = err instanceof Error ? err : new Error(String(err));
}

if (!warmupResult) {
  // A clear, explicit console message (task requirement) explaining *why* AC9's real assertions
  // are being skipped rather than silently vanishing from the test run's output.
  console.warn(
    "[tts.live.test.ts] Skipping AC9 real-Kokoro integration test: warmup synthesis did not " +
      `complete — ${warmupError?.message ?? "unknown error"}. This is expected in a sandbox ` +
      "without network access to huggingface.co (where kokoro-js resolves its model from) or " +
      "without a working onnxruntime-node native build, and does not indicate a defect in " +
      "tts.ts. Run this file on a machine with real network + native-build access to actually " +
      "exercise AC9.",
  );
} else {
  console.log(
    `[tts.live.test.ts] Live Kokoro warmup synthesis of a short sample sentence took ` +
      `${warmupResult.elapsedMs}ms (indicative only — design.md's Risks section asks for a real ` +
      "bench on target hardware, not this sandbox run).",
  );
}

describe.skipIf(!warmupResult)("synthesize() — real Kokoro backend (AC9)", () => {
  it(
    "produces non-empty audio and a positive sampleRate for a short sample sentence",
    () => {
      expect(warmupResult).not.toBeNull();
      expect(warmupResult!.audio).toBeInstanceOf(Buffer);
      expect(warmupResult!.audio.length).toBeGreaterThan(0);
      expect(warmupResult!.sampleRate).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );
});

// Lightweight, network-free sanity check on models.ts's pinning machinery (task requirement:
// "doesn't need to be tied to the live Kokoro call" — T4 already covered install/verify logic
// with fakes in models.test.ts). Runs unconditionally, independent of whether the warmup above
// succeeded.
describe("models.ts PINNED_MODEL.digest sanity (no network, no live model needed)", () => {
  it("looks like a syntactically valid 64-hex-character SHA-256 digest string", () => {
    expect(PINNED_MODEL.digest).toMatch(/^[0-9a-f]{64}$/i);
  });
});
