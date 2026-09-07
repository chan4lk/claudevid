// `claudevid bench` (spec.md FR14/AC9, design.md D6: "thin wrapper, not a reimplementation").
// `runBench` itself (render/encode timing, the scaled-target report) already exists and is
// already tested in `tools/bench` (change 005) — this file adds only argv plumbing and exit
// code, per Rule 2 (Simplicity First).

import { runBench as runBenchReal } from "@claudevid/bench";

export interface BenchDeps {
  runBench: (argv: string[]) => Promise<void>;
}

/**
 * Pure command logic, testable with an injected `runBench` fake (NFR3) — no real FFmpeg/canvas
 * pipeline invoked. Never lets a rejection propagate: catches it and turns it into
 * `{ ok: false, message }` so the CLI wrapper below can print and exit cleanly.
 */
export async function runBenchCommand(
  argv: string[],
  deps: BenchDeps,
): Promise<{ ok: boolean; message: string }> {
  try {
    await deps.runBench(argv);
    return { ok: true, message: "bench complete" };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/**
 * Real (non-DI) entry point. Wires up the real `@claudevid/bench` `runBench`, prints the result
 * message, and sets `process.exitCode` — called by `cli.ts`'s command dispatch.
 */
export async function runBenchFromCli(argv: string[]): Promise<void> {
  const { ok, message } = await runBenchCommand(argv, { runBench: runBenchReal });
  console.log(message);
  process.exitCode = ok ? 0 : 1;
}
