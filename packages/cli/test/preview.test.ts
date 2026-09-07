// `claudevid preview` tests (spec.md FR3). `parsePreviewArgs` is pure. `runPreviewOnce` and
// `renderContactSheet` are exercised with fully injected fakes (no real renderer/encoder,
// following render.test.ts's dependency-injection style) — no real FFmpeg or ONNX model
// involved (NFR3).

import { describe, expect, it, vi } from "vitest";

import { ArgError } from "../src/args.js";
import {
  parsePreviewArgs,
  runPreviewOnce,
  renderContactSheet,
  DEFAULT_SHEET_FRAMES,
  MAX_SHEET_FRAMES,
} from "../src/commands/preview.js";
import type { VideoSpec } from "@claudevid/core";

function makeSpec(overrides: Partial<VideoSpec> = {}): VideoSpec {
  return {
    version: 1,
    width: 1920,
    height: 1080,
    fps: 30,
    scenes: [
      {
        id: "intro",
        duration: 1,
        layers: [{ type: "text", text: "Hello", x: "center", y: "center" }],
      },
    ],
    ...overrides,
  } as VideoSpec;
}

describe("parsePreviewArgs (FR3)", () => {
  it("throws ArgError when the spec path is missing", () => {
    expect(() => parsePreviewArgs([])).toThrow(ArgError);
  });

  it("parses a valid argv with defaults", () => {
    const args = parsePreviewArgs(["spec.json"]);

    expect(args).toEqual({
      specPath: "spec.json",
      watch: false,
      sheetPath: undefined,
      sheetFrames: DEFAULT_SHEET_FRAMES,
    });
  });

  it("parses --watch", () => {
    const args = parsePreviewArgs(["spec.json", "--watch"]);
    expect(args.watch).toBe(true);
  });

  it("parses --sheet and --frames", () => {
    const args = parsePreviewArgs(["spec.json", "--sheet", "sheet.png", "--frames", "12"]);

    expect(args.sheetPath).toBe("sheet.png");
    expect(args.sheetFrames).toBe(12);
  });

  it("throws ArgError when --frames exceeds the cap", () => {
    expect(() => parsePreviewArgs(["spec.json", "--sheet", "sheet.png", "--frames", String(MAX_SHEET_FRAMES + 1)])).toThrow(
      ArgError,
    );
  });

  it("throws ArgError when --frames is not a positive integer", () => {
    expect(() => parsePreviewArgs(["spec.json", "--frames", "0"])).toThrow(ArgError);
    expect(() => parsePreviewArgs(["spec.json", "--frames", "not-a-number"])).toThrow(ArgError);
  });
});

describe("runPreviewOnce (FR3)", () => {
  it("passes a scaled-down scale for a spec wider than 1280", async () => {
    const runRenderPipeline = vi.fn().mockResolvedValue(undefined);
    const spec = makeSpec({ width: 1920, height: 1080 });

    const outcome = await runPreviewOnce(spec, { runRenderPipeline, outputPath: "out.mp4" });

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("out.mp4");
    expect(runRenderPipeline).toHaveBeenCalledWith(
      spec,
      expect.objectContaining({ profileName: "preview", outputPath: "out.mp4", scale: 1280 / 1920 }),
    );
  });

  it("passes scale: undefined for a spec no wider than 1280", async () => {
    const runRenderPipeline = vi.fn().mockResolvedValue(undefined);
    const spec = makeSpec({ width: 1280, height: 720 });

    await runPreviewOnce(spec, { runRenderPipeline, outputPath: "out.mp4" });

    expect(runRenderPipeline).toHaveBeenCalledWith(
      spec,
      expect.objectContaining({ profileName: "preview", outputPath: "out.mp4", scale: undefined }),
    );
  });

  it("returns ok: false with the error message when the pipeline rejects", async () => {
    const runRenderPipeline = vi.fn().mockRejectedValue(new Error("boom"));
    const spec = makeSpec();

    const outcome = await runPreviewOnce(spec, { runRenderPipeline, outputPath: "out.mp4" });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("boom");
  });
});

describe("renderContactSheet (FR3)", () => {
  it("renders frameCount frames and writes non-empty bytes to writeFileFn", async () => {
    const spec = makeSpec({ width: 4, height: 4, scenes: [{ id: "s1", duration: 2, layers: [] }] });
    const frameCount = 4;

    const fakeFrameBuffer = { width: 4, height: 4, data: Buffer.alloc(4 * 4 * 4) };
    const renderFrame = vi.fn().mockResolvedValue(undefined);
    const dispose = vi.fn();
    const createRendererFn = vi.fn().mockReturnValue({
      renderFrame,
      dispose,
      stats: vi.fn(),
    });
    const createFrameBufferFn = vi.fn().mockReturnValue(fakeFrameBuffer);
    const writeFileFn = vi.fn();

    await renderContactSheet(
      spec,
      { frameCount, sheetPath: "sheet.png" },
      { createRendererFn, createFrameBufferFn, writeFileFn },
    );

    expect(renderFrame).toHaveBeenCalledTimes(frameCount);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(writeFileFn).toHaveBeenCalledTimes(1);

    const call = writeFileFn.mock.calls[0];
    expect(call).toBeDefined();
    const [path, bytes] = call!;
    expect(path).toBe("sheet.png");
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(0);
    // PNG magic bytes.
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("disposes the renderer even if a renderFrame call throws", async () => {
    const spec = makeSpec({ width: 2, height: 2, scenes: [{ id: "s1", duration: 1, layers: [] }] });

    const dispose = vi.fn();
    const createRendererFn = vi.fn().mockReturnValue({
      renderFrame: vi.fn().mockRejectedValue(new Error("paint failed")),
      dispose,
      stats: vi.fn(),
    });
    const createFrameBufferFn = vi.fn().mockReturnValue({ width: 2, height: 2, data: Buffer.alloc(2 * 2 * 4) });

    await expect(
      renderContactSheet(
        spec,
        { frameCount: 2, sheetPath: "sheet.png" },
        { createRendererFn, createFrameBufferFn, writeFileFn: vi.fn() },
      ),
    ).rejects.toThrow("paint failed");

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
