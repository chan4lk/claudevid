// decodeAudioFile() + VOICE_TRACK_SAMPLE_RATE (spec.md FR9–FR12, design.md's decoder-boundary row
// of the "Three boundaries, three guards" table). This is the "file → PCM" boundary: given an
// already-resolved, already-contained filesystem path (that's `scene-audio-paths.ts`'s job, a
// different package), decode it to the exact PCM shape `tts.ts`'s `synthesize()` already produces
// — 16-bit signed little-endian PCM at a known sample rate — so `render-pipeline.ts`'s Step A can
// treat a decoded file and a synthesized narration block identically (design.md's Key Decision
// D1: "Blocks, not a parallel structure").
//
// Mirrors `mux.ts`'s spawn/exit-code/stderr-tail handling and its injectable `spawnFn`/
// `probeDurationSecondsFn`/`ffmpegPath` seams (same rationale: one convention for spawning FFmpeg
// in this package, not two) — including reusing `mux.ts`'s own exported `probeDurationSeconds`
// for the duration cross-check (FR11) rather than duplicating an `ffprobe` invocation here.
//
// Fail-closed by design (design.md D5): exit code alone would let an empty or truncated stream
// render as silence. So a decode is accepted only if the process exits 0, stays within the wall
// clock and byte-count bounds, produces at least `minSeconds` of audio, AND its length agrees with
// an independent `ffprobe` measurement of the same file within `durationToleranceSeconds`.

import { spawn, type ChildProcess } from "node:child_process";

import { probeDurationSeconds } from "./mux.js";

/** The voice track's one true sample rate (spec.md FR9). Kokoro's production output is this rate
 * (see `tts.ts`'s note by `synthesize()`) — stated here as a named constant so both the
 * synthesis and decode paths, and `render-pipeline.ts`'s cross-source rate check (FR13), refer to
 * the same number rather than each hard-coding `24000`. */
export const VOICE_TRACK_SAMPLE_RATE = 24000;

/** Bounds how much of FFmpeg's stderr `DecodeError` carries — mirrors `mux.ts`'s
 * `STDERR_TAIL_LINES` (enough to show the real error past FFmpeg's banner, bounded so a
 * pathological error flood can't balloon memory). */
const STDERR_TAIL_LINES = 20;

/** 16-bit PCM: two bytes per sample, per channel (spec.md FR9's "16-bit signed little-endian
 * PCM"). */
const BYTES_PER_SAMPLE = 2;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_SECONDS = 600;
const DEFAULT_MIN_SECONDS = 0.25;
const DEFAULT_DURATION_TOLERANCE_SECONDS = 0.25;

/** Why a decode was refused (spec.md FR11). Each throws before any partial/misleading audio is
 * returned to the caller. */
export type DecodeErrorReason =
  | "spawn"
  | "exit"
  | "timeout"
  | "too-long"
  | "too-short"
  | "duration-mismatch";

/** Thrown by `decodeAudioFile` for every fail-closed condition in spec.md FR11. Carries `reason`
 * (which condition tripped), `src` (the file that failed), and — when FFmpeg actually ran —
 * `exitCode`/`stderrTail`, mirroring `mux.ts`'s `MuxError` shape so callers handling FFmpeg
 * failures across this package see one consistent error contract. */
export class DecodeError extends Error {
  readonly reason: DecodeErrorReason;
  readonly src: string;
  readonly exitCode: number | null;
  readonly stderrTail: string[];

  constructor(reason: DecodeErrorReason, src: string, exitCode: number | null, stderrTail: string[], detail?: string) {
    const firstLine = stderrTail[0];
    super(
      `Failed to decode "${src}" (${reason})` + (detail ? `: ${detail}` : firstLine ? `: ${firstLine}` : ""),
    );
    this.name = "DecodeError";
    this.reason = reason;
    this.src = src;
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

export interface DecodeAudioOptions {
  /** Interleaved output channel count. Defaults to `1` (mono — the voice track's shape). */
  channels?: number;
  /** Output sample rate. Defaults to `VOICE_TRACK_SAMPLE_RATE`. */
  sampleRate?: number;
  /** Wall-clock budget for the whole decode. Defaults to `120_000` (120s). Exceeding it kills the
   * child and throws `DecodeError` with `reason: "timeout"`. */
  timeoutMs?: number;
  /** Upper bound on decoded audio length, in seconds. Defaults to `600` (10 minutes). Exceeding it
   * kills the child and throws `DecodeError` with `reason: "too-long"` — this is also what bounds
   * this function's memory use (NFR4: at most `maxSeconds * sampleRate * channels * 2` bytes). */
  maxSeconds?: number;
  /** Lower bound on decoded audio length, in seconds. Defaults to `0.25`. A shorter (including
   * zero-byte) decode throws `DecodeError` with `reason: "too-short"`. */
  minSeconds?: number;
  /** Max allowed `|decodedSeconds - probeDurationSeconds(src)|`, in seconds. Defaults to `0.25`.
   * Beyond it, `DecodeError` is thrown with `reason: "duration-mismatch"` — a corrupt/truncated
   * source, not a codec-delay quirk (design.md D5). */
  durationToleranceSeconds?: number;
  /** Defaults to `"ffmpeg"` (resolved via PATH). */
  ffmpegPath?: string;
  /** Only consulted by the default `probeDurationSecondsFn` — ignored if a caller supplies their
   * own. Defaults to `"ffprobe"` (resolved via PATH). */
  ffprobePath?: string;
  /** Injectable seam mirroring `mux.ts`'s `MuxOptions.spawnFn` — defaults to the real
   * `child_process.spawn` so production call sites pass nothing; tests inject a fake that returns
   * an `EventEmitter`-shaped fake child process, no real FFmpeg needed. */
  spawnFn?: typeof spawn;
  /** Test/injection seam for the duration cross-check (FR11): defaults to `mux.ts`'s exported
   * `probeDurationSeconds` (a real `ffprobe` invocation via `spawnFn`/`ffprobePath`). Tests inject
   * a fake that returns a controlled duration with no real `ffprobe` process. */
  probeDurationSecondsFn?: (filePath: string) => Promise<number>;
}

export interface DecodeAudioResult {
  /** 16-bit signed little-endian PCM, `opts.channels` interleaved, at `opts.sampleRate`. */
  audio: Buffer;
  sampleRate: number;
  durationSeconds: number;
}

/** Resolves once `child` has exited (cleanly, via signal, or via a kill this function issued
 * itself) or failed to spawn at all — same "collapse `exit`/`error` into one settlement" shape as
 * `mux.ts`'s own private `waitForExit`. */
function waitForExit(child: ChildProcess): Promise<{ code: number | null; error?: Error }> {
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve({ code }));
    child.once("error", (error) => resolve({ code: null, error }));
  });
}

/**
 * Decodes `src` to raw PCM via FFmpeg (spec.md FR9–FR11). Spawns exactly one FFmpeg process with
 * the argv fixed by FR10, collects its stdout into a `Buffer` and a bounded stderr tail, and
 * fails closed (see this module's header comment) rather than trusting a zero exit code alone.
 */
export async function decodeAudioFile(src: string, opts: DecodeAudioOptions = {}): Promise<DecodeAudioResult> {
  const spawnFn = opts.spawnFn ?? spawn;
  const ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
  const channels = opts.channels ?? 1;
  const sampleRate = opts.sampleRate ?? VOICE_TRACK_SAMPLE_RATE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxSeconds = opts.maxSeconds ?? DEFAULT_MAX_SECONDS;
  const minSeconds = opts.minSeconds ?? DEFAULT_MIN_SECONDS;
  const durationToleranceSeconds = opts.durationToleranceSeconds ?? DEFAULT_DURATION_TOLERANCE_SECONDS;
  const probeDurationSecondsFn =
    opts.probeDurationSecondsFn ??
    ((filePath: string) => probeDurationSeconds(filePath, { spawnFn, ffprobePath: opts.ffprobePath }));

  const bytesPerSecond = sampleRate * channels * BYTES_PER_SAMPLE;
  const maxBytes = maxSeconds * bytesPerSecond;

  // FR10: this exact argv, in this exact order — `mux.ts`'s "single owner of the argv it builds"
  // discipline applies here too, just with no separate argv-building module since this is the
  // only invocation this file makes.
  const argv = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    src,
    "-vn",
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    "-ac",
    String(channels),
    "-ar",
    String(sampleRate),
    "pipe:1",
  ];

  const result = await new Promise<{
    code: number | null;
    error?: Error;
    stdout: Buffer;
    stderrTail: string[];
    killedFor?: "timeout" | "too-long";
  }>((resolve) => {
    const child = spawnFn(ffmpegPath, argv, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    const stderrTail: string[] = [];
    let killedFor: "timeout" | "too-long" | undefined;
    let settled = false;

    const timer = setTimeout(() => {
      killedFor = "timeout";
      child.kill("SIGKILL");
    }, timeoutMs);

    function settle(code: number | null, error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, error, stdout: Buffer.concat(stdoutChunks), stderrTail, killedFor });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (killedFor) return; // already killed for exceeding maxBytes; stop accumulating
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        killedFor = "too-long";
        child.kill("SIGKILL");
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
    });

    child.once("exit", (code) => settle(code));
    child.once("error", (error) => settle(null, error));
  });

  if (result.error) {
    result.stderrTail.push(`[ffmpeg spawn error] ${result.error.message}`);
    throw new DecodeError("spawn", src, null, result.stderrTail);
  }
  if (result.killedFor === "timeout") {
    throw new DecodeError("timeout", src, result.code, result.stderrTail, `exceeded ${timeoutMs}ms`);
  }
  if (result.killedFor === "too-long") {
    throw new DecodeError("too-long", src, result.code, result.stderrTail, `exceeded ${maxSeconds}s`);
  }
  if (result.code !== 0) {
    throw new DecodeError("exit", src, result.code, result.stderrTail);
  }

  const audio = result.stdout;
  const durationSeconds = audio.length / BYTES_PER_SAMPLE / sampleRate / channels;

  if (durationSeconds < minSeconds) {
    throw new DecodeError(
      "too-short",
      src,
      result.code,
      result.stderrTail,
      `decoded ${durationSeconds}s is below the minimum of ${minSeconds}s`,
    );
  }

  const probeSeconds = await probeDurationSecondsFn(src);
  if (Math.abs(durationSeconds - probeSeconds) > durationToleranceSeconds) {
    throw new DecodeError(
      "duration-mismatch",
      src,
      result.code,
      result.stderrTail,
      `decoded ${durationSeconds}s vs. probed ${probeSeconds}s (tolerance ${durationToleranceSeconds}s)`,
    );
  }

  return { audio, sampleRate, durationSeconds };
}
