// Process *lifecycle* only (spec.md FR5/FR8/FR9, design.md's `pipe.ts` section): spawn FFmpeg,
// write frames with real backpressure, parse stderr progress lines, and surface a non-zero exit
// as a typed, actionable `EncodeError`. `pipe.ts` never invents a codec or a flag itself — it
// calls `resolveProfile` (profiles.ts, T5) for the former and `buildArgv` (argv.ts, T3) for the
// latter, and appends ZERO flags of its own to what `buildArgv` returns (the FR2 single-owner
// contract T3 established).
//
// Design decision D2 (design.md): `capabilities` is a caller-supplied field on `EncodeOptions`,
// not something `createEncodePipe` probes for itself. Probing is I/O-bound and cacheable across
// multiple encodes in the same process (`tools/bench`, 007's eventual CLI); baking a `probe()`
// call into every `createEncodePipe` invocation would pay a redundant `ffmpeg -encoders` spawn
// per encode and would make this module untestable without a live FFmpeg dependency the way
// `probe.ts`'s own injectable seam exists specifically to avoid.

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

import { buildArgv } from "./argv.js";
import { resolveProfile } from "./profiles.js";
import type { TempRun } from "./temp.js";
import type { ArgvInput, EncoderCapabilities, FrameGeometry, ProgressEvent } from "./types.js";

/** Bounds `EncodeError.stderrTail` (spec.md FR8) — enough lines to show FFmpeg's actual error
 * past its banner, small enough that a pathological error flood can't balloon memory. */
const STDERR_TAIL_LINES = 20;

/** Grace period `cancel()` gives FFmpeg to exit cleanly after SIGTERM before escalating to
 * SIGKILL (design.md's `pipe.ts` cancel semantics) — bounds AC9's "zero live processes after
 * cancel() resolves" promise even against an FFmpeg build that ignores SIGTERM. */
const CANCEL_GRACE_MS = 5000;

/**
 * Thrown/rejected on a non-zero FFmpeg exit (spec.md FR8). Carries the exit code and the last
 * `STDERR_TAIL_LINES` lines of stderr — enough to show the actual FFmpeg error line past the
 * banner text, bounded so a pathological error flood doesn't balloon memory. `message` is a
 * generated summary (exit code + first line of `stderrTail`), never a bare
 * `"FFmpeg exited with code 1"` (FR8).
 */
export class EncodeError extends Error {
  readonly exitCode: number | null;
  readonly stderrTail: string[];

  constructor(exitCode: number | null, stderrTail: string[]) {
    const firstLine = stderrTail[0];
    super(`ffmpeg exited with code ${exitCode}` + (firstLine ? `: ${firstLine}` : ""));
    this.name = "EncodeError";
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

// Matches FFmpeg's periodic stderr progress line, e.g.:
//   frame=  120 fps= 30 q=-1.0 size=    512kB time=00:00:04.00 bitrate=1024.0kbits/s speed=1.0x
const PROGRESS_RE =
  /frame=\s*(\d+)\s+fps=\s*([\d.]+).*?time=(\d{2}):(\d{2}):(\d{2})\.(\d{2}).*?speed=\s*([\d.]+)x/;

/**
 * Parses one line of FFmpeg's stderr progress output into a `ProgressEvent` (spec.md FR9, AC7).
 * Pure — no I/O, no process access, no mutation — returns `null` for any non-matching line
 * (banner text, warnings, codec info, etc).
 *
 * Progress-event contract (FR9, resolution point 3): `frame` is FFmpeg's own `frame=` counter
 * taken directly, with NO chunk-offset or aggregation math applied here. Because v1 spawns
 * exactly one FFmpeg process per encode (no chunking), this counter already IS the
 * timeline-global frame index — this is stated explicitly so a future chunking follow-on has an
 * established contract to *extend* (e.g. `chunkStartFrame + localFrame`), not invent from
 * scratch.
 */
export function parseProgressLine(line: string): ProgressEvent | null {
  const match = PROGRESS_RE.exec(line);
  if (!match) return null;
  const [, frame, fps, hh, mm, ss, cs, speedX] = match;
  const timeSeconds = Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(cs) / 100;
  return {
    frame: Number(frame),
    fps: Number(fps),
    speedX: Number(speedX),
    timeSeconds,
  };
}

/** Appends `line` to `buf`, evicting the oldest entry once `buf.length` exceeds `max` — the
 * ring-buffer behavior `EncodeError.stderrTail` relies on (spec.md FR8). */
function pushRing(buf: string[], line: string, max: number): void {
  buf.push(line);
  if (buf.length > max) buf.shift();
}

export interface EncodeOptions {
  profileName: "preview" | "final";
  geometry: FrameGeometry;
  outputPath: string;
  /** Caller-supplied, e.g. from a prior `probe()` call — `createEncodePipe` never probes for
   * itself (design.md D2). */
  capabilities: EncoderCapabilities;
  cpuEncode?: boolean;
  /** Defaults to `"ffmpeg"` (resolved via PATH). */
  ffmpegPath?: string;
  /** If supplied, the spawned FFmpeg child is registered on it (`TempRun.registerChild`,
   * temp.ts/T6) so a SIGINT/SIGTERM during the encode still kills this child. */
  tempRun?: TempRun;
}

export interface EncodePipe {
  /** `frame.length` is expected to be `width * height * 4` (raw RGBA), matching
   * `FrameBuffer.data`. Resolves once the write has actually been accepted by the stream —
   * if `stdin.write()` signals backpressure (returns `false`), this awaits the stream's own
   * `"drain"` event before resolving. This is real backpressure, not a fire-and-forget hint. */
  write(frame: Buffer): Promise<void>;
  /** Ends stdin and resolves once FFmpeg has exited 0; rejects with `EncodeError` on a
   * non-zero exit. */
  finish(): Promise<void>;
  /** SIGTERMs the FFmpeg process (escalating to SIGKILL if it hasn't exited within
   * `CANCEL_GRACE_MS`) and resolves once it has exited. */
  cancel(): Promise<void>;
  onProgress(cb: (event: ProgressEvent) => void): void;
}

/** Resolves once `child` has exited (cleanly or via signal) or failed to spawn at all —
 * collapses both `"exit"` and `"error"` into one settlement so callers never hang waiting on an
 * `"exit"` that a failed spawn may never emit. */
function waitForExit(child: ChildProcess): Promise<{ code: number | null; error?: Error }> {
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve({ code }));
    child.once("error", (error) => resolve({ code: null, error }));
  });
}

/**
 * Spawns FFmpeg with `buildArgv`'s output (via `resolveProfile` for the codec/bitrate) and
 * returns a handle for streaming raw RGBA frames into it (spec.md FR5/FR8/FR9).
 *
 * Chains exactly: `resolveProfile(opts.profileName, opts.capabilities, { cpuEncode })` (T5) →
 * `buildArgv({ profile, geometry, inputPath: "-", outputPath })` (T3) → `spawn("ffmpeg", argv,
 * ...)`. This function appends ZERO flags of its own — the entire argv comes from `buildArgv`'s
 * return value untouched (the FR2 single-owner contract T3 established).
 */
export function createEncodePipe(opts: EncodeOptions): EncodePipe {
  const { resolved, fallbackNotice } = resolveProfile(opts.profileName, opts.capabilities, {
    cpuEncode: opts.cpuEncode,
  });
  if (fallbackNotice) {
    // Visible, not swallowed (proposal problem #2 / spec.md FR8's spirit). resolveProfile's
    // returned `fallbackNotice` is the structured, testable form (AC5); this console.warn is
    // the pragmatic default so a caller that ignores the return value still sees it (design.md
    // D3) — not a required logging callback this v1 has no second consumer for.
    console.warn(fallbackNotice);
  }

  const argvInput: ArgvInput = {
    profile: resolved,
    geometry: opts.geometry,
    inputPath: "-",
    outputPath: opts.outputPath,
  };
  const argv = buildArgv(argvInput);

  const child = spawn(opts.ffmpegPath ?? "ffmpeg", argv, {
    stdio: ["pipe", "ignore", "pipe"],
  });
  opts.tempRun?.registerChild(child);

  // A dead/dying FFmpeg can make stdin writes fail with EPIPE; without a listener here that
  // would be an unhandled stream error (Node throws). The failure itself is surfaced to the
  // caller via `EncodeError` from `finish()`/`cancel()`'s own exit handling instead.
  child.stdin?.on("error", () => {});

  const stderrTail: string[] = [];
  const progressCbs: Array<(event: ProgressEvent) => void> = [];
  let finished = false;

  const stderrLines = createInterface({ input: child.stderr! });
  stderrLines.on("line", (line) => {
    pushRing(stderrTail, line, STDERR_TAIL_LINES);
    const event = parseProgressLine(line);
    if (event) {
      for (const cb of progressCbs) cb(event);
    }
  });

  async function doWrite(frame: Buffer): Promise<void> {
    const accepted = child.stdin!.write(frame);
    if (!accepted) {
      await once(child.stdin!, "drain");
    }
  }

  async function doFinish(): Promise<void> {
    child.stdin!.end();
    const { code, error } = await waitForExit(child);
    stderrLines.close();
    if (error) {
      pushRing(stderrTail, `[ffmpeg spawn error] ${error.message}`, STDERR_TAIL_LINES);
      throw new EncodeError(null, [...stderrTail]);
    }
    if (code !== 0) {
      throw new EncodeError(code, [...stderrTail]);
    }
  }

  async function doCancel(): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      stderrLines.close();
      return;
    }
    const exited = waitForExit(child);
    child.kill("SIGTERM");
    const escalate = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, CANCEL_GRACE_MS);
    escalate.unref?.();
    await exited;
    clearTimeout(escalate);
    stderrLines.close();
  }

  return {
    // `write`/`finish` are deliberately plain (non-`async`) functions: the "already finished"
    // check below must throw SYNCHRONOUSLY (spec.md Edge Cases — "throws synchronously ...
    // rather than hanging or silently no-op-ing"), which an `async function` body cannot do
    // (a throw inside an async function is always converted into a promise rejection, never a
    // synchronous exception at the call site). The actual async work is delegated to the
    // `do*` helpers above.
    write(frame: Buffer): Promise<void> {
      if (finished) throw new Error("EncodePipe already finished");
      return doWrite(frame);
    },
    finish(): Promise<void> {
      if (finished) throw new Error("EncodePipe already finished");
      finished = true;
      return doFinish();
    },
    cancel(): Promise<void> {
      // Unlike write()/finish(), a cancel() after the pipe is already finished is a no-op, not
      // a thrown error (design.md's `pipe.ts` cancel semantics) — cancelling something that's
      // already done isn't a caller state-machine bug the way writing/finishing twice is.
      if (finished) return Promise.resolve();
      finished = true;
      return doCancel();
    },
    onProgress(cb: (event: ProgressEvent) => void): void {
      progressCbs.push(cb);
    },
  };
}
