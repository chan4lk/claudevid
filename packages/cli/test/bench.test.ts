// `claudevid bench` command logic tests (spec.md FR14/AC9). `runBench` is injected (NFR3) — no
// real FFmpeg/canvas pipeline invoked.

import { describe, expect, it } from "vitest";

import { runBenchCommand, type BenchDeps } from "../src/commands/bench.js";

describe("runBenchCommand (FR14/AC9)", () => {
  it("resolves ok:true when runBench resolves", async () => {
    const deps: BenchDeps = {
      runBench: async () => {},
    };

    const result = await runBenchCommand([], deps);

    expect(result.ok).toBe(true);
  });

  it("resolves ok:false with the thrown error's message when runBench rejects", async () => {
    const deps: BenchDeps = {
      runBench: async () => {
        throw new Error("ffmpeg not found");
      },
    };

    const result = await runBenchCommand([], deps);

    expect(result.ok).toBe(false);
    expect(result.message).toBe("ffmpeg not found");
  });
});
