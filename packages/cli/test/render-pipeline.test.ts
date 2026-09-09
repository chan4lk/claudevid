// `runRenderPipeline` tests (spec.md FR9/AC3/AC4, design.md D1/D2). Every external effect
// (synthesis, alignment, ffmpeg probing/encoding/muxing, canvas rendering) is injected — no real
// ffmpeg binary, no real ONNX model, no real canvas rendering (spec.md NFR3).

import { describe, expect, it } from "vitest";
import type { EncoderCapabilities } from "@claudevid/encoder-ffmpeg";
import type { AudioGraphOptions, AlignRequest, AlignResult, SynthesisRequest } from "@claudevid/audio";
import { parseSpec } from "@claudevid/core";
import type { VideoSpec, Timeline } from "@claudevid/core";

// Side-effect import: registers the "captions" layer type (spec.md's forced Decision, design.md
// D1) — exercised here because AC4 asserts the pipeline actually constructs one.
import "@claudevid/layer-captions";

import { runRenderPipeline, type RenderPipelineOptions } from "../src/render-pipeline.js";

const FPS = 30;
const SAMPLE_RATE = 24000;
const BLOCK_DURATION_SECONDS = 1; // exact at 30fps: 30 frames, no rounding error

/** Deterministic fake `synthesize`: every block gets `BLOCK_DURATION_SECONDS` of all-zero PCM at
 * `SAMPLE_RATE`. */
async function fakeSynthesize(_request: SynthesisRequest): Promise<{ audio: Buffer; sampleRate: number }> {
  const sampleCount = Math.round(BLOCK_DURATION_SECONDS * SAMPLE_RATE);
  return { audio: Buffer.alloc(sampleCount * 2), sampleRate: SAMPLE_RATE };
}

/** Fake `align`: one word spanning the whole block, block-relative (spec.md FR9's contract —
 * `runRenderPipeline` is the one that converts this to timeline-absolute seconds). */
async function fakeAlign(request: AlignRequest): Promise<AlignResult> {
  return {
    timings: [{ word: request.referenceText, start: 0, end: BLOCK_DURATION_SECONDS, estimated: false }],
    estimatedSpans: [],
  };
}

const fakeCapabilities: EncoderCapabilities = {
  ffmpegPresent: true,
  h264_videotoolbox: false,
  libx264: true,
};

const SECONDS_PER_CHAR = 0.01;

/** Deterministic fake `synthesize` for the 011-tts-narration-length-guard AC4 regression test
 * below: no real model, audio whose computed duration is proportional to `request.text.length` —
 * so the sum across a chunked scene's sub-blocks can be checked against the full original text. */
async function fakeSynthesizeProportional(request: SynthesisRequest): Promise<{ audio: Buffer; sampleRate: number }> {
  const durationSeconds = request.text.length * SECONDS_PER_CHAR;
  const sampleCount = Math.round(durationSeconds * SAMPLE_RATE);
  return { audio: Buffer.alloc(sampleCount * 2), sampleRate: SAMPLE_RATE };
}

interface RenderFrameCall {
  timeline: Timeline;
  frame: number;
}

function buildSpec(): VideoSpec {
  return {
    version: 1,
    width: 100,
    height: 100,
    fps: FPS,
    scenes: [
      {
        id: "scene-a",
        duration: "auto",
        layers: [],
        narration: [{ text: "Hello from scene a" }],
      },
      {
        id: "scene-b",
        duration: "auto",
        layers: [],
        narration: [{ text: "Hello from scene b" }],
      },
    ],
  };
}

/** Builds a fresh set of fakes + capture buckets for one `runRenderPipeline` call. `synthesizeFn`
 * defaults to `fakeSynthesize`; callers that need a different synthesis fake (e.g. the AC4
 * proportional-duration regression test below) pass their own. */
function buildFakes(synthesizeFn: typeof fakeSynthesize = fakeSynthesize) {
  const renderFrameCalls: RenderFrameCall[] = [];
  const encodePipeCalls: { outputPath: string; profileName: string }[] = [];
  const graphCalls: AudioGraphOptions[] = [];
  const muxCalls: { silentVideoPath: string; outputPath: string; force?: boolean }[] = [];

  const opts: RenderPipelineOptions = {
    profileName: "preview",
    outputPath: "/tmp/does-not-matter/out.mp4",
    synthesizeFn,
    alignFn: fakeAlign,
    probeFn: async () => fakeCapabilities,
    createRendererFn: () => ({
      renderFrame: async (timeline: Timeline, frame: number) => {
        renderFrameCalls.push({ timeline, frame });
      },
      stats: () => ({
        msPerFrame: [],
        p50: 0,
        p95: 0,
        cacheHits: 0,
        cacheMisses: 0,
        holdFrames: 0,
        perLayerTypeMs: {},
      }),
      dispose: () => {},
    }),
    createEncodePipeFn: (encodeOpts) => {
      encodePipeCalls.push({ outputPath: encodeOpts.outputPath, profileName: encodeOpts.profileName });
      return {
        write: async () => {},
        finish: async () => {},
        cancel: async () => {},
        onProgress: () => {},
      };
    },
    buildAudioGraphArgvFn: (graphOpts) => {
      graphCalls.push(graphOpts);
      return ["-dummy-argv"];
    },
    muxOutputFn: async (muxOpts) => {
      muxCalls.push({ silentVideoPath: muxOpts.silentVideoPath, outputPath: muxOpts.outputPath, force: muxOpts.force });
    },
  };

  return { opts, renderFrameCalls, encodePipeCalls, graphCalls, muxCalls };
}

describe("runRenderPipeline (FR9)", () => {
  it("AC3: two auto-duration narrated scenes, no captions — mux gets the summed narration duration", async () => {
    const spec = buildSpec();
    const { opts, graphCalls, muxCalls, encodePipeCalls } = buildFakes();

    await runRenderPipeline(spec, opts);

    expect(encodePipeCalls).toHaveLength(1);
    expect(encodePipeCalls[0]!.profileName).toBe("preview");

    expect(graphCalls).toHaveLength(1);
    // Both scenes are "auto" duration and narrated with exactly BLOCK_DURATION_SECONDS of audio,
    // so the compiled timeline's total duration is exactly the sum of the two blocks' durations.
    expect(graphCalls[0]!.outputDurationSeconds).toBeCloseTo(BLOCK_DURATION_SECONDS * 2, 5);
    expect(graphCalls[0]!.tracks).toHaveLength(1);
    expect(graphCalls[0]!.tracks[0]!.role).toBe("voice");

    expect(muxCalls).toHaveLength(1);
    expect(muxCalls[0]!.outputPath).toBe(opts.outputPath);
    // The silent video (Step F's encode target) is distinct from the muxed final output.
    expect(muxCalls[0]!.silentVideoPath).not.toBe(opts.outputPath);
  });

  it("AC4: opts.captions inserts exactly one timeline-absolute captions layer per narrated scene", async () => {
    const spec = buildSpec();
    const { opts, renderFrameCalls } = buildFakes();
    opts.captions = true;

    await runRenderPipeline(spec, opts);

    expect(renderFrameCalls.length).toBeGreaterThan(0);
    const timeline = renderFrameCalls[0]!.timeline;

    const captionsLayers = timeline.layers.filter((l) => l.type === "captions");
    expect(captionsLayers).toHaveLength(2);

    const sceneAWindow = timeline.sceneWindows.find((w) => w.sceneId === "scene-a")!;
    const sceneACaptions = captionsLayers.find((l) => l.sceneId === "scene-a")!;
    const words = (sceneACaptions.layer as unknown as { words: { start: number; end: number }[] }).words;

    expect(words).toHaveLength(1);
    // Timeline-absolute, not block-relative: sceneWindow.startFrame / fps + the block's own
    // (zero, single-block) offset within the scene.
    expect(words[0]!.start).toBeCloseTo(sceneAWindow.startFrame / FPS, 5);
  });

  it("no-op for --captions when no scene has narration", async () => {
    const spec: VideoSpec = {
      version: 1,
      width: 100,
      height: 100,
      fps: FPS,
      scenes: [{ id: "silent-scene", duration: 2, layers: [] }],
    };
    const { opts, muxCalls, renderFrameCalls } = buildFakes();
    opts.captions = true;

    await runRenderPipeline(spec, opts);

    expect(muxCalls).toHaveLength(0);
    const timeline = renderFrameCalls[0]!.timeline;
    expect(timeline.layers.some((l) => l.type === "captions")).toBe(false);
  });

  it("011-tts-narration-length-guard AC4: auto duration reflects the full chunked narration text, not just the first sub-block", async () => {
    // One sentence, repeated 8x (15 words each = 120 words total), joined with a single space so
    // concatenating the resulting chunks reproduces this text exactly (chunkNarrationText's own
    // contract). At the default 90-word threshold this splits into two sub-blocks: sentences 1-6
    // (90 words) and sentences 7-8 (30 words) — see narration-chunking.ts's greedy grouping.
    const sentence = "This is a sentence about compliance testing that contains exactly fifteen words in it now.";
    const longNarrationText = Array(8).fill(sentence).join(" ");

    const parsed = parseSpec({
      version: 1,
      width: 100,
      height: 100,
      fps: FPS,
      scenes: [
        {
          id: "scene-long",
          duration: "auto",
          layers: [],
          narration: longNarrationText, // single authored block (a bare string)
        },
      ],
    });
    if (!parsed.ok) throw new Error(`parseSpec failed: ${JSON.stringify(parsed.diagnostics)}`);
    const spec = parsed.spec;

    const blocks = spec.scenes[0]!.narration!;
    // Sanity check on this test's own premise: schema parsing actually split the single authored
    // block into multiple sub-blocks (already wired into schema.ts's narrationSchema transform).
    expect(blocks.length).toBeGreaterThan(1);

    const { opts, graphCalls } = buildFakes(fakeSynthesizeProportional);

    await runRenderPipeline(spec, opts);

    const expectedDurationSeconds = blocks.reduce((sum, block) => sum + block.text.length * SECONDS_PER_CHAR, 0);
    const firstBlockOnlyDurationSeconds = blocks[0]!.text.length * SECONDS_PER_CHAR;

    expect(graphCalls).toHaveLength(1);
    // `compileTimeline` rounds an "auto" scene's seconds to whole frames (Math.round(seconds *
    // fps)), so allow up to half a frame of rounding error rather than asserting exact equality.
    expect(Math.abs(graphCalls[0]!.outputDurationSeconds - expectedDurationSeconds)).toBeLessThan(1 / FPS);
    // The regression this guards against: computing duration from only the first sub-block (or
    // any truncated prefix) instead of summing every sub-block chunkNarrationText produced.
    expect(Math.abs(graphCalls[0]!.outputDurationSeconds - firstBlockOnlyDurationSeconds)).toBeGreaterThan(1 / FPS);
  });
});
