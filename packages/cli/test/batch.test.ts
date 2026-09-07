// `claudevid batch` tests (spec.md FR6/AC8). No filesystem access, no real generate/render
// pipeline — `listFiles`, `readFile`, `writeManifest`, and `runJob` are all injected fakes,
// following tools/motion-preview's dependency-injection test style (see test/render.test.ts).

import { describe, expect, it, vi } from "vitest";

import { ArgError } from "../src/args.js";
import { parseBatchArgs, runBatch, type BatchDeps, type BatchJobResult } from "../src/commands/batch.js";

describe("parseBatchArgs (FR6)", () => {
  it("throws ArgError when the directory is missing", () => {
    expect(() => parseBatchArgs([])).toThrow(ArgError);
  });

  it("defaults concurrency to 1 and render to false", () => {
    const args = parseBatchArgs(["jobs"]);
    expect(args).toEqual({ dir: "jobs", concurrency: 1, render: false });
  });

  it("parses --concurrency and --render", () => {
    const args = parseBatchArgs(["jobs", "--concurrency", "4", "--render"]);
    expect(args).toEqual({ dir: "jobs", concurrency: 4, render: true });
  });

  it("throws ArgError for --concurrency 0 or negative", () => {
    expect(() => parseBatchArgs(["jobs", "--concurrency", "0"])).toThrow(ArgError);
    expect(() => parseBatchArgs(["jobs", "--concurrency", "-1"])).toThrow(ArgError);
    expect(() => parseBatchArgs(["jobs", "--concurrency", "abc"])).toThrow(ArgError);
  });
});

describe("runBatch (FR6/AC8)", () => {
  const JOB1 = "job1.json";
  const JOB2 = "job2.json"; // deliberately malformed JSON
  const JOB3 = "job3.json";

  function threeJobDeps(runJob: BatchDeps["runJob"], writeManifest: BatchDeps["writeManifest"]): BatchDeps {
    return {
      listFiles: () => [JOB1, JOB2, JOB3],
      readFile: (file) => {
        if (file === JOB1) return JSON.stringify({ prompt: "a video about cats" });
        if (file === JOB2) return "{ this is not valid json ]]]";
        if (file === JOB3) return JSON.stringify({ prompt: "a video about dogs" });
        throw new Error(`unexpected file ${file}`);
      },
      writeManifest,
      runJob,
    };
  }

  it("records job1 and job3 as ok, job2 as failed without ever calling runJob for it", async () => {
    const runJob = vi.fn(async () => ({ outputPath: "out.mp4" }));
    const writeManifest = vi.fn();
    const deps = threeJobDeps(runJob, writeManifest);

    const results = await runBatch({ dir: "jobs", concurrency: 1, render: false }, deps);

    expect(results).toEqual([
      { file: JOB1, status: "ok", outputPath: "out.mp4" },
      { file: JOB2, status: "failed", error: expect.any(String) },
      { file: JOB3, status: "ok", outputPath: "out.mp4" },
    ]);

    // job2 fails shape-classification before ever reaching runJob.
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(runJob).not.toHaveBeenCalledWith(JOB2, expect.anything());

    const job2Result = results.find((r) => r.file === JOB2)!;
    expect(job2Result.error).toBeTruthy();
  });

  it("writes the manifest incrementally, and it ends up containing job2's failed result", async () => {
    const runJob = vi.fn(async () => ({ outputPath: "out.mp4" }));
    const writeManifest = vi.fn();
    const deps = threeJobDeps(runJob, writeManifest);

    await runBatch({ dir: "jobs", concurrency: 1, render: false }, deps);

    expect(writeManifest).toHaveBeenCalled();
    expect(writeManifest.mock.calls[0]![0]).toBe("jobs/batch-manifest.json");

    const lastCallManifest = writeManifest.mock.calls[writeManifest.mock.calls.length - 1]![1] as BatchJobResult[];
    expect(lastCallManifest).toContainEqual(
      expect.objectContaining({ file: JOB2, status: "failed", error: expect.any(String) }),
    );
  });

  it("never throws for individual job failures — only deps.listFiles throwing propagates", async () => {
    const runJob = vi.fn(async () => ({ outputPath: "out.mp4" }));
    const deps = threeJobDeps(runJob, vi.fn());

    await expect(runBatch({ dir: "jobs", concurrency: 1, render: false }, deps)).resolves.toBeDefined();

    const throwingDeps: BatchDeps = {
      listFiles: () => {
        throw new Error("bad directory");
      },
      readFile: () => "",
      writeManifest: vi.fn(),
      runJob: vi.fn(),
    };

    await expect(runBatch({ dir: "missing", concurrency: 1, render: false }, throwingDeps)).rejects.toThrow(
      "bad directory",
    );
  });

  it("runs up to `concurrency` jobs at once, never exceeding it, and does run more than 1 at a time", async () => {
    const files = ["a.json", "b.json", "c.json", "d.json"];
    let inFlight = 0;
    let maxInFlight = 0;

    const runJob: BatchDeps["runJob"] = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return {};
    };

    const deps: BatchDeps = {
      listFiles: () => files,
      readFile: (file) => JSON.stringify({ prompt: `prompt for ${file}` }),
      writeManifest: vi.fn(),
      runJob,
    };

    const results = await runBatch({ dir: "jobs", concurrency: 2, render: false }, deps);

    expect(results).toHaveLength(4);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
