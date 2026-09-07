// `claudevid render` tests (spec.md FR4/Edge Cases). No filesystem access, no real render
// pipeline — `readFile`, `exists`, and `runRenderPipeline` are all injected fakes, following
// tools/motion-preview's dependency-injection test style (see test/validate.test.ts).

import { describe, expect, it, vi } from "vitest";

import { ArgError } from "../src/args.js";
import { parseRenderArgs, runRender, type RenderDeps } from "../src/commands/render.js";

const VALID_SPEC = JSON.stringify({
  version: 1,
  width: 1920,
  height: 1080,
  fps: 30,
  scenes: [
    {
      id: "intro",
      duration: 3,
      layers: [{ type: "text", text: "Hello", x: "center", y: "center" }],
    },
  ],
});

// Missing the required top-level "version" field.
const INVALID_SPEC = JSON.stringify({
  width: 1920,
  height: 1080,
  fps: 30,
  scenes: [{ id: "intro", duration: 3, layers: [] }],
});

describe("parseRenderArgs (FR4)", () => {
  it("throws ArgError when the spec path is missing", () => {
    expect(() => parseRenderArgs([])).toThrow(ArgError);
  });

  it("throws ArgError when --out is missing", () => {
    expect(() => parseRenderArgs(["spec.json"])).toThrow(ArgError);
  });

  it("parses a valid argv with defaults for boolean flags", () => {
    const args = parseRenderArgs(["spec.json", "--out", "out.mp4"]);

    expect(args).toEqual({
      specPath: "spec.json",
      outPath: "out.mp4",
      force: false,
      captions: false,
      cpuEncode: false,
    });
  });

  it("parses --force, --captions, and --cpu-encode", () => {
    const args = parseRenderArgs(["spec.json", "--out", "out.mp4", "--force", "--captions", "--cpu-encode"]);

    expect(args.force).toBe(true);
    expect(args.captions).toBe(true);
    expect(args.cpuEncode).toBe(true);
  });
});

describe("runRender (FR4/Edge Cases)", () => {
  it("refuses to overwrite an existing outPath without --force, and never calls the pipeline", async () => {
    const runRenderPipeline = vi.fn();
    const deps: RenderDeps = {
      readFile: () => VALID_SPEC,
      exists: () => true,
      runRenderPipeline,
    };

    const result = await runRender(
      { specPath: "spec.json", outPath: "out.mp4", force: false, captions: false, cpuEncode: false },
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("refusing to overwrite");
    expect(result.message).toContain("out.mp4");
    expect(runRenderPipeline).not.toHaveBeenCalled();
  });

  it("proceeds past the no-clobber guard when --force is set", async () => {
    const runRenderPipeline = vi.fn().mockResolvedValue(undefined);
    const deps: RenderDeps = {
      readFile: () => VALID_SPEC,
      exists: () => true,
      runRenderPipeline,
    };

    const result = await runRender(
      { specPath: "spec.json", outPath: "out.mp4", force: true, captions: false, cpuEncode: false },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(runRenderPipeline).toHaveBeenCalledTimes(1);
  });

  it("runs the pipeline and reports success for a valid spec with no existing output", async () => {
    const runRenderPipeline = vi.fn().mockResolvedValue(undefined);
    const deps: RenderDeps = {
      readFile: () => VALID_SPEC,
      exists: () => false,
      runRenderPipeline,
    };

    const result = await runRender(
      { specPath: "spec.json", outPath: "out.mp4", force: false, captions: true, cpuEncode: false },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("out.mp4");
    expect(runRenderPipeline).toHaveBeenCalledTimes(1);
    expect(runRenderPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1 }),
      expect.objectContaining({
        profileName: "final",
        outputPath: "out.mp4",
        captions: true,
        cpuEncode: false,
        force: false,
      }),
    );
  });

  it("reports failure with diagnostics for an invalid spec, and never calls the pipeline", async () => {
    const runRenderPipeline = vi.fn();
    const deps: RenderDeps = {
      readFile: () => INVALID_SPEC,
      exists: () => false,
      runRenderPipeline,
    };

    const result = await runRender(
      { specPath: "spec.json", outPath: "out.mp4", force: false, captions: false, cpuEncode: false },
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("/version");
    expect(runRenderPipeline).not.toHaveBeenCalled();
  });

  it("reports failure for malformed JSON, without throwing", async () => {
    const runRenderPipeline = vi.fn();
    const deps: RenderDeps = {
      readFile: () => "{ this is not json",
      exists: () => false,
      runRenderPipeline,
    };

    const result = await runRender(
      { specPath: "spec.json", outPath: "out.mp4", force: false, captions: false, cpuEncode: false },
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("invalid JSON");
    expect(runRenderPipeline).not.toHaveBeenCalled();
  });
});
