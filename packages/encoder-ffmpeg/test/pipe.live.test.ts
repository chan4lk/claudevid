// Live-FFmpeg tests for pipe.ts (spec.md AC8/AC9/AC11/AC12), deliberately split out of
// progress-parse.test.ts (spec.md's "CI cost budget" / Risks section — this file is isolatable
// if a runner lacks an FFmpeg binary, whereas progress-parse.test.ts never needs one). Every
// test here spawns a real FFmpeg process, but each operates on a synthetic clip capped at a
// handful of frames and a small resolution (never the 30-minute bench target) and forces
// `cpuEncode: true` so it runs `libx264` — the CI-portable path on a runner (like this sandbox)
// that has no VideoToolbox — per NFR4's "low single-digit seconds total" budget for the whole
// FFmpeg-dependent slice of the suite.
//
// AC9 is the one exception to that time budget: this sandbox's FFmpeg build does not act on
// SIGTERM while blocked reading stdin (confirmed empirically — the child sits alive through the
// full `CANCEL_GRACE_MS` grace window), so `cancel()` only actually terminates it via the
// SIGKILL escalation `pipe.ts` performs after that grace period. That single test genuinely
// takes ~5s wall-clock as a result; it is not a test bug, it is `cancel()`'s designed escalation
// path actually firing for real.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createEncodePipe } from "../src/pipe.js";
import type { EncoderCapabilities, ProgressEvent } from "../src/types.js";

/** This sandbox's real, probed shape (libx264 present, no VideoToolbox — confirmed via
 * `ffmpeg -encoders`) — every test still passes `cpuEncode: true` explicitly so the resolved
 * codec is deterministic regardless of what `capabilities` claims (profiles.ts, AC5/AC6). */
const CAPABILITIES: EncoderCapabilities = {
  ffmpegPresent: true,
  h264_videotoolbox: false,
  libx264: true,
};

const tmpFiles: string[] = [];

function tmpOutputPath(label: string): string {
  const p = path.join(os.tmpdir(), `claudevid-pipe-live-${label}-${randomUUID()}.mp4`);
  tmpFiles.push(p);
  return p;
}

afterAll(() => {
  for (const p of tmpFiles.splice(0)) {
    fs.rmSync(p, { force: true });
  }
});

/** A solid-colour RGBA frame — every pixel set to the same `[r, g, b, a]` (AC11). */
function solidFrame(width: number, height: number, r: number, g: number, b: number, a: number): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  }
  return buf;
}

/** A synthetic high-contrast "text-like" pattern (AC12/FR7): a black background with a grid of
 * white rectangular blocks standing in for glyphs — no real font rendering needed to exercise
 * the encoder's compression behavior around hard edges (spec.md FR7's note that a simple
 * generated pattern is sufficient). */
function textPatternFrame(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  const cell = 8;
  const glyphMargin = 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx = Math.floor(x / cell);
      const gy = Math.floor(y / cell);
      const isGlyphCell = (gx + gy) % 2 === 0;
      const withinGlyph = x % cell < cell - glyphMargin && y % cell < cell - glyphMargin;
      const v = isGlyphCell && withinGlyph ? 255 : 0;
      const o = (y * width + x) * 4;
      buf[o] = v;
      buf[o + 1] = v;
      buf[o + 2] = v;
      buf[o + 3] = 255;
    }
  }
  return buf;
}

/** Spawns `ffmpeg <args>` directly (not via `pipe.ts`) and collects stdout/stderr — the
 * decode-back/SSIM-comparison step for AC11/AC12, which the task deliberately keeps outside
 * `createEncodePipe`'s own argv-construction contract (FR2's single-owner rule only governs the
 * *encode* argv, not ad-hoc verification tooling in this test file). */
function runFfmpeg(args: string[]): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout: Buffer.concat(stdoutChunks), stderr, code }));
  });
}

/** Polls `ps -eo pid,args` for a process whose command line contains both `marker` and
 * `"ffmpeg"`, returning its PID. Used instead of `pgrep -f <marker>` because `pgrep -f` matches
 * against its own argv too (it receives `marker` as one of its own arguments), so it would
 * spuriously "find" itself; filtering `ps`'s output in-process sidesteps that self-match. Polls
 * because `createEncodePipe`'s spawn is fire-and-forget — the child's argv isn't guaranteed
 * visible in the process table the instant `spawn()` returns. */
async function findFfmpegPid(marker: string, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { stdout } = await runPs();
    const line = stdout
      .split("\n")
      .find((l) => l.includes(marker) && l.includes("ffmpeg") && !l.includes("ps -eo"));
    if (line) {
      const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0]!, 10);
      if (Number.isFinite(pid)) return pid;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for an ffmpeg process matching ${marker} to appear`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function runPs(): Promise<{ stdout: string }> {
  return new Promise((resolve) => {
    const ps = spawn("ps", ["-eo", "pid,args"]);
    let stdout = "";
    ps.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    ps.once("close", () => resolve({ stdout }));
  });
}

/** A pure liveness probe (`kill(pid, 0)` sends no real signal — spec.md AC9's own description of
 * this check) — `true` if the process table still has `pid`, `false` once it's truly gone
 * (`ESRCH`). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("createEncodePipe (AC8) — ProgressEvent.frame sequence, real FFmpeg", () => {
  it(
    "emits a strictly increasing frame sequence that ends at the true frame count",
    async () => {
      const width = 320;
      const height = 240;
      const fps = 25;
      const frameCount = 30;
      const outputPath = tmpOutputPath("ac8");

      const pipe = createEncodePipe({
        profileName: "final",
        geometry: { width, height, fps },
        outputPath,
        capabilities: CAPABILITIES,
        cpuEncode: true,
      });

      const events: ProgressEvent[] = [];
      pipe.onProgress((event) => events.push(event));

      for (let i = 0; i < frameCount; i++) {
        // A simple per-frame gradient — content doesn't matter for this AC, only that
        // `frameCount` distinct raw frames actually reach FFmpeg's stdin.
        const shade = Math.floor((i / frameCount) * 255);
        await pipe.write(solidFrame(width, height, shade, shade, shade, 255));
      }
      await pipe.finish();

      // A clip this small/fast may legitimately produce just FFmpeg's single final progress
      // line rather than several periodic updates (FFmpeg throttles -stats output to roughly
      // twice a second of wall-clock, and this whole encode finishes in well under that) — so
      // this asserts "strictly increasing" generically over however many events actually
      // arrived (vacuously true for a 1-element sequence) rather than assuming multiple.
      expect(events.length).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < events.length; i++) {
        expect(events[i]!.frame).toBeGreaterThan(events[i - 1]!.frame);
      }
      expect(events.at(-1)!.frame).toBe(frameCount);
    },
    15000,
  );
});

describe("createEncodePipe (AC9) — cancel() leaves zero live FFmpeg processes", () => {
  it(
    "cancel() mid-encode resolves and the spawned ffmpeg process is no longer alive",
    async () => {
      const width = 320;
      const height = 240;
      const fps = 25;
      const outputPath = tmpOutputPath("ac9");
      const marker = path.basename(outputPath);

      const pipe = createEncodePipe({
        profileName: "final",
        geometry: { width, height, fps },
        outputPath,
        capabilities: CAPABILITIES,
        cpuEncode: true,
      });

      // Write a few frames but deliberately never call finish() — stdin stays open, so FFmpeg
      // stays genuinely alive blocked on more input, guaranteeing cancel() below has a live
      // process to actually cancel rather than racing an encode that may have already exited.
      for (let i = 0; i < 5; i++) {
        await pipe.write(solidFrame(width, height, 100, 100, 100, 255));
      }

      const pid = await findFfmpegPid(marker);
      expect(isAlive(pid)).toBe(true);

      await pipe.cancel();

      expect(isAlive(pid)).toBe(false);
    },
    // cancel() SIGTERMs first and only escalates to SIGKILL after CANCEL_GRACE_MS (5000ms) if
    // the process hasn't exited by then — this sandbox's FFmpeg build does not exit on SIGTERM
    // while blocked reading stdin, so this test genuinely rides out the full grace window before
    // the SIGKILL escalation actually terminates it. 15s gives that comfortable headroom.
    15000,
  );
});

describe("createEncodePipe (AC11) — single-frame known-colour round trip", () => {
  it(
    "a solid pure-red frame decodes back close to pure red after encode",
    async () => {
      const width = 64;
      const height = 64;
      const fps = 25;
      const outputPath = tmpOutputPath("ac11");
      const sourceColor = [255, 0, 0, 255] as const;

      const pipe = createEncodePipe({
        profileName: "final",
        geometry: { width, height, fps },
        outputPath,
        capabilities: CAPABILITIES,
        cpuEncode: true,
      });

      await pipe.write(solidFrame(width, height, ...sourceColor));
      await pipe.finish();

      const { stdout, code } = await runFfmpeg([
        "-y",
        "-i",
        outputPath,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-vframes",
        "1",
        "-",
      ]);
      expect(code).toBe(0);
      expect(stdout.length).toBe(width * height * 4);

      // Small numeric tolerance (spec.md AC11) accounting for lossy compression and RGB<->YUV
      // rounding — sample several pixels (corners + center), not just one, so a
      // localized decode artifact can't slip past a single lucky sample.
      const tolerance = 12;
      const samples = [
        0,
        (width - 1) * 4,
        (height - 1) * width * 4,
        ((height - 1) * width + (width - 1)) * 4,
        (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4,
      ];
      for (const offset of samples) {
        expect(Math.abs(stdout[offset]! - sourceColor[0])).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(stdout[offset + 1]! - sourceColor[1])).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(stdout[offset + 2]! - sourceColor[2])).toBeLessThanOrEqual(tolerance);
      }
    },
    15000,
  );
});

describe("createEncodePipe (AC12/FR7) — SSIM quality gate on a text-pattern frame", () => {
  it(
    "a high-contrast text-pattern frame scores SSIM >= 0.92 against its decoded-back self",
    async () => {
      const width = 320;
      const height = 240;
      const fps = 25;
      const outputPath = tmpOutputPath("ac12");
      const rawSourcePath = path.join(os.tmpdir(), `claudevid-pipe-live-ac12-src-${randomUUID()}.raw`);
      tmpFiles.push(rawSourcePath);

      const frame = textPatternFrame(width, height);
      fs.writeFileSync(rawSourcePath, frame);

      const pipe = createEncodePipe({
        profileName: "final", // final profile's default bitrate is 18000 kbps (FR6) — AC12 pins
        // the gate to exactly that bitrate, so this deliberately does not pass cpuEncode-style
        // bitrate overrides.
        geometry: { width, height, fps },
        outputPath,
        capabilities: CAPABILITIES,
        cpuEncode: true,
      });
      await pipe.write(frame);
      await pipe.finish();

      // Compares the raw source frame directly against the encoded file's decoded frame via
      // FFmpeg's own -lavfi ssim filter — no separate manual decode step needed, FFmpeg decodes
      // `outputPath` internally as the filter's second input.
      const { stderr, code } = await runFfmpeg([
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-s",
        `${width}x${height}`,
        "-i",
        rawSourcePath,
        "-i",
        outputPath,
        "-lavfi",
        "[0:v]format=yuv420p[src];[1:v]format=yuv420p[enc];[src][enc]ssim",
        "-f",
        "null",
        "-",
      ]);
      expect(code).toBe(0);

      const match = /All:([\d.]+)/.exec(stderr);
      expect(match).not.toBeNull();
      const ssim = Number(match![1]);
      expect(ssim).toBeGreaterThanOrEqual(0.92); // spec.md FR7's pinned floor
    },
    15000,
  );
});
