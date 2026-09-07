// Capability detection with an injectable spawn seam (spec.md FR1, design.md's `probe.ts`
// section). `probe.ts` only ever *detects* — it never resolves a codec (that's `profiles.ts`)
// and never constructs an FFmpeg command line (that's `argv.ts`).

import { spawn } from "node:child_process";

import type { EncoderCapabilities } from "./types.js";

/** Result of a single `ffmpeg <args>` capture attempt. `ok: false` means the spawn itself
 * failed (e.g. `ENOENT` — the binary isn't on PATH) rather than that FFmpeg exited non-zero. */
interface CaptureResult {
  ok: boolean;
  stdout: string;
}

/** Runs `ffmpeg <args>` via the injected `execFn`, collects stdout, and resolves
 * `{ ok: false, stdout: "" }` on a spawn `error` event (covers `ENOENT` — binary missing
 * entirely — and any other spawn failure) rather than letting it throw or reject. */
function runCapture(execFn: typeof spawn, args: string[]): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: CaptureResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = execFn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      settle({ ok: false, stdout: "" });
      return;
    }

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.once("error", () => {
      settle({ ok: false, stdout: "" });
    });
    child.once("close", () => {
      settle({ ok: true, stdout });
    });
  });
}

/** Extracts a human-readable version string from `ffmpeg -version`'s stdout — the first
 * line's `ffmpeg version <token>`, falling back to the raw first line if the expected shape
 * isn't found. Best-effort only; no AC depends on its exact format. */
function parseVersionLine(stdout: string): string | undefined {
  const match = /^ffmpeg version (\S+)/m.exec(stdout);
  if (match) return match[1];
  const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim();
  return firstLine ? firstLine : undefined;
}

/** Probes exactly the two codecs `preview`/`final` need (spec.md FR1) — `h264_videotoolbox`
 * and `libx264`, **not** the original four-codec proposal. `execFn` defaults to the real
 * `child_process.spawn` so production call sites can call `probe()` with no arguments; a test
 * injects a fake `execFn` that returns an `EventEmitter`-shaped fake child process (no real
 * FFmpeg needed) to exercise both the "present" and "absent" paths (AC1/AC2). */
export async function probe(execFn: typeof spawn = spawn): Promise<EncoderCapabilities> {
  const versionResult = await runCapture(execFn, ["-version"]);
  if (!versionResult.ok) {
    return { ffmpegPresent: false, h264_videotoolbox: false, libx264: false };
  }

  const ffmpegVersion = parseVersionLine(versionResult.stdout);
  const encodersResult = await runCapture(execFn, ["-hide_banner", "-encoders"]);
  const stdout = encodersResult.ok ? encodersResult.stdout : "";

  return {
    ffmpegPresent: true,
    ffmpegVersion,
    h264_videotoolbox: /\bh264_videotoolbox\b/.test(stdout),
    libx264: /\blibx264\b/.test(stdout),
  };
}
