// Tests for mux.ts (spec.md FR8, AC8).
//
// Core logic (temp+rename discipline, overwrite refusal, duration-tolerance check) is exercised
// with an injected `spawnFn` that returns an `EventEmitter`-shaped fake child process — no real
// FFmpeg process runs for any test in the first two describe blocks, mirroring
// `encoder-ffmpeg/test/probe.test.ts`'s injection pattern. The duration-tolerance check itself is
// exercised via an injected `probeDurationSecondsFn` (a fake duration-probe function, per this
// task's brief) rather than faking `ffprobe`'s stdout — a smaller, more direct seam for the same
// property.
//
// A final gated block runs `muxOutput` against a REAL `ffmpeg`/`ffprobe` (no injected seams at
// all), mirroring `graph.test.ts`'s AC7 real-FFmpeg block's probe-once/skip-gracefully pattern —
// this is what actually validates the duration-tolerance check against real FFmpeg/ffprobe
// output, not just the injected-seam structural tests above it.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync, type spawn as SpawnFn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  MuxDurationMismatchError,
  MuxError,
  MuxOutputExistsError,
  MuxSamePathError,
  muxOutput,
  probeDurationSeconds,
  type MuxOptions,
} from "../src/mux.js";

type SpawnType = typeof SpawnFn;

/** Minimal fake `ChildProcess`: an `EventEmitter` with `.stdout`/`.stderr` themselves
 * `EventEmitter`s — matches exactly the shape `mux.ts`'s `runFfmpeg`/`probeDurationSeconds`
 * consume. No real process is ever spawned by these fakes. */
function makeFakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

interface FakeCallResult {
  code: number;
  stderrLines?: string[];
  /** Whether to write a dummy file at this invocation's output path (argv's last element) before
   * exiting — models what a real, successful FFmpeg invocation would have produced. Defaults to
   * `code === 0`. */
  writeOutput?: boolean;
}

/** Builds a fake `spawnFn` (matching `typeof spawn`'s call shape) that serves one `FakeCallResult`
 * per call, in order. Each fake child emits its configured stderr lines, optionally writes a
 * dummy file at `args.at(-1)` (mirroring where `mux.ts` always places its output path), then
 * emits `close`+`exit` with the configured code on the next microtask. Records every `(cmd, args)`
 * pair it was called with, so a test can assert exactly what got spawned. */
function fakeSpawnSequence(results: FakeCallResult[]): { spawnFn: SpawnType; calls: Array<{ cmd: string; args: string[] }> } {
  let callIndex = 0;
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawnFn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const result = results[callIndex] ?? { code: 0 };
    callIndex += 1;
    const child = makeFakeChild();
    queueMicrotask(() => {
      for (const line of result.stderrLines ?? []) {
        child.stderr.emit("data", Buffer.from(line + "\n"));
      }
      const shouldWrite = result.writeOutput ?? result.code === 0;
      if (shouldWrite) {
        const outPath = args.at(-1)!;
        fs.writeFileSync(outPath, "fake-ffmpeg-output");
      }
      child.emit("exit", result.code);
    });
    return child as unknown as ReturnType<SpawnType>;
  }) as SpawnType;
  return { spawnFn, calls };
}

/** Lists every file in `outputPath`'s directory whose name starts with `outputPath`'s basename
 * MINUS its extension (mirrors `mux.ts`'s own temp-naming scheme, which strips the extension
 * before inserting `.<pid>.<ts>.tmp` and re-appending it, so a real leftover temp file's name
 * doesn't literally start with the full `<base>.<ext>` string). Excludes `outputPath` itself. */
function leftoverFilesFor(outputPath: string): string[] {
  const dir = path.dirname(outputPath);
  const ext = path.extname(outputPath);
  const stem = path.basename(outputPath, ext);
  const finalBase = path.basename(outputPath);
  return fs.readdirSync(dir).filter((name) => name.startsWith(stem) && name !== finalBase);
}

const tmpPaths: string[] = [];
function tmpPath(label: string): string {
  // `randomUUID()` goes BEFORE `label` (rather than between label and any extension label
  // carries, e.g. "foo.mp4") so a label like "real-silent.mp4" still ends in a real ".mp4"
  // extension — real `ffmpeg`/`ffprobe` invocations in the smoke test below infer their
  // container/format from the output path's extension.
  const p = path.join(os.tmpdir(), `claudevid-mux-test-${randomUUID()}-${label}`);
  tmpPaths.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpPaths.splice(0)) {
    fs.rmSync(p, { force: true });
  }
});

function baseOptions(overrides: Partial<MuxOptions> = {}): MuxOptions {
  return {
    silentVideoPath: tmpPath("silent-video.mp4"),
    audioGraphArgv: ["-i", tmpPath("voice.wav"), "-filter_complex", "[0:a]anull[out]", "-map", "[out]"],
    outputPath: tmpPath("output.mp4"),
    probeDurationSecondsFn: async () => 5,
    ...overrides,
  };
}

describe("muxOutput — distinct-path requirement", () => {
  it("throws MuxSamePathError when outputPath equals silentVideoPath, without spawning anything", async () => {
    const samePath = tmpPath("same.mp4");
    const { spawnFn, calls } = fakeSpawnSequence([{ code: 0 }, { code: 0 }]);
    await expect(
      muxOutput(baseOptions({ silentVideoPath: samePath, outputPath: samePath, spawnFn })),
    ).rejects.toThrow(MuxSamePathError);
    expect(calls.length).toBe(0);
  });
});

describe("muxOutput — overwrite refusal (spec.md FR8/AC8)", () => {
  it("refuses to overwrite an existing output without force, without spawning anything", async () => {
    const outputPath = tmpPath("existing.mp4");
    fs.writeFileSync(outputPath, "pre-existing content");
    const { spawnFn, calls } = fakeSpawnSequence([{ code: 0 }, { code: 0 }]);

    await expect(muxOutput(baseOptions({ outputPath, spawnFn }))).rejects.toThrow(MuxOutputExistsError);
    expect(calls.length).toBe(0);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("pre-existing content");
  });

  it("succeeds and overwrites when force: true", async () => {
    const outputPath = tmpPath("existing.mp4");
    fs.writeFileSync(outputPath, "pre-existing content");
    const { spawnFn } = fakeSpawnSequence([{ code: 0 }, { code: 0 }]);

    await muxOutput(baseOptions({ outputPath, force: true, spawnFn }));

    expect(fs.readFileSync(outputPath, "utf8")).toBe("fake-ffmpeg-output");
  });
});

describe("muxOutput — non-zero exit leaves no file behind (spec.md FR8/AC8)", () => {
  it("a non-zero exit from the compose-audio stage leaves no file at temp or final path", async () => {
    const outputPath = tmpPath("out.mp4");
    const { spawnFn } = fakeSpawnSequence([{ code: 1, stderrLines: ["bad filter graph"] }]);

    let caught: unknown;
    try {
      await muxOutput(baseOptions({ outputPath, spawnFn }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MuxError);
    expect((caught as MuxError).stage).toBe("compose-audio");
    expect((caught as MuxError).stderrTail).toContain("bad filter graph");

    expect(leftoverFilesFor(outputPath)).toEqual([]);
  });

  it("a non-zero exit from the mux stage leaves no file at temp or final path (including the intermediate audio file)", async () => {
    const outputPath = tmpPath("out.mp4");
    const { spawnFn } = fakeSpawnSequence([
      { code: 0 }, // compose-audio succeeds, writes the intermediate audio temp file
      { code: 1, stderrLines: ["codec mismatch"], writeOutput: false },
    ]);

    let caught: unknown;
    try {
      await muxOutput(baseOptions({ outputPath, spawnFn }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MuxError);
    expect((caught as MuxError).stage).toBe("mux");

    expect(leftoverFilesFor(outputPath)).toEqual([]);
  });
});

describe("muxOutput — success path (spec.md FR8/AC8)", () => {
  it("renames the temp output to the final path on a clean exit + matching durations", async () => {
    const outputPath = tmpPath("out.mp4");
    const { spawnFn, calls } = fakeSpawnSequence([{ code: 0 }, { code: 0 }]);

    await muxOutput(baseOptions({ outputPath, spawnFn }));

    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("fake-ffmpeg-output");
    // No temp files left behind alongside the final path.
    expect(leftoverFilesFor(outputPath)).toEqual([]);
    // Exactly two FFmpeg invocations: compose-audio, then mux.
    expect(calls.length).toBe(2);
  });

  it("never touches silentVideoPath", async () => {
    const silentVideoPath = tmpPath("silent.mp4");
    fs.writeFileSync(silentVideoPath, "original silent video bytes");
    const outputPath = tmpPath("out.mp4");
    const { spawnFn } = fakeSpawnSequence([{ code: 0 }, { code: 0 }]);

    await muxOutput(baseOptions({ silentVideoPath, outputPath, spawnFn }));

    expect(fs.readFileSync(silentVideoPath, "utf8")).toBe("original silent video bytes");
  });
});

describe("muxOutput — duration-tolerance check (spec.md FR8/AC8)", () => {
  it("passes when durations match within the default tolerance", async () => {
    const outputPath = tmpPath("out.mp4");
    const { spawnFn } = fakeSpawnSequence([{ code: 0 }, { code: 0 }]);

    await expect(
      muxOutput(
        baseOptions({
          outputPath,
          spawnFn,
          probeDurationSecondsFn: async (filePath) => (filePath === outputPath ? 10.02 : 10.0),
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("throws MuxDurationMismatchError naming both durations when they differ beyond tolerance, leaving no file behind", async () => {
    const silentVideoPath = tmpPath("silent2.mp4");
    const outputPath = tmpPath("out2.mp4");
    const { spawnFn } = fakeSpawnSequence([{ code: 0 }, { code: 0 }]);

    let caught: unknown;
    try {
      await muxOutput(
        baseOptions({
          silentVideoPath,
          outputPath,
          spawnFn,
          durationToleranceSeconds: 0.05,
          // mux.ts probes the still-temp output path (not the final outputPath, which doesn't
          // exist yet at probe time) and the silent video path.
          probeDurationSecondsFn: async (filePath) => (filePath === silentVideoPath ? 10.0 : 8.5),
        }),
      );
      throw new Error("expected muxOutput to throw MuxDurationMismatchError");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MuxDurationMismatchError);
    const mismatch = caught as MuxDurationMismatchError;
    expect(mismatch.silentVideoDurationSeconds).toBe(10.0);
    expect(mismatch.outputDurationSeconds).toBe(8.5);
    expect(mismatch.message).toContain("10");
    expect(mismatch.message).toContain("8.5");

    expect(leftoverFilesFor(outputPath)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Real-FFmpeg smoke test, gated on real `ffmpeg`/`ffprobe` binaries being on PATH (mirrors
// graph.test.ts's AC7 probe-once/skip-gracefully pattern). Exercises the ENTIRE pipeline with no
// injected seams at all: two real FFmpeg invocations (compose-audio, mux) plus two real `ffprobe`
// duration probes — this is what actually validates the duration-tolerance check's arithmetic
// against real FFmpeg/ffprobe output, not just the injected-seam tests above.
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
    "[mux.test.ts] Skipping the real-FFmpeg smoke test: no working `ffmpeg`/`ffprobe` binary " +
      "found on PATH in this environment. This does not indicate a defect in mux.ts — run this " +
      "file on a machine with a real FFmpeg install to actually exercise the duration-tolerance " +
      "check against real ffprobe output.",
  );
}

(realFfmpegAvailable ? describe : describe.skip)("muxOutput — real FFmpeg smoke test", () => {
  it("muxes a real silent video against a real composed audio track, with matching durations", async () => {
    const silentVideoPath = tmpPath("real-silent.mp4");
    const voicePath = tmpPath("real-voice.wav");
    const outputPath = tmpPath("real-out.mp4");

    // 2-second black silent video, no audio stream — mirrors 005's silent encode output shape.
    spawnSync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64:d=2",
      "-r",
      "10",
      "-pix_fmt",
      "yuv420p",
      silentVideoPath,
    ]);
    // 2-second sine-wave "voice" track.
    spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", voicePath]);

    expect(fs.existsSync(silentVideoPath)).toBe(true);
    expect(fs.existsSync(voicePath)).toBe(true);

    const audioGraphArgv = ["-i", voicePath, "-filter_complex", "[0:a]anull[out]", "-map", "[out]"];

    // Tolerance here is deliberately looser than the default (0.05s) — the `lavfi color=...:d=2`
    // fixture's frame-quantized duration comes out at ~2.2s (22 frames @ 10fps) rather than
    // exactly 2s, a fixture-generation artifact, not something `muxOutput` itself should be
    // forgiving about in production (where durations come from real measured audio/video, not a
    // synthetic lavfi source rounded to whole frames).
    await muxOutput({ silentVideoPath, audioGraphArgv, outputPath, durationToleranceSeconds: 0.3 });

    expect(fs.existsSync(outputPath)).toBe(true);

    const [silentDuration, outputDuration] = await Promise.all([
      probeDurationSeconds(silentVideoPath),
      probeDurationSeconds(outputPath),
    ]);
    expect(Math.abs(silentDuration - 2)).toBeLessThan(0.3);
    expect(Math.abs(outputDuration - silentDuration)).toBeLessThan(0.3);
  }, 30000);

  it("rejects with MuxDurationMismatchError when the composed audio is far shorter than the silent video, without leaving a leftover file", async () => {
    const silentVideoPath = tmpPath("real-silent-long.mp4");
    const voicePath = tmpPath("real-voice-short.wav");
    const outputPath = tmpPath("real-out-mismatch.mp4");

    spawnSync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64:d=4",
      "-r",
      "10",
      "-pix_fmt",
      "yuv420p",
      silentVideoPath,
    ]);
    spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", voicePath]);

    const audioGraphArgv = ["-i", voicePath, "-filter_complex", "[0:a]anull[out]", "-map", "[out]"];

    // `-shortest` in the mux stage means the real muxed output would itself be ~1s (bounded by
    // the shorter input) while the silent video is ~4s — well beyond any reasonable tolerance.
    await expect(
      muxOutput({ silentVideoPath, audioGraphArgv, outputPath, durationToleranceSeconds: 0.2 }),
    ).rejects.toThrow(MuxDurationMismatchError);

    expect(leftoverFilesFor(outputPath)).toEqual([]);
  }, 30000);
});
