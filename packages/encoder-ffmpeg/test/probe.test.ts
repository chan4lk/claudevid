// Zero-FFmpeg unit tests for probe.ts (spec.md AC1/AC2). Every `execFn` here is a fake that
// returns an EventEmitter-shaped fake child process — no real `child_process.spawn` call, no
// real FFmpeg binary needed to run this file (spec.md NFR4).

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { probe } from "../src/probe.js";

/** Minimal fake `ChildProcess`: an `EventEmitter` with a `.stdout` that is itself an
 * `EventEmitter` (so `child.stdout?.on("data", ...)` works), matching exactly the shape
 * `probe.ts`'s `runCapture` consumes (`.stdout.on("data", ...)`, `.once("error", ...)`,
 * `.once("close", ...)`). No real process is spawned. */
function makeFakeChild(): EventEmitter & { stdout: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
  child.stdout = new EventEmitter();
  return child;
}

/** Builds a fake `execFn` (matching `typeof spawn`'s call shape `execFn(cmd, args, opts)`)
 * whose fake child emits `data` on stdout with `stdout`, then a `close` event on the next
 * microtask — one fake child per call, in `responses` order. */
function fakeExecFnWithStdout(...responses: string[]): typeof import("node:child_process").spawn {
  let callIndex = 0;
  return ((_cmd: string, _args: string[], _opts?: unknown) => {
    const child = makeFakeChild();
    const stdout = responses[callIndex] ?? "";
    callIndex += 1;
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", 0);
    });
    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  }) as typeof import("node:child_process").spawn;
}

/** Builds a fake `execFn` whose fake child always emits an `error` event (e.g. simulating
 * `ENOENT` — FFmpeg entirely absent from PATH) instead of ever closing. */
function fakeExecFnAlwaysErrors(): typeof import("node:child_process").spawn {
  return ((_cmd: string, _args: string[], _opts?: unknown) => {
    const child = makeFakeChild();
    queueMicrotask(() => {
      const err = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
      child.emit("error", err);
    });
    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  }) as typeof import("node:child_process").spawn;
}

describe("probe (AC1) — FFmpeg entirely absent", () => {
  it("resolves (does not throw/reject) with all capabilities false when spawn emits an ENOENT error", async () => {
    const execFn = fakeExecFnAlwaysErrors();
    await expect(probe(execFn)).resolves.toEqual({
      ffmpegPresent: false,
      h264_videotoolbox: false,
      libx264: false,
    });
  });
});

describe("probe (AC2) — canned `ffmpeg -encoders` output", () => {
  it("reports both encoders present when the -encoders output lists both", async () => {
    const versionStdout = "ffmpeg version 6.0 Copyright (c) 2000-2023\n";
    const encodersStdout = [
      "Encoders:",
      " V..... h264_videotoolbox     VideoToolbox H.264 Encoder (codec h264)",
      " V..... libx264               libx264 H.264 / AVC / MPEG-4 AVC (codec h264)",
      "",
    ].join("\n");
    const execFn = fakeExecFnWithStdout(versionStdout, encodersStdout);

    const result = await probe(execFn);

    expect(result).toEqual({
      ffmpegPresent: true,
      ffmpegVersion: "6.0",
      h264_videotoolbox: true,
      libx264: true,
    });
  });

  it("reports libx264 present but h264_videotoolbox absent when only libx264 is listed", async () => {
    const versionStdout = "ffmpeg version 6.0 Copyright (c) 2000-2023\n";
    const encodersStdout = [
      "Encoders:",
      " V..... libx264               libx264 H.264 / AVC / MPEG-4 AVC (codec h264)",
      "",
    ].join("\n");
    const execFn = fakeExecFnWithStdout(versionStdout, encodersStdout);

    const result = await probe(execFn);

    expect(result).toEqual({
      ffmpegPresent: true,
      ffmpegVersion: "6.0",
      h264_videotoolbox: false,
      libx264: true,
    });
  });

  it("reports neither encoder present when the -encoders output lists neither", async () => {
    const versionStdout = "ffmpeg version 6.0 Copyright (c) 2000-2023\n";
    const encodersStdout = ["Encoders:", " V..... mpeg4                 MPEG-4 part 2", ""].join(
      "\n",
    );
    const execFn = fakeExecFnWithStdout(versionStdout, encodersStdout);

    const result = await probe(execFn);

    expect(result).toEqual({
      ffmpegPresent: true,
      ffmpegVersion: "6.0",
      h264_videotoolbox: false,
      libx264: false,
    });
  });
});
