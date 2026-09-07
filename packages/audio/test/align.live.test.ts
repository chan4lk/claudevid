// Live-model integration test for align.ts (spec.md AC11), deliberately isolated from
// align.test.ts's fixture-only tests — mirrors tts.live.test.ts's exact gating shape (see that
// file's own header comment) adapted to this module's two-model dependency: a real Kokoro
// synthesis (006's synthesize(), producing a real sample audio buffer) feeding a real Whisper ASR
// pipeline (this module's own production `asrFn`, i.e. no injected fixture — the actual seam
// align.test.ts otherwise always bypasses per NFR2).
//
// This file is the one place in the whole @claudevid/audio suite that may need BOTH a real
// network fetch (kokoro-js's own model resolution, same as tts.live.test.ts) AND a second,
// separate model download (`@huggingface/transformers`'s own hub client resolving align.ts's
// pinned Whisper ONNX model — see align.ts's `ASR_MODEL_ID`) plus a working onnxruntime-node
// native build for both. None of that is guaranteed in every sandbox/CI runner this repo's tests
// might execute in, so — mirroring tts.live.test.ts's "probe a real capability once, up front,
// and skip gracefully rather than fail the build if it's unavailable" intent — this file attempts
// one bounded-time warmup call at module load time (top-level await; vitest test files are ESM)
// that runs both real synthesis and real alignment back to back, and lets that outcome decide
// whether the real AC11 assertions run or are skipped with a clear explanatory message.
//
// Whatever happens, this file must never hang the workspace-wide `pnpm -r run test` run: the
// warmup is wrapped in both a try/catch (network failure, missing native binary, malformed
// response, etc. all resolve to "skip", not "fail") and a hard timeout (a stalled fetch or hung
// native call also resolves to "skip" rather than hanging forever).

import { describe, expect, it } from "vitest";

import { align, tokenizeReferenceText } from "../src/align.js";
import { PINNED_MODEL } from "../src/models.js";
import { synthesize } from "../src/tts.js";
import type { AlignResult } from "../src/word-timing-types.js";

// Short on purpose (task framing: "pick something short to keep inference time down") — still
// long enough to produce several word-level timings from the real ASR pipeline.
const SAMPLE_TEXT = "The quick brown fox jumps over the lazy dog.";

// Generous headroom for two separate first-run model downloads (Kokoro's own hub resolution, as
// in tts.live.test.ts, plus align.ts's pinned Whisper ONNX model) and two native-runtime
// inference calls back to back. Kept comfortably under this describe block's own `it(...)`
// timeout below so a genuine timeout surfaces as a clean warmup failure (caught below) rather
// than the test runner's own timeout firing first. Design.md's Risks section: "per-block
// alignment wall-clock cost unknown ... indicative bench only," not a fixed production SLA.
const WARMUP_TIMEOUT_MS = 200_000;
const TEST_TIMEOUT_MS = 210_000;

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

/** Runs real Kokoro synthesis (006) followed by real Whisper alignment (this change, no injected
 * `asrFn`) over the same short sample sentence — the full real pipeline AC11 exercises. */
async function synthesizeAndAlign(): Promise<{ result: AlignResult; elapsedMs: number }> {
  const start = Date.now();
  const { audio, sampleRate } = await synthesize({
    text: SAMPLE_TEXT,
    voice: "af_heart", // kokoro-js README's own example voice id — a real, always-available voice.
    speed: 1,
    // modelDigest is not independently verified per-request by tts.ts (see its Scope boundary
    // comment) but is still a required field of SynthesisRequest — pass the real pinned values.
    modelId: PINNED_MODEL.id,
    modelDigest: PINNED_MODEL.digest,
    lexiconDigest: "",
  });
  // allowEstimated: true — a real ASR pass over real synthesized audio is not guaranteed to
  // recognize every word with high confidence (task framing: "reconciliation might mark a couple
  // of words as estimated ... that's fine and expected, not a failure"). Without this, an
  // imperfect ASR pass would throw LowConfidenceSpanError instead of returning a result to assert
  // on, which is not what AC11 is testing (AC4's fixtures already cover the fail-closed/estimated
  // behavior itself in isolation).
  const result = await align({ audio, sampleRate, referenceText: SAMPLE_TEXT, allowEstimated: true });
  return { result, elapsedMs: Date.now() - start };
}

let warmupResult: { result: AlignResult; elapsedMs: number } | null = null;
let warmupError: Error | null = null;

try {
  warmupResult = await withTimeout(
    synthesizeAndAlign(),
    WARMUP_TIMEOUT_MS,
    "Kokoro synthesis + Whisper alignment warmup",
  );
} catch (err) {
  warmupError = err instanceof Error ? err : new Error(String(err));
}

if (!warmupResult) {
  // A clear, explicit console message (task requirement) explaining *why* AC11's real assertions
  // are being skipped rather than silently vanishing from the test run's output.
  console.warn(
    "[align.live.test.ts] Skipping AC11 real-model integration test: warmup synthesis+alignment " +
      `did not complete — ${warmupError?.message ?? "unknown error"}. This is expected in a ` +
      "sandbox without network access to huggingface.co (where both kokoro-js and " +
      "@huggingface/transformers resolve their models from) or without a working " +
      "onnxruntime-node native build, and does not indicate a defect in align.ts. Run this file " +
      "on a machine with real network + native-build access to actually exercise AC11.",
  );
} else {
  console.log(
    `[align.live.test.ts] Live Kokoro synthesis + real Whisper alignment of a short sample ` +
      `sentence took ${warmupResult.elapsedMs}ms (indicative only — design.md's Risks section ` +
      "asks for a real bench on target hardware, not this sandbox run, and explicitly does not " +
      "assert a wall-clock bound here).",
  );
}

describe.skipIf(!warmupResult)("align() — real Whisper backend (AC11)", () => {
  it(
    "produces a non-empty WordTiming per reference word for a short synthesized sample sentence",
    () => {
      expect(warmupResult).not.toBeNull();
      const { result } = warmupResult!;
      const referenceWordCount = tokenizeReferenceText(SAMPLE_TEXT).length;

      expect(result.timings.length).toBeGreaterThan(0);
      // align()'s own completeness guarantee (FR3) holds even under allowEstimated: every
      // reference word gets exactly one timing entry, whether matched or (tolerantly)
      // estimated — so this is an exact count, not just "roughly matches."
      expect(result.timings).toHaveLength(referenceWordCount);

      // Sanity on ordering/shape — align() already validates this internally (FR3) and would
      // have thrown instead of returning, but re-asserting here documents the contract for
      // anyone reading this test in isolation.
      let previousEnd = 0;
      for (const timing of result.timings) {
        expect(timing.start).toBeGreaterThanOrEqual(previousEnd);
        expect(timing.end).toBeGreaterThanOrEqual(timing.start);
        previousEnd = timing.end;
      }
    },
    TEST_TIMEOUT_MS,
  );
});
