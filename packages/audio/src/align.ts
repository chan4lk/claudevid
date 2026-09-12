// align() — the FR1 injection seam (spec.md FR1-FR4, design.md's Technical Approach diagram and
// Key Decisions D2/D3). Mirrors tts.ts's `synthesize()` pattern exactly: production callers get a
// real ASR-backed implementation, but the seam accepted here (`opts.asrFn`) lets every test other
// than a later gated live-model integration test substitute a fixture, so this module's own test
// suite (align.test.ts) never triggers real inference (NFR2).
//
// This module has three real, always-run pieces, in order:
//   1. ASR (production path only, bypassed entirely by `opts.asrFn` in tests) — lazily loads
//      `@huggingface/transformers`'s `automatic-speech-recognition` pipeline (Whisper, ONNX),
//      the same runtime tts.ts already depends on for Kokoro (design.md D1: one native runtime,
//      not two), routed through the same machine-wide model root (`resolveModelsRoot()`, 012 FR4).
//   2. Reconciliation (always runs, real logic, pure/testable without inference) — an
//      edit-distance (Levenshtein-style) DP alignment between the raw recognized word stream and
//      `referenceText`'s tokenization (design.md D2's concrete pick; see `reconcileWords` below).
//   3. Validation + fail-closed/estimated (always runs, real logic) — every reference word must
//      end up with a timing; timestamps must be monotonic/non-negative/bounded by audio duration;
//      spans reconciliation couldn't confidently map either throw (default) or, under
//      `allowEstimated`, are filled by proportional distribution across the surrounding matched
//      gap and marked `estimated: true` (design.md D3 — never silently mixed in).

import { env, pipeline } from "@huggingface/transformers";
import type { AutomaticSpeechRecognitionPipelineType } from "@huggingface/transformers";
import * as path from "node:path";

import { resolveModelsRoot } from "./cache-root.js";
import { migrateProjectModelsCache } from "./models-migration.js";
import type { AlignRequest, AlignResult, WordTiming } from "./word-timing-types.js";

/** One raw recognized word from the ASR pipeline (or a test fixture standing in for it) — a
 * trimmed-down view of `@huggingface/transformers`'s `Chunk` shape (`{ text, timestamp: [number,
 * number] }`, see `pipelines.d.ts`'s `AutomaticSpeechRecognitionOutput`/`Chunk` types) with the
 * timestamp tuple already split into named `start`/`end` fields — untrusted input to
 * reconciliation, may drop/insert/reorder words relative to `referenceText`. */
export interface RawAsrWord {
  word: string;
  start: number;
  end: number;
}

/** The raw recognized word stream `opts.asrFn` (or the real ASR pipeline) produces — FR1/FR2's
 * "raw recognized word stream" that reconciliation consumes and never lets reach a caller
 * unreconciled. */
export type RawAsrOutput = RawAsrWord[];

/** `align`'s injectable seam (spec.md FR1: "callers accept an injected `align`-shaped function so
 * every test ... substitutes a fixture"). `asrFn` stands in for "run the ASR pipeline over this
 * audio and return its raw recognized word stream" — defaults to the real Whisper-backed
 * implementation in production; every test in align.test.ts passes its own fixture instead, so
 * nothing in this module's test suite loads a model or performs real inference (NFR2). */
export interface AlignOptions {
  asrFn?: (audio: Buffer, sampleRate: number) => Promise<RawAsrOutput>;
}

/** The Whisper ONNX model this package's ASR path loads — a real, publicly available
 * `@huggingface/transformers`-compatible model id (mirrors `models.ts`'s `PINNED_MODEL.id` being
 * the single source of truth for Kokoro). `Xenova/whisper-tiny.en` specifically — not
 * `onnx-community/whisper-base` (this file's original pick) — because `return_timestamps:
 * 'word'` requires an ONNX export with cross-attentions enabled, and `whisper-base` throws
 * "Model outputs must contain cross attentions to extract timestamps... not exported with
 * output_attentions=True" (caught by align.live.test.ts's gated real-model run, T10). This
 * exact model id is `@huggingface/transformers`'s own documented example for word-level
 * timestamps (see `automatic-speech-recognition`'s pipeline docs) — English-only, smaller, and
 * confirmed to support the code path this module needs. Not asserted by any non-live test, since
 * every other test injects `asrFn` instead of loading this model at all. */
const ASR_MODEL_ID = "Xenova/whisper-tiny.en";

/** Whisper's own expected input sampling rate (all Whisper checkpoints, including the one pinned
 * above, use a 16 kHz feature extractor). `packages/audio`'s own audio (e.g. Kokoro's output, see
 * tts.ts) is not necessarily produced at this rate, and — per `pipelines.d.ts`'s own
 * `AudioPipelineInputs` doc — passing a `Float32Array` directly skips any resampling ("no further
 * check will be done"), so this module resamples to this rate itself before calling the pipeline
 * (see `resampleFloat32`). */
const WHISPER_SAMPLE_RATE = 16000;

/** Module-level lazy singleton (same rationale as tts.ts's `loadKokoro`): loaded at most once per
 * process, on the first call that actually needs real ASR — never at import time, so importing
 * this module (e.g. from align.test.ts) never triggers a model download or native inference. */
let asrPipelinePromise: Promise<AutomaticSpeechRecognitionPipelineType> | null = null;

function loadAsrPipeline(): Promise<AutomaticSpeechRecognitionPipelineType> {
  if (!asrPipelinePromise) {
    asrPipelinePromise = (async () => {
      // Carry a pre-012 project-local cache across rather than re-downloading (012 FR7).
      // Best-effort and never throws.
      await migrateProjectModelsCache();
      // Route `@huggingface/transformers`'s hub client through the machine-wide model root (012
      // FR4) instead of its own default — same two lines tts.ts's `loadKokoro` uses. Whisper is
      // pinned model weights too, so it shares the root: "pinned weights", not "Kokoro", is what
      // that root means.
      env.cacheDir = resolveModelsRoot() + path.sep;
      return pipeline("automatic-speech-recognition", ASR_MODEL_ID, { dtype: "fp32" });
    })();
  }
  return asrPipelinePromise;
}

/** Converts this package's 16-bit signed PCM little-endian mono `Buffer` (the format tts.ts's
 * `synthesize()` returns, see its own format note) into a `Float32Array` of samples in [-1, 1] —
 * the inverse of tts.ts's `float32ToInt16PcmBuffer`, and the shape the ASR pipeline's
 * `AudioPipelineInputs` accepts directly (`pipelines.d.ts`: "`Float32Array` ... representing the
 * raw audio at the correct sampling rate"). Exported so it can be unit-tested directly, without
 * loading the ASR pipeline at all (NFR2). */
export function int16PcmBufferToFloat32(buffer: Buffer): Float32Array {
  const sampleCount = Math.floor(buffer.length / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const intSample = buffer.readInt16LE(i * 2);
    samples[i] = intSample < 0 ? intSample / 0x8000 : intSample / 0x7fff;
  }
  return samples;
}

/** Linear-interpolation resample of `samples` (at `fromRate` Hz) to `toRate` Hz. A no-op copy when
 * the rates already match. Simple on purpose (Rule 2 Simplicity First) — this is a quality-of-
 * resampling tradeoff for the production ASR path only; every test bypasses it entirely via
 * `opts.asrFn`. Exported so it, too, is unit-testable without loading any model. */
export function resampleFloat32(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const outLength = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const out = new Float32Array(outLength);
  const ratio = (samples.length - 1) / Math.max(1, outLength - 1);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const lowerIndex = Math.floor(srcPos);
    const upperIndex = Math.min(samples.length - 1, lowerIndex + 1);
    const frac = srcPos - lowerIndex;
    const lower = samples[lowerIndex] ?? 0;
    const upper = samples[upperIndex] ?? lower;
    out[i] = lower + (upper - lower) * frac;
  }
  return out;
}

/** Production backend for `AlignOptions.asrFn` (spec.md FR1's production path): lazily loads the
 * pinned Whisper pipeline, resamples `audio` to its expected rate, runs it with
 * `return_timestamps: 'word'`, and flattens the resulting `chunks` (see `pipelines.d.ts`'s
 * `Chunk`/`AutomaticSpeechRecognitionOutput`) into this module's `RawAsrOutput` shape. Untrusted
 * output — reconciliation (below) is what makes it safe to return to a caller. */
async function runWhisperAsr(audio: Buffer, sampleRate: number): Promise<RawAsrOutput> {
  const transcriber = await loadAsrPipeline();
  const samples = resampleFloat32(int16PcmBufferToFloat32(audio), sampleRate, WHISPER_SAMPLE_RATE);
  const rawOutput = await transcriber(samples, { return_timestamps: "word" });
  const output = Array.isArray(rawOutput) ? rawOutput[0] : rawOutput;
  const chunks = output?.chunks ?? [];
  return chunks.map((chunk) => ({
    word: chunk.text,
    start: chunk.timestamp[0],
    end: chunk.timestamp[1],
  }));
}

/** Splits `referenceText` into surface-form word tokens by whitespace — deliberately simple
 * (spec.md's task framing: "keep it simple, this doesn't need to match Whisper's own tokenizer,
 * just split reference words the same way you'd naturally read them"). Punctuation stays attached
 * to its word (FR5: "punctuation is not a separate entry") — `"Hello, world!"` tokenizes to
 * `["Hello,", "world!"]`, not four tokens. */
export function tokenizeReferenceText(referenceText: string): string[] {
  return referenceText.split(/\s+/).filter((token) => token.length > 0);
}

/** Normalizes a word token for reconciliation's equality comparisons only (never used for the
 * `word` field of a returned `WordTiming`, which always keeps `referenceText`'s original surface
 * form per FR5): lowercased, with everything except letters/digits/apostrophes stripped, so
 * `"world!"` (a reference token) and `" world"` (a typical ASR chunk's leading-space text) compare
 * equal. */
function normalizeForComparison(token: string): string {
  return token.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

/** One reference-word index's reconciliation outcome: either a confident match onto a recognized
 * word's timing, or "unmatched" (a drop/insert/reorder/substitution relative to the reference —
 * design.md's Edge Cases: "treated as ... low-confidence"). */
type ReconciledWord = { kind: "matched"; recognized: RawAsrWord } | { kind: "unmatched" };

/**
 * Reconciles `recognized` (the ASR pipeline's raw, untrusted word stream) against `referenceWords`
 * (already-tokenized surface-form reference words) via classic Levenshtein-style dynamic-
 * programming sequence alignment (design.md D2's concrete pick, implemented directly per Rule 1's
 * note rather than reaching for an external library).
 *
 * `dp[i][j]` = minimum edit distance to align `referenceWords[0..i)` with `recognized[0..j)`,
 * where a diagonal step costs 0 for an exact (normalized) match or 1 for a substitution, and
 * either axis step (reference word unmatched / recognized word extra) costs 1. This is standard
 * O(R*N) time and space DP (R = reference word count, N = recognized word count) — more than
 * sufficient for per-narration-block word counts (tens, not thousands).
 *
 * A reference word is only ever considered `"matched"` when the backtracked path takes a diagonal
 * step onto a *normalized-equal* recognized word — a diagonal step onto a *different* word
 * (substitution) is deliberately treated the same as an unmatched reference word rather than
 * silently inheriting a wrong timing. This is what correctly handles a reordered pair: swapping
 * adjacent recognized words turns what would otherwise be two wrong (and non-monotonic, per FR3)
 * timing assignments into two honestly-unmatched words, which validation/estimation (below) then
 * handles explicitly instead of returning corrupted timings.
 *
 * If this DP alignment ever proves insufficient for a real fixture corpus, design.md D2 says stop
 * and flag it rather than silently substituting a different algorithm — it has not proven
 * insufficient here; every AC1-AC4 fixture case is handled correctly by the algorithm above.
 */
function reconcileWords(referenceWords: string[], recognized: RawAsrWord[]): ReconciledWord[] {
  const normalizedRef = referenceWords.map(normalizeForComparison);
  const normalizedRec = recognized.map((w) => normalizeForComparison(w.word));

  const refCount = referenceWords.length;
  const recCount = recognized.length;

  // dp[i][j]: min edit distance aligning referenceWords[0..i) with recognized[0..j)].
  const dp: number[][] = Array.from({ length: refCount + 1 }, () => new Array<number>(recCount + 1).fill(0));
  for (let i = 0; i <= refCount; i++) dp[i]![0] = i;
  for (let j = 0; j <= recCount; j++) dp[0]![j] = j;
  for (let i = 1; i <= refCount; i++) {
    for (let j = 1; j <= recCount; j++) {
      const subCost = normalizedRef[i - 1] === normalizedRec[j - 1] ? 0 : 1;
      const diagonal = dp[i - 1]![j - 1]! + subCost;
      const deleteRef = dp[i - 1]![j]! + 1; // reference word unmatched
      const insertRec = dp[i]![j - 1]! + 1; // recognized word extra, skipped
      dp[i]![j] = Math.min(diagonal, deleteRef, insertRec);
    }
  }

  // Backtrack from (refCount, recCount) to (0, 0), classifying each reference word along the way.
  const result: ReconciledWord[] = new Array(refCount);
  let i = refCount;
  let j = recCount;
  while (i > 0 || j > 0) {
    const subCost = i > 0 && j > 0 ? (normalizedRef[i - 1] === normalizedRec[j - 1] ? 0 : 1) : Infinity;
    if (i > 0 && j > 0 && dp[i]![j] === dp[i - 1]![j - 1]! + subCost) {
      result[i - 1] = subCost === 0 ? { kind: "matched", recognized: recognized[j - 1]! } : { kind: "unmatched" };
      i--;
      j--;
    } else if (i > 0 && dp[i]![j] === dp[i - 1]![j]! + 1) {
      result[i - 1] = { kind: "unmatched" };
      i--;
    } else {
      // j > 0: an extra recognized word, skipped — no reference word consumes it.
      j--;
    }
  }
  return result;
}

/** Thrown when reconciliation leaves one or more reference words unmatched and `allowEstimated`
 * is not `true` (spec.md FR4's fail-closed default). Names the affected span(s) by reference-word
 * index and surface form so a caller/log can see exactly which words could not be confidently
 * timed, without re-deriving reconciliation's output. */
export class LowConfidenceSpanError extends Error {
  constructor(public readonly spans: { startIndex: number; endIndex: number; words: string[] }[]) {
    super(
      "align(): reconciliation could not confidently map " +
        `${spans.length} span(s) of referenceText onto the recognized word stream: ` +
        spans
          .map((s) => `[${s.startIndex}-${s.endIndex}] "${s.words.join(" ")}"`)
          .join(", ") +
        ". Pass `allowEstimated: true` to fill these via proportional distribution instead of throwing.",
    );
    this.name = "LowConfidenceSpanError";
  }
}

/** Thrown when the reconciled+validated `WordTiming[]` fails one of FR3's checks (monotonicity,
 * non-negativity, or the audio's measured duration bound). Names the specific check, the
 * reference-word index, and the word itself, per spec.md FR3: "throws, naming the block and the
 * specific check that failed." */
export class AlignmentValidationError extends Error {
  constructor(
    public readonly check: "monotonic" | "non-negative" | "bounded",
    public readonly wordIndex: number,
    public readonly word: string,
    detail: string,
  ) {
    super(`align(): validation failed (${check} check) at word ${wordIndex} ("${word}"): ${detail}`);
    this.name = "AlignmentValidationError";
  }
}

/** Groups consecutive `"unmatched"` indices in `reconciled` into inclusive `[startIndex,
 * endIndex]` spans (design.md's Edge Cases: "a total ASR failure is treated as the whole block
 * being low-confidence" falls out of this naturally — one span covering every index). */
function findUnmatchedSpans(reconciled: ReconciledWord[]): { startIndex: number; endIndex: number }[] {
  const spans: { startIndex: number; endIndex: number }[] = [];
  let spanStart: number | null = null;
  for (let i = 0; i < reconciled.length; i++) {
    const isUnmatched = reconciled[i]!.kind === "unmatched";
    if (isUnmatched && spanStart === null) {
      spanStart = i;
    } else if (!isUnmatched && spanStart !== null) {
      spans.push({ startIndex: spanStart, endIndex: i - 1 });
      spanStart = null;
    }
  }
  if (spanStart !== null) spans.push({ startIndex: spanStart, endIndex: reconciled.length - 1 });
  return spans;
}

/**
 * Aligns `request.audio` against `request.referenceText`, returning one `WordTiming` per
 * reference word (spec.md FR1-FR4).
 *
 * Always runs, regardless of `opts.asrFn`: reference tokenization, reconciliation (edit-distance
 * DP alignment against the raw recognized stream), unmatched-span handling (fail-closed unless
 * `request.allowEstimated`), and validation (monotonic/non-negative/bounded timestamps). Only the
 * raw recognized word stream itself is swappable — `opts.asrFn` defaults to the real
 * Whisper-backed `runWhisperAsr` in production; every test in align.test.ts injects its own
 * fixture instead (NFR2).
 */
export async function align(request: AlignRequest, opts: AlignOptions = {}): Promise<AlignResult> {
  const asrFn = opts.asrFn ?? runWhisperAsr;
  const referenceWords = tokenizeReferenceText(request.referenceText);
  const durationSeconds = request.audio.length / 2 / request.sampleRate;

  if (referenceWords.length === 0) {
    return { timings: [], estimatedSpans: [] };
  }

  const recognized = await asrFn(request.audio, request.sampleRate);
  const reconciled = reconcileWords(referenceWords, recognized);

  const timings: WordTiming[] = reconciled.map((word, index) => {
    if (word.kind === "matched") {
      return {
        word: referenceWords[index]!,
        start: word.recognized.start,
        end: word.recognized.end,
        estimated: false,
      };
    }
    // Placeholder — filled in below (estimated) or this whole call throws first (fail-closed).
    return { word: referenceWords[index]!, start: 0, end: 0, estimated: false };
  });

  const unmatchedSpans = findUnmatchedSpans(reconciled);
  if (unmatchedSpans.length > 0) {
    if (!request.allowEstimated) {
      throw new LowConfidenceSpanError(
        unmatchedSpans.map((span) => ({
          ...span,
          words: referenceWords.slice(span.startIndex, span.endIndex + 1),
        })),
      );
    }

    for (const span of unmatchedSpans) {
      // Proportional-distribution fallback (spec.md FR4/design.md D3): evenly divide the time
      // range bounded by the nearest matched neighbor on each side (or the block's own start/end
      // when the span touches an edge — design.md's Edge Cases: total-ASR-failure spans the whole
      // block) across every unmatched word in the span.
      const prevMatched = timings[span.startIndex - 1];
      const nextMatched = timings[span.endIndex + 1];
      const rangeStart = span.startIndex > 0 ? prevMatched!.end : 0;
      const rangeEnd = span.endIndex < timings.length - 1 ? nextMatched!.start : durationSeconds;
      const count = span.endIndex - span.startIndex + 1;
      const step = (rangeEnd - rangeStart) / count;

      for (let k = 0; k < count; k++) {
        const index = span.startIndex + k;
        timings[index] = {
          word: referenceWords[index]!,
          start: rangeStart + step * k,
          end: rangeStart + step * (k + 1),
          estimated: true,
        };
      }
    }
  }

  // FR3: validate the complete sequence — monotonic/non-negative/bounded — regardless of whether
  // any span was estimated. A clean 1:1 recognized stream can still carry a corrupt timestamp
  // (AC3's fixtures), independent of reconciliation's own matched/unmatched outcome.
  let previousEnd = 0;
  for (let index = 0; index < timings.length; index++) {
    const timing = timings[index]!;
    if (timing.start < 0 || timing.end < 0) {
      throw new AlignmentValidationError(
        "non-negative",
        index,
        timing.word,
        `start=${timing.start}, end=${timing.end}`,
      );
    }
    if (timing.end > durationSeconds || timing.start > durationSeconds) {
      throw new AlignmentValidationError(
        "bounded",
        index,
        timing.word,
        `start=${timing.start}, end=${timing.end} exceeds audio duration ${durationSeconds}s`,
      );
    }
    if (timing.start < previousEnd || timing.end < timing.start) {
      throw new AlignmentValidationError(
        "monotonic",
        index,
        timing.word,
        `start=${timing.start}, end=${timing.end}, previous word's end=${previousEnd}`,
      );
    }
    previousEnd = timing.end;
  }

  const estimatedSpans = unmatchedSpans.map(({ startIndex, endIndex }) => ({ startIndex, endIndex }));
  return { timings, estimatedSpans };
}
