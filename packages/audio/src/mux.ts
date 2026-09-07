// Distinct-path mux with temp+rename discipline and a duration-tolerance check (spec.md FR8,
// AC8, design.md's Technical Approach / Key Decision D5). This is the one place in `packages/
// audio` that actually spawns FFmpeg (graph.ts only ever builds argv, it never runs anything) —
// `mux.ts` owns the FFmpeg-invocation/exit-code/atomic-write lifecycle, mirroring `packages/
// encoder-ffmpeg/src/pipe.ts`'s own spawn/exit-code/stderr-tail handling rather than inventing a
// second convention for it in this package.
//
// Design decision (explicitly called out per this task's brief): TWO separate FFmpeg invocations,
// not one filter-graph-plus-mux pass. Reasoning:
//   1. `graph.ts`'s `buildAudioGraphArgv` already owns the *entire* filter-graph string (its own
//      header comment: "the sole owner of the filter-graph string it builds"). Folding the silent
//      video in as a third input to that same invocation would mean either (a) growing
//      `buildAudioGraphArgv` to also understand a non-audio input and a `-map`/`-c:v copy` output
//      stanza it has no other reason to know about, violating its single-purpose contract, or
//      (b) duplicating the filter-graph construction here in `mux.ts` — both worse than what we
//      have.
//   2. A failure at the composition stage (bad filter graph, missing track file) vs. a failure at
//      the mux stage (bad video, codec mismatch) are different failure modes worth distinguishing
//      in `stderrTail`/error messages; two invocations means two distinct, smaller stderr tails
//      to inspect rather than one large interleaved one.
//   3. Simplicity First (Rule 2): the two-step version is exactly two `spawn`+wait-for-exit calls
//      using the same helper, with an intermediate temp audio file connecting them. A one-pass
//      version would need `buildAudioGraphArgv` (or a variant of it) to accept a non-audio input
//      and emit a `-map [out] -map <videoIndex>:v -c:v copy -c:a aac -shortest` tail — strictly
//      more surface for a first cut with no measured performance need to justify it (the
//      intermediate file is a lossless PCM WAV, not a lossy re-encode, so no quality is lost to
//      the extra pass).
//
// Concretely: step 1 runs `opts.audioGraphArgv` (verbatim, from `graph.ts`'s `buildAudioGraphArgv`
// — this module appends ZERO filter-graph flags of its own, same single-owner discipline `pipe.ts`
// documents for `argv.ts`'s `buildArgv`) plus an output codec/path tail, rendering the composed
// audio graph to a temp WAV file. Step 2 runs `-i <silentVideoPath> -i <tempAudioPath> -c:v copy
// -c:a aac -shortest <tempOutputPath>`. Only after step 2 exits 0 AND the duration-tolerance check
// (below) passes does `tempOutputPath` get renamed to `opts.outputPath`.
//
// Atomic-write discipline mirrors `models.ts`/`cache.ts` exactly: every FFmpeg-written file lands
// at a `.tmp`-suffixed path first; `fs.rename` (same filesystem, same directory) is the one atomic
// operation that makes it visible at its real path; any failure along the way (non-zero exit,
// duration mismatch) deletes every temp file it created before throwing — a reader of
// `opts.outputPath` never observes a partial file, and `opts.silentVideoPath` is never touched.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Bounds how much of FFmpeg's stderr `MuxError` carries — mirrors `pipe.ts`'s
 * `STDERR_TAIL_LINES` (same rationale: enough to show the real error past FFmpeg's banner,
 * bounded so a pathological error flood can't balloon memory). */
const STDERR_TAIL_LINES = 20;

/** Default duration-tolerance (spec.md FR8's "a stated tolerance," tasks.md T8's "e.g. 50ms"). */
const DEFAULT_DURATION_TOLERANCE_SECONDS = 0.05;

/** Thrown when `opts.outputPath` already exists and `opts.force` was not set (spec.md FR8:
 * "refuses to overwrite an existing output unless explicitly forced"). Names the exact path so a
 * caller/log doesn't have to re-derive which of the two files involved was the problem. */
export class MuxOutputExistsError extends Error {
  constructor(public readonly outputPath: string) {
    super(
      `Refusing to overwrite existing file at "${outputPath}" — pass { force: true } to ` +
        "muxOutput() to overwrite it explicitly.",
    );
    this.name = "MuxOutputExistsError";
  }
}

/** Thrown when `opts.outputPath` resolves to the same path as `opts.silentVideoPath` (spec.md
 * FR8: "never overwrites 005's silent encode in place") — checked before any FFmpeg process is
 * spawned, so this never depends on filesystem timing to catch. */
export class MuxSamePathError extends Error {
  constructor(public readonly path: string) {
    super(
      `outputPath and silentVideoPath must be distinct paths; both resolved to "${path}". ` +
        "muxOutput() never overwrites the silent video input in place.",
    );
    this.name = "MuxSamePathError";
  }
}

/** Thrown on a non-zero exit from either the audio-composition or the video+audio mux FFmpeg
 * invocation (spec.md FR8). Carries which `stage` failed, the exit code, and the last
 * `STDERR_TAIL_LINES` lines of that invocation's stderr — mirrors `encoder-ffmpeg`'s
 * `EncodeError` shape/rationale exactly. */
export class MuxError extends Error {
  readonly stage: "compose-audio" | "mux";
  readonly exitCode: number | null;
  readonly stderrTail: string[];

  constructor(stage: "compose-audio" | "mux", exitCode: number | null, stderrTail: string[]) {
    const firstLine = stderrTail[0];
    super(
      `ffmpeg (${stage} stage) exited with code ${exitCode}` + (firstLine ? `: ${firstLine}` : ""),
    );
    this.name = "MuxError";
    this.stage = stage;
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

/** Thrown when the muxed output's measured duration disagrees with the silent video input's
 * measured duration by more than `durationToleranceSeconds` (spec.md FR8/AC8: "asserts audio/
 * video duration agreement within a stated tolerance, failing with both numbers on mismatch").
 * Names both durations and the tolerance so a caller/log never has to re-probe either file to
 * understand the failure. */
export class MuxDurationMismatchError extends Error {
  constructor(
    public readonly silentVideoDurationSeconds: number,
    public readonly outputDurationSeconds: number,
    public readonly toleranceSeconds: number,
  ) {
    super(
      `Muxed output duration (${outputDurationSeconds}s) disagrees with silent video duration ` +
        `(${silentVideoDurationSeconds}s) by more than the ${toleranceSeconds}s tolerance ` +
        `(delta: ${Math.abs(outputDurationSeconds - silentVideoDurationSeconds)}s).`,
    );
    this.name = "MuxDurationMismatchError";
  }
}

export interface MuxOptions {
  /** Change 005's silent video-only encode. Read-only — never written to. */
  silentVideoPath: string;
  /** Argv from `graph.ts`'s `buildAudioGraphArgv` (input args + `-filter_complex ... -map
   * [out]`), verbatim — `muxOutput` appends only an output codec + temp-file path tail to run it,
   * never a filter-graph flag of its own (see this module's header comment for the one-pass-vs-
   * two-pass design decision). */
  audioGraphArgv: string[];
  /** Final destination. Always distinct from `silentVideoPath` (`MuxSamePathError` otherwise). */
  outputPath: string;
  /** Allows overwriting an existing file at `outputPath`. Defaults to `false` (fail closed). */
  force?: boolean;
  /** Max allowed |output duration - silent video duration|, in seconds. Defaults to
   * `DEFAULT_DURATION_TOLERANCE_SECONDS` (50ms). */
  durationToleranceSeconds?: number;
  /** Injectable seam mirroring `probe.ts`'s `execFn` pattern — defaults to the real
   * `child_process.spawn` so production call sites pass nothing; tests inject a fake that returns
   * an `EventEmitter`-shaped fake child process, no real FFmpeg needed. Used for BOTH FFmpeg
   * invocations (compose-audio and mux) AND (by the default `probeDurationSecondsFn`) for
   * `ffprobe` invocations. */
  spawnFn?: typeof spawn;
  /** Defaults to `"ffmpeg"` (resolved via PATH) — mirrors `pipe.ts`'s `EncodeOptions.ffmpegPath`. */
  ffmpegPath?: string;
  /** Defaults to `"ffprobe"` (resolved via PATH). Only consulted by the default
   * `probeDurationSecondsFn`; ignored entirely if a caller supplies their own. */
  ffprobePath?: string;
  /** Test/injection seam for the duration-tolerance check (FR8/AC8): defaults to
   * `probeDurationSeconds` (real `ffprobe` invocation via `spawnFn`/`ffprobePath`). Tests inject a
   * fake that returns controlled durations with no real `ffprobe` process, mirroring every other
   * injectable seam in this package. */
  probeDurationSecondsFn?: (filePath: string) => Promise<number>;
}

/** Resolves once `child` has exited (cleanly or via signal) or failed to spawn at all — identical
 * collapsing of `"exit"`/`"error"` into one settlement as `pipe.ts`'s own `waitForExit`. */
function waitForExit(child: ChildProcess): Promise<{ code: number | null; error?: Error }> {
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve({ code }));
    child.once("error", (error) => resolve({ code: null, error }));
  });
}

/** Runs one FFmpeg invocation to completion, collecting a bounded stderr tail, and resolves
 * `{ code, stderrTail }` — this function itself never throws on a non-zero exit; callers decide
 * per-stage what cleanup to do first (matches the temp-file cleanup requirement being the
 * *caller's* responsibility, since only the caller knows which temp files are in flight). */
function runFfmpeg(
  spawnFn: typeof spawn,
  ffmpegPath: string,
  argv: string[],
): Promise<{ code: number | null; stderrTail: string[] }> {
  return new Promise((resolve) => {
    const child = spawnFn(ffmpegPath, argv, { stdio: ["ignore", "ignore", "pipe"] });
    const stderrTail: string[] = [];

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
    });

    waitForExit(child).then(({ code, error }) => {
      if (error) {
        stderrTail.push(`[ffmpeg spawn error] ${error.message}`);
        resolve({ code: null, stderrTail });
        return;
      }
      resolve({ code, stderrTail });
    });
  });
}

/** Deletes `filePath` if present; swallows `ENOENT` (nothing to clean up) and re-throws anything
 * else — used for the "leave no file behind on failure" cleanup this module's whole atomic-write
 * discipline depends on. */
async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/** Real duration probe via `ffprobe -show_entries format=duration` (spec.md FR8/AC8). Spawns
 * `ffprobePath` through `spawnFn` (the same injectable seam as the FFmpeg invocations, per
 * `MuxOptions.spawnFn`'s doc comment) rather than adding a second, uninjectable spawn mechanism.
 * Exported so a caller that wants the real check without going through `muxOutput` (or a test
 * that wants to exercise the parsing logic specifically) can call it directly. */
export function probeDurationSeconds(
  filePath: string,
  opts?: { spawnFn?: typeof spawn; ffprobePath?: string },
): Promise<number> {
  const spawnFn = opts?.spawnFn ?? spawn;
  const ffprobePath = opts?.ffprobePath ?? "ffprobe";
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ];

  return new Promise((resolve, reject) => {
    const child = spawnFn(ffprobePath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    waitForExit(child).then(({ code, error }) => {
      if (error) {
        reject(new Error(`Failed to spawn "${ffprobePath}" to probe "${filePath}": ${error.message}`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `"${ffprobePath}" exited with code ${code} probing "${filePath}"` +
              (stderr.trim() ? `: ${stderr.trim()}` : ""),
          ),
        );
        return;
      }
      const value = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(value)) {
        reject(new Error(`Could not parse a duration from ffprobe output for "${filePath}": "${stdout.trim()}"`));
        return;
      }
      resolve(value);
    });
  });
}

/**
 * Muxes a composed audio graph (`opts.audioGraphArgv`, from `graph.ts`'s `buildAudioGraphArgv`)
 * against change 005's silent video (`opts.silentVideoPath`), writing the result to
 * `opts.outputPath` (spec.md FR8, AC8). See this module's header comment for the two-invocation
 * design rationale and the atomic-write discipline. Never touches `opts.silentVideoPath`.
 */
export async function muxOutput(opts: MuxOptions): Promise<void> {
  const spawnFn = opts.spawnFn ?? spawn;
  const ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
  const durationToleranceSeconds = opts.durationToleranceSeconds ?? DEFAULT_DURATION_TOLERANCE_SECONDS;
  const probeDurationSecondsFn =
    opts.probeDurationSecondsFn ??
    ((filePath: string) => probeDurationSeconds(filePath, { spawnFn, ffprobePath: opts.ffprobePath }));

  if (opts.outputPath === opts.silentVideoPath) {
    throw new MuxSamePathError(opts.outputPath);
  }

  if (!opts.force) {
    const exists = await fs
      .access(opts.outputPath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      throw new MuxOutputExistsError(opts.outputPath);
    }
  }

  // FFmpeg infers a muxer/container from its output path's file extension (no extension =
  // "Unable to choose an output format", a real failure mode hit while building this against a
  // real FFmpeg binary) — so the temp output path keeps `opts.outputPath`'s own extension at the
  // very end (`<dir>/<base>.<pid>.<ts>.tmp<ext>`) rather than merely appending `.tmp` after it.
  const tempAudioPath = `${opts.outputPath}.audio.${process.pid}.${Date.now()}.tmp.wav`;
  const outputExt = path.extname(opts.outputPath);
  const outputBaseNoExt = path.basename(opts.outputPath, outputExt);
  const tempOutputPath = path.join(
    path.dirname(opts.outputPath),
    `${outputBaseNoExt}.${process.pid}.${Date.now()}.tmp${outputExt}`,
  );

  // Step 1: render the composed audio graph to a lossless intermediate WAV. `-y` is safe here —
  // `tempAudioPath` is a path this function just generated itself (PID + timestamp), never a
  // caller-supplied path, so there is nothing meaningful to "refuse to overwrite."
  const composeArgv = [...opts.audioGraphArgv, "-y", "-c:a", "pcm_s16le", tempAudioPath];
  const composeResult = await runFfmpeg(spawnFn, ffmpegPath, composeArgv);
  if (composeResult.code !== 0) {
    await removeIfExists(tempAudioPath);
    throw new MuxError("compose-audio", composeResult.code, composeResult.stderrTail);
  }

  // Step 2: mux the silent video against the composed audio. `-shortest` bounds the output to the
  // shorter of the two inputs — this is a safety net, not a substitute for the duration-tolerance
  // check below (a badly mismatched composed-audio length still trips that check explicitly).
  const muxArgv = [
    "-y",
    "-i",
    opts.silentVideoPath,
    "-i",
    tempAudioPath,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-shortest",
    tempOutputPath,
  ];
  const muxResult = await runFfmpeg(spawnFn, ffmpegPath, muxArgv);
  if (muxResult.code !== 0) {
    await removeIfExists(tempAudioPath);
    await removeIfExists(tempOutputPath);
    throw new MuxError("mux", muxResult.code, muxResult.stderrTail);
  }

  // Duration-tolerance check (FR8/AC8) — runs against the still-temp output path, BEFORE the
  // rename that makes it visible at `opts.outputPath`. A mismatch is treated the same as an
  // FFmpeg-level failure: both temp files are cleaned up and nothing is left at either the temp
  // or the final path.
  let silentVideoDurationSeconds: number;
  let outputDurationSeconds: number;
  try {
    [silentVideoDurationSeconds, outputDurationSeconds] = await Promise.all([
      probeDurationSecondsFn(opts.silentVideoPath),
      probeDurationSecondsFn(tempOutputPath),
    ]);
  } catch (err) {
    await removeIfExists(tempAudioPath);
    await removeIfExists(tempOutputPath);
    throw err;
  }

  if (Math.abs(outputDurationSeconds - silentVideoDurationSeconds) > durationToleranceSeconds) {
    await removeIfExists(tempAudioPath);
    await removeIfExists(tempOutputPath);
    throw new MuxDurationMismatchError(
      silentVideoDurationSeconds,
      outputDurationSeconds,
      durationToleranceSeconds,
    );
  }

  await removeIfExists(tempAudioPath);
  await fs.rename(tempOutputPath, opts.outputPath);
}
