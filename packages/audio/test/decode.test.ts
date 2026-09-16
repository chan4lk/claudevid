// Tests for decode.ts (spec.md FR9–FR12, AC8/AC9).
//
// AC8 (structural, no real FFmpeg needed): every test in the first describe block injects a
// `spawnFn` that returns an `EventEmitter`-shaped fake child process — no real FFmpeg process
// runs. This mirrors `mux.test.ts`'s injection pattern exactly (same rationale: FFmpeg's own
// exit-code/stderr semantics are already covered elsewhere; what's under test here is
// `decodeAudioFile`'s own argv construction and its fail-closed decision logic).
//
// AC9 (real ffmpeg, gated): mirrors `graph.test.ts`'s "probe a real capability once, up front,
// and skip gracefully rather than fail the build if it's unavailable" pattern and `mux.test.ts`'s
// exact fixture ("1s 44.1kHz sine WAV via `ffmpeg -f lavfi`") — no binary fixture is committed
// (spec.md's resolved open question 3).

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync, type spawn as SpawnFn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DecodeError, VOICE_TRACK_SAMPLE_RATE, decodeAudioFile } from "../src/decode.js";

type SpawnType = typeof SpawnFn;

/** Minimal fake `ChildProcess`: an `EventEmitter` with `.stdout`/`.stderr` themselves
 * `EventEmitter`s, and a `kill()` spy that — mirroring how a real process actually responds to
 * SIGKILL — emits `exit` itself once called. Matches exactly the shape `decode.ts`'s internals
 * consume. No real process is ever spawned by these fakes. */
function makeFakeChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("exit", null));
  });
  return child;
}

interface FakeSpawnResult {
  spawnFn: SpawnType;
  calls: Array<{ cmd: string; args: string[] }>;
  getChild: () => ReturnType<typeof makeFakeChild>;
}

/** Builds a fake `spawnFn` that, once called, schedules (on the next microtask) the given stderr
 * lines and stdout chunks, then emits `exit` with `code` — unless `autoExit` is `false`, in which
 * case the fake child is left running (for tests that expect `decodeAudioFile` itself to kill it,
 * e.g. the timeout/too-long cases below). */
function fakeSpawnOnce(opts: {
  stdoutChunks?: Buffer[];
  stderrLines?: string[];
  code?: number | null;
  autoExit?: boolean;
}): FakeSpawnResult {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let child: ReturnType<typeof makeFakeChild> | undefined;
  const spawnFn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    child = makeFakeChild();
    if (opts.autoExit !== false) {
      queueMicrotask(() => {
        for (const line of opts.stderrLines ?? []) {
          child!.stderr.emit("data", Buffer.from(line + "\n"));
        }
        for (const chunk of opts.stdoutChunks ?? []) {
          child!.stdout.emit("data", chunk);
        }
        child!.emit("exit", opts.code ?? 0);
      });
    } else {
      queueMicrotask(() => {
        for (const chunk of opts.stdoutChunks ?? []) {
          child!.stdout.emit("data", chunk);
        }
      });
    }
    return child as unknown as ReturnType<SpawnType>;
  }) as SpawnType;
  return { spawnFn, calls, getChild: () => child! };
}

/** `channels=1` PCM buffer of `seconds` at `sampleRate`, filled with non-zero sample bytes (so
 * it's distinguishable from a truncated/silent decode in assertions). */
function fakePcm(seconds: number, sampleRate = VOICE_TRACK_SAMPLE_RATE): Buffer {
  const buffer = Buffer.alloc(Math.round(seconds * sampleRate) * 2);
  buffer.fill(0x11);
  return buffer;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("decodeAudioFile — argv and successful decode (AC8)", () => {
  it("spawns ffmpeg with exactly FR10's argv", async () => {
    const { spawnFn, calls } = fakeSpawnOnce({ stdoutChunks: [fakePcm(1)] });
    await decodeAudioFile("/tmp/a.wav", { spawnFn, probeDurationSecondsFn: async () => 1 });
    expect(calls).toEqual([
      {
        cmd: "ffmpeg",
        args: [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          "/tmp/a.wav",
          "-vn",
          "-f",
          "s16le",
          "-acodec",
          "pcm_s16le",
          "-ac",
          "1",
          "-ar",
          String(VOICE_TRACK_SAMPLE_RATE),
          "pipe:1",
        ],
      },
    ]);
  });

  it("turns stdout bytes into `audio` and computes durationSeconds from the PCM formula", async () => {
    const pcm = fakePcm(1);
    const { spawnFn } = fakeSpawnOnce({ stdoutChunks: [pcm] });
    const result = await decodeAudioFile("/tmp/a.wav", {
      spawnFn,
      probeDurationSecondsFn: async () => 1,
    });
    expect(result.audio).toEqual(pcm);
    expect(result.sampleRate).toBe(VOICE_TRACK_SAMPLE_RATE);
    expect(result.durationSeconds).toBe(result.audio.length / 2 / result.sampleRate / 1);
    expect(result.durationSeconds).toBeCloseTo(1, 5);
  });

  it("respects a custom channels/sampleRate pair in both argv and the duration formula", async () => {
    const channels = 2;
    const sampleRate = 16000;
    const expectedSeconds = 0.5;
    // 0.5s of interleaved 2-channel 16-bit PCM at 16kHz.
    const pcm = fakePcm(expectedSeconds * channels, sampleRate);
    const { spawnFn, calls } = fakeSpawnOnce({ stdoutChunks: [pcm] });
    const result = await decodeAudioFile("/tmp/a.wav", {
      spawnFn,
      channels,
      sampleRate,
      probeDurationSecondsFn: async () => expectedSeconds,
    });
    expect(calls[0]!.args).toContain("-ac");
    expect(calls[0]!.args[calls[0]!.args.indexOf("-ac") + 1]).toBe("2");
    expect(calls[0]!.args).toContain("-ar");
    expect(calls[0]!.args[calls[0]!.args.indexOf("-ar") + 1]).toBe("16000");
    expect(result.durationSeconds).toBe(result.audio.length / 2 / sampleRate / channels);
    expect(result.durationSeconds).toBeCloseTo(expectedSeconds, 5);
  });
});

describe("decodeAudioFile — fail-closed conditions (AC8)", () => {
  it("throws DecodeError(reason: 'exit') with the stderr tail on a non-zero exit", async () => {
    const { spawnFn } = fakeSpawnOnce({ code: 1, stderrLines: ["Invalid data found when processing input"] });
    const err = await decodeAudioFile("/tmp/a.wav", { spawnFn }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecodeError);
    const decodeErr = err as DecodeError;
    expect(decodeErr.reason).toBe("exit");
    expect(decodeErr.exitCode).toBe(1);
    expect(decodeErr.stderrTail).toEqual(["Invalid data found when processing input"]);
  });

  it("throws DecodeError(reason: 'too-short') on a clean exit with zero stdout bytes", async () => {
    const { spawnFn } = fakeSpawnOnce({ code: 0, stdoutChunks: [] });
    const err = await decodeAudioFile("/tmp/a.wav", { spawnFn }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).reason).toBe("too-short");
  });

  it("throws DecodeError(reason: 'too-short') when decoded length is below minSeconds", async () => {
    const { spawnFn } = fakeSpawnOnce({ code: 0, stdoutChunks: [fakePcm(0.1)] });
    const err = await decodeAudioFile("/tmp/a.wav", { spawnFn, minSeconds: 0.25 }).catch((e: unknown) => e);
    expect((err as DecodeError).reason).toBe("too-short");
  });

  it("kills the child and throws DecodeError(reason: 'too-long') when stdout exceeds maxSeconds worth of bytes", async () => {
    const { spawnFn, getChild } = fakeSpawnOnce({
      autoExit: false,
      stdoutChunks: [fakePcm(2)], // 2s of PCM at the default 24kHz mono rate
    });
    const err = await decodeAudioFile("/tmp/a.wav", { spawnFn, maxSeconds: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).reason).toBe("too-long");
    expect(getChild().kill).toHaveBeenCalled();
  });

  it("kills the child and throws DecodeError(reason: 'timeout') when the wall clock exceeds timeoutMs", async () => {
    vi.useFakeTimers();
    const { spawnFn, getChild } = fakeSpawnOnce({ autoExit: false });
    const promise = decodeAudioFile("/tmp/a.wav", { spawnFn, timeoutMs: 1000 });
    const assertion = expect(promise).rejects.toMatchObject({ name: "DecodeError", reason: "timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(getChild().kill).toHaveBeenCalled();
  });

  it("throws DecodeError(reason: 'duration-mismatch') when the probe disagrees beyond tolerance", async () => {
    const { spawnFn } = fakeSpawnOnce({ code: 0, stdoutChunks: [fakePcm(1)] });
    const err = await decodeAudioFile("/tmp/a.wav", {
      spawnFn,
      probeDurationSecondsFn: async () => 5,
      durationToleranceSeconds: 0.25,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).reason).toBe("duration-mismatch");
  });
});

// ---------------------------------------------------------------------------------------------
// AC9 — real-FFmpeg decode, gated on real `ffmpeg`/`ffprobe` binaries being on PATH (mirrors
// mux.test.ts's real-FFmpeg smoke test pattern rather than duplicating a new one).
// ---------------------------------------------------------------------------------------------

function probeBinaryAvailable(cmd: string): boolean {
  try {
    const result = spawnSync(cmd, ["-version"], { stdio: "ignore" });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}

const realFfmpegAvailable = probeBinaryAvailable("ffmpeg") && probeBinaryAvailable("ffprobe");
if (!realFfmpegAvailable) {
  console.warn(
    "[decode.test.ts] Skipping the real-FFmpeg decode test: no working `ffmpeg`/`ffprobe` binary " +
      "found on PATH in this environment. This does not indicate a defect in decode.ts — run this " +
      "file on a machine with a real FFmpeg install to actually exercise decodeAudioFile against " +
      "real FFmpeg/ffprobe output.",
  );
}

const tmpPaths: string[] = [];
function tmpPath(label: string): string {
  const p = path.join(os.tmpdir(), `claudevid-decode-test-${randomUUID()}-${label}`);
  tmpPaths.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpPaths.splice(0)) {
    fs.rmSync(p, { force: true });
  }
});

(realFfmpegAvailable ? describe : describe.skip)("decodeAudioFile — real FFmpeg decode (AC9)", () => {
  it("decodes a 1s 44.1kHz sine WAV to ~24000 samples of mono 24kHz 16-bit PCM, passing the probe cross-check", async () => {
    const srcPath = tmpPath("sine.wav");
    spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", srcPath]);
    expect(fs.existsSync(srcPath)).toBe(true);

    const result = await decodeAudioFile(srcPath);

    expect(result.sampleRate).toBe(VOICE_TRACK_SAMPLE_RATE);
    const sampleCount = result.audio.length / 2; // 16-bit mono: 2 bytes per sample
    expect(Math.abs(sampleCount - 24000)).toBeLessThanOrEqual(24);
  }, 30000);
});
