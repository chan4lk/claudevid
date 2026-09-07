// Zero-FFmpeg unit tests for temp.ts (spec.md AC10). Covers the directory lifecycle directly
// (real filesystem, no fakes needed — `createTempRun`/`cleanup` only ever touch `fs`) plus a
// signal-handling test that stands a dummy long-running child process (`sleep`) in for FFmpeg,
// per spec.md's explicit "no live FFmpeg needed for this test" note and the task's Edge Case
// notes. No FFmpeg binary is spawned anywhere in this file (spec.md NFR4).
//
// The signal test can't send SIGTERM to *this* vitest process (that would kill the whole test
// run), so it spawns a small standalone script in a separate child process, has that script
// create its own `TempRun` + register its own dummy `sleep` grandchild, and sends SIGTERM to
// that script's process instead — mirroring exactly the shape spec.md AC10 describes ("a child
// process that creates a TempRun, registers a long-running dummy child, and receives SIGTERM
// from its parent"). The script imports `temp.ts` directly (not a built `dist/` artifact) via
// Node's `--experimental-strip-types` flag, so it always runs the real, current source with no
// separate build step for the test to depend on.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTempRun } from "../src/temp.js";

/** Absolute path to the real `temp.ts` source, for the standalone script (below) to import. */
const TEMP_TS_PATH = fileURLToPath(new URL("../src/temp.ts", import.meta.url));

describe("createTempRun (AC10) — directory lifecycle", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  it("creates the directory on disk immediately (synchronously) after createTempRun returns", () => {
    const run = createTempRun();
    cleanups.push(run.cleanup);

    expect(fs.existsSync(run.dir)).toBe(true);
    expect(fs.statSync(run.dir).isDirectory()).toBe(true);
    expect(path.basename(run.dir)).toMatch(/^claudevid-encode-/);
  });

  it("removes the directory once cleanup() resolves", async () => {
    const run = createTempRun();

    expect(fs.existsSync(run.dir)).toBe(true);
    await run.cleanup();
    expect(fs.existsSync(run.dir)).toBe(false);
  });

  it("cleanup() is idempotent — calling it a second time does not throw or reject", async () => {
    const run = createTempRun();

    await expect(run.cleanup()).resolves.toBeUndefined();
    await expect(run.cleanup()).resolves.toBeUndefined();
    expect(fs.existsSync(run.dir)).toBe(false);
  });

  it("names each run uniquely under the given baseDir", () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudevid-test-basedir-"));
    cleanups.push(() => fs.promises.rm(baseDir, { recursive: true, force: true }));

    const runA = createTempRun(baseDir);
    const runB = createTempRun(baseDir);
    cleanups.push(runA.cleanup, runB.cleanup);

    expect(runA.dir).not.toBe(runB.dir);
    expect(path.dirname(runA.dir)).toBe(baseDir);
    expect(path.dirname(runB.dir)).toBe(baseDir);
  });
});

describe("createTempRun (AC10) — SIGTERM handling via a dummy child process", () => {
  it(
    "a SIGTERM'd process kills its registered dummy child and removes its temp dir",
    async () => {
      const scriptPath = path.join(os.tmpdir(), `claudevid-temp-signal-test-${randomUUID()}.mjs`);
      // A minimal standalone script: create a TempRun, spawn a dummy long-running child (`sleep`,
      // standing in for FFmpeg per the task notes — never a real FFmpeg process), register it,
      // then report its own pid/dir/child-pid over stdout once the child has actually spawned.
      // Everything after that is `temp.ts`'s own SIGINT/SIGTERM handler doing the work under
      // test — this script adds no signal handling of its own.
      const script = [
        `import { createTempRun } from ${JSON.stringify(TEMP_TS_PATH)};`,
        `import { spawn } from "node:child_process";`,
        ``,
        `const run = createTempRun();`,
        `const child = spawn("sleep", ["30"]);`,
        `run.registerChild(child);`,
        `child.on("spawn", () => {`,
        `  process.stdout.write(JSON.stringify({ dir: run.dir, childPid: child.pid }) + "\\n");`,
        `});`,
        ``,
      ].join("\n");
      fs.writeFileSync(scriptPath, script);

      const runner = spawn(process.execPath, ["--experimental-strip-types", scriptPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      try {
        const setup = await Promise.race<{ dir: string; childPid: number }>([
          new Promise((resolve) => {
            let buffered = "";
            runner.stdout?.on("data", (chunk: Buffer) => {
              buffered += chunk.toString();
              const newlineIndex = buffered.indexOf("\n");
              if (newlineIndex !== -1) resolve(JSON.parse(buffered.slice(0, newlineIndex)));
            });
          }),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error("timed out waiting for the standalone script to report setup")),
              5000,
            );
          }),
        ]);

        // Sanity: the dummy grandchild is genuinely alive and the dir genuinely exists before we
        // ever send a signal — `kill(pid, 0)` is a pure liveness probe, it sends no real signal.
        expect(fs.existsSync(setup.dir)).toBe(true);
        expect(() => process.kill(setup.childPid, 0)).not.toThrow();

        const exited = new Promise<void>((resolve) => runner.once("exit", () => resolve()));
        runner.kill("SIGTERM");
        await exited;

        // The runner's own SIGTERM handler (temp.ts's) sends SIGTERM to the grandchild and then
        // removes the dir before calling process.exit(0) — it does not wait for the grandchild to
        // actually finish dying, so allow a brief grace window for that liveness probe to flip.
        await vi.waitFor(
          () => {
            expect(() => process.kill(setup.childPid, 0)).toThrow();
          },
          { timeout: 5000, interval: 50 },
        );

        expect(fs.existsSync(setup.dir)).toBe(false);
      } finally {
        fs.rmSync(scriptPath, { force: true });
        if (!runner.killed) runner.kill("SIGKILL");
      }
    },
    15000,
  );
});
