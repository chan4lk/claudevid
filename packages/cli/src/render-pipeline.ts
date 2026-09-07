// Shared render pipeline (spec.md FR9, design.md D1/D2) — the one function every render-producing
// command (`preview`, `render`, `generate --render`, `batch`) drives. Takes an already-`parseSpec`'d
// `VideoSpec` (D2: no file I/O here, that's each caller's own job) and produces a muxed (or, if the
// spec has no narration anywhere, silent) output file.
//
// Every external effect (TTS synthesis, forced alignment, FFmpeg capability probing, the encode
// pipe, the canvas renderer, the audio-graph mux) is reached through an injectable seam
// (`RenderPipelineOptions`'s `*Fn` fields) defaulting to the real implementation, so this whole
// module is testable without a real ONNX model or FFmpeg binary (spec.md NFR3).
import * as path from "node:path";
import * as fs from "node:fs/promises";

import type { VideoSpec, Layer, SceneWindow, Timeline, Diagnostic } from "@claudevid/core";
import { compileTimeline } from "@claudevid/core";
import {
  synthesize,
  align,
  buildAudioGraphArgv,
  muxOutput,
  PINNED_MODEL,
  type SynthesisRequest,
  type WordTiming,
  type AudioTrack,
} from "@claudevid/audio";
import { probe, createEncodePipe, createTempRun } from "@claudevid/encoder-ffmpeg";
import { createRenderer, createFrameBuffer, registerPainter } from "@claudevid/renderer-canvas";
import { compileMotion, createResolver } from "@claudevid/motion";
import {
  compileCodeLayers,
  layoutCode,
  checkLayoutDiagnostics,
  renderCodeFrame,
  createLineCache,
  createChromeCache,
  isCodeLayer,
  type CodeLayer,
  type CompiledCodeLayer,
} from "@claudevid/layer-code";

type Scene = VideoSpec["scenes"][number];
type NarrationBlock = NonNullable<Scene["narration"]>[number];

export interface RenderPipelineOptions {
  profileName: "preview" | "final";
  outputPath: string;
  captions?: boolean;
  cpuEncode?: boolean;
  force?: boolean;
  scale?: number;
  // Injectable seams (NFR3) — all default to the real implementations when omitted.
  synthesizeFn?: typeof synthesize;
  alignFn?: typeof align;
  probeFn?: typeof probe;
  createEncodePipeFn?: typeof createEncodePipe;
  createRendererFn?: typeof createRenderer;
  muxOutputFn?: typeof muxOutput;
  buildAudioGraphArgvFn?: typeof buildAudioGraphArgv;
}

/** One synthesized narration block, plus its running start offset (seconds, block-relative to
 * its own scene) among the other blocks of the same scene. */
interface SynthesizedBlock {
  text: string;
  audio: Buffer;
  sampleRate: number;
  durationSeconds: number;
  offsetSeconds: number;
}

/**
 * Step A — synthesizes every narration block up front, regardless of a scene's duration mode
 * (spec.md FR9). Every "auto"-duration scene needs its blocks' measured durations to compute a
 * timeline (Step B/C) and every narrated scene needs the raw audio again for the voice-track WAV
 * (Step D) and, if `opts.captions`, forced alignment (Step E) — so synthesis always happens
 * first, unconditionally.
 *
 * Design choice (documented per this task's brief): this calls `synthesizeFn` directly, NOT
 * `getOrSynthesize`. `getOrSynthesize`'s on-disk cache entry (`cache.ts`'s `CacheEntryFile`)
 * stores only `{ durationSeconds, audioBase64 }` — it discards `sampleRate` entirely. Step D
 * needs `{ audio, sampleRate }` together (one real sample rate for the whole assembled voice
 * track), so a cache hit would still require a second real synthesis call just to recover
 * `sampleRate`, at which point the cache adds no value at this call site. Calling `synthesizeFn`
 * directly is simpler and avoids that redundant round-trip; it does mean this pipeline does not
 * benefit from `cache.ts`'s content-addressed cache the way `computeAudioDurations` does.
 */
async function synthesizeNarration(
  spec: VideoSpec,
  synthesizeFn: typeof synthesize,
): Promise<Map<string, SynthesizedBlock[]>> {
  const bySceneId = new Map<string, SynthesizedBlock[]>();

  for (const scene of spec.scenes) {
    if (!scene.narration || scene.narration.length === 0) continue;

    const blocks: SynthesizedBlock[] = [];
    let cumulativeSeconds = 0;
    for (const block of scene.narration as NarrationBlock[]) {
      const request: SynthesisRequest = {
        text: block.text,
        voice: block.voice ?? "af_heart",
        speed: block.speed ?? 1,
        modelId: PINNED_MODEL.id,
        modelDigest: PINNED_MODEL.digest,
        lexiconDigest: "", // lexicon application is out of scope for this pipeline (spec.md FR9)
      };
      const { audio, sampleRate } = await synthesizeFn(request);
      const durationSeconds = audio.length / 2 / sampleRate;
      blocks.push({ text: block.text, audio, sampleRate, durationSeconds, offsetSeconds: cumulativeSeconds });
      cumulativeSeconds += durationSeconds;
    }
    bySceneId.set(scene.id, blocks);
  }

  return bySceneId;
}

/** Step B — sums each `"auto"`-duration scene's synthesized blocks into the `audioDurations`
 * record `compileTimeline` consults (spec.md FR9). Scenes with a fixed numeric duration are
 * omitted, matching `compileTimeline`'s own contract (only `"auto"` scenes consult this record). */
function computeAudioDurationsRecord(
  spec: VideoSpec,
  narrationBySceneId: Map<string, SynthesizedBlock[]>,
): Record<string, number> {
  const record: Record<string, number> = {};
  for (const scene of spec.scenes) {
    if (scene.duration !== "auto") continue;
    const blocks = narrationBySceneId.get(scene.id) ?? [];
    record[scene.id] = blocks.reduce((sum, block) => sum + block.durationSeconds, 0);
  }
  return record;
}

function findSceneWindow(timeline: Timeline, sceneId: string): SceneWindow {
  const window = timeline.sceneWindows.find((w) => w.sceneId === sceneId);
  if (!window) throw new Error(`No SceneWindow found for scene "${sceneId}" in the compiled Timeline`);
  return window;
}

/** Step E — inserts a `captions` layer (spec.md's forced Decision, design.md D1: the only place
 * in this codebase that constructs one) into a shallow working copy of each narrated scene, using
 * `alignFn` against each block's already-synthesized audio. Converts block-relative
 * `WordTiming[]` to timeline-absolute seconds (`SceneWindow.startFrame / fps` + the block's own
 * cumulative offset within its scene). Never mutates the caller's original `spec` — only the
 * touched scenes get new `layers` arrays; untouched scenes are shared by reference. */
async function insertCaptionsLayers(
  spec: VideoSpec,
  timeline: Timeline,
  narrationBySceneId: Map<string, SynthesizedBlock[]>,
  alignFn: typeof align,
): Promise<VideoSpec> {
  const scenes = await Promise.all(
    spec.scenes.map(async (scene) => {
      const blocks = narrationBySceneId.get(scene.id);
      if (!blocks || blocks.length === 0) return scene;

      const sceneWindow = findSceneWindow(timeline, scene.id);
      const sceneStartSeconds = sceneWindow.startFrame / spec.fps;

      const words: WordTiming[] = [];
      for (const block of blocks) {
        const result = await alignFn({ audio: block.audio, sampleRate: block.sampleRate, referenceText: block.text });
        const offsetSeconds = sceneStartSeconds + block.offsetSeconds;
        for (const timing of result.timings) {
          words.push({ ...timing, start: timing.start + offsetSeconds, end: timing.end + offsetSeconds });
        }
      }

      const captionsLayer = { type: "captions", words } as unknown as Layer;
      return { ...scene, layers: [...scene.layers, captionsLayer] };
    }),
  );

  return { ...spec, scenes };
}

/** Builds a minimal 44-byte canonical PCM WAV header (mono, 16-bit) for `pcm`. */
function buildWavFile(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Step D — assembles one continuous, silence-padded voice-track WAV spanning the whole timeline
 * (`timeline.frameCount / spec.fps` seconds), writes it into `tempDir`, and returns its path.
 * `buildAudioGraphArgv`'s `AudioTrack` has no per-track start-offset field — a track is assumed
 * to occupy the full output duration from t=0 — which is exactly why this single continuous file
 * has to exist before the mux step (Step G) instead of one file per narration block. */
async function assembleVoiceTrack(
  spec: VideoSpec,
  timeline: Timeline,
  narrationBySceneId: Map<string, SynthesizedBlock[]>,
  tempDir: string,
): Promise<string> {
  // Pick ONE sample rate for the whole track: the first synthesized block's sampleRate,
  // encountered in spec/scene/block order. Any other block reporting a different sample rate
  // fails closed (resampling is out of scope) rather than silently mixing rates.
  let sampleRate: number | undefined;
  for (const scene of spec.scenes) {
    const blocks = narrationBySceneId.get(scene.id);
    if (!blocks) continue;
    blocks.forEach((block, index) => {
      if (sampleRate === undefined) {
        sampleRate = block.sampleRate;
        return;
      }
      if (block.sampleRate !== sampleRate) {
        throw new Error(
          `Scene "${scene.id}" narration block ${index} has sampleRate ${block.sampleRate}, but the ` +
            `voice track's sample rate was already established as ${sampleRate} by an earlier block. ` +
            "Resampling is out of scope — every narration block must synthesize at the same sample rate.",
        );
      }
    });
  }
  if (sampleRate === undefined) {
    throw new Error("assembleVoiceTrack called with no narrated scenes");
  }

  const totalSeconds = timeline.frameCount / spec.fps;
  const totalBytes = Math.round(totalSeconds * sampleRate) * 2; // 16-bit mono: 2 bytes/sample
  const pcm = Buffer.alloc(totalBytes); // zero-filled = silence everywhere by default

  for (const sceneWindow of timeline.sceneWindows) {
    const blocks = narrationBySceneId.get(sceneWindow.sceneId);
    if (!blocks || blocks.length === 0) continue;

    const sceneStartSeconds = sceneWindow.startFrame / spec.fps;
    const sceneEndSeconds = sceneWindow.endFrame / spec.fps;
    // Defensive same-scene-only clamp: a block never bleeds into the next scene's window, even
    // if its measured duration runs slightly past its own scene's end.
    const sceneEndByte = Math.min(pcm.length, Math.round(sceneEndSeconds * sampleRate) * 2);

    for (const block of blocks) {
      const offsetSeconds = sceneStartSeconds + block.offsetSeconds;
      const offsetBytes = Math.max(0, Math.round(offsetSeconds * sampleRate) * 2);
      const copyLength = Math.min(block.audio.length, sceneEndByte - offsetBytes, pcm.length - offsetBytes);
      if (copyLength <= 0) continue;
      block.audio.copy(pcm, offsetBytes, 0, copyLength);
    }
  }

  const wavPath = path.join(tempDir, "voice-track.wav");
  await fs.writeFile(wavPath, buildWavFile(pcm, sampleRate));
  return wavPath;
}

/** Steps B2/F0 — compiles every `code` layer in `timeline` and re-registers the `"code"` painter
 * so it draws from those compiled entries.
 *
 * `@claudevid/layer-code` registers `paintCodeLayer` at import time, and that function reads its
 * `entry` argument as an already-assembled `CompiledCodeLayer`. `renderer-canvas`'s painter
 * dispatch, though, hands a painter the raw `timelineLayer.layer` as `entry` — it has no channel
 * for a compiled entry at all (painters.ts: "the registered closure captures whatever internal
 * lookup it needs itself"). This function is that closure: the integrating pipeline owns the
 * `layerKey -> CompiledCodeLayer` map, and the line/chrome caches live for the whole render.
 *
 * `compileCodeLayers` already runs `layoutCode`/`checkLayoutDiagnostics` internally for its
 * diagnostics but returns only the token IR, so the per-layer layout is recomputed here with the
 * same inputs (both calls are pure) to assemble `{ ir, layout, blocked }`.
 */
async function prepareCodeLayers(spec: VideoSpec, timeline: Timeline): Promise<Diagnostic[]> {
  const { compiled: irByLayerKey, diagnostics } = await compileCodeLayers(spec, timeline);

  const compiledByLayerKey = new Map<string, CompiledCodeLayer>();
  for (const tl of timeline.layers) {
    if (!isCodeLayer(tl.layer)) continue;
    const ir = irByLayerKey.get(tl.layerKey);
    if (!ir) continue; // unsupported lang/theme — already diagnosed, layer paints nothing
    const layer = tl.layer as unknown as CodeLayer;
    const layout = layoutCode(layer.code.split("\n"), {
      width: layer.width,
      height: layer.height,
      fontSize: layer.fontSize,
      tabSize: layer.tabSize,
      wrap: layer.wrap,
      showLineNumbers: layer.showLineNumbers,
    });
    const { blocked } = checkLayoutDiagnostics(tl.layerKey, layout, {
      maxLines: layer.maxLines,
      hasScroll: Boolean(layer.scroll),
      focus: layer.focus,
      scroll: layer.scroll,
      annotations: layer.annotations,
    });
    compiledByLayerKey.set(tl.layerKey, { ir, layout, blocked });
  }

  const lineCache = createLineCache();
  const chromeCache = createChromeCache();
  registerPainter("code", (_entry, timelineLayer, frame, ctx) => {
    const compiled = compiledByLayerKey.get(timelineLayer.layerKey);
    if (!compiled) return;
    renderCodeFrame(
      compiled,
      timelineLayer.layer as unknown as CodeLayer,
      lineCache,
      chromeCache,
      ctx,
      frame - timelineLayer.startFrame,
    );
  });

  return diagnostics;
}

/** Compile-time diagnostics from motion/code compilation are advisory here (change 003's
 * `compileMotion` contract: "diagnosed, not silently ignored") — printed once, never fatal. The
 * fail-closed half is `renderCodeFrame`'s own `CodeOverflowError` for a `blocked` entry. */
function reportDiagnostics(label: string, diagnostics: Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const suggestion = diagnostic.suggestion ? ` — ${diagnostic.suggestion}` : "";
    console.warn(`${label} ${diagnostic.path}: ${diagnostic.message}${suggestion}`);
  }
}

/** Shared render pipeline (spec.md FR9, design.md D1/D2): synthesizes narration, compiles the
 * timeline, optionally inserts forced-aligned captions layers, renders every frame through the
 * encoder, and (if any scene has narration) muxes the assembled voice track against the silent
 * video into `opts.outputPath`. Always disposes the renderer and cleans up the temp run,
 * including on error (mirrors `tools/bench/src/bench.ts`'s try/finally shape). */
export async function runRenderPipeline(spec: VideoSpec, opts: RenderPipelineOptions): Promise<void> {
  const synthesizeFn = opts.synthesizeFn ?? synthesize;
  const alignFn = opts.alignFn ?? align;
  const probeFn = opts.probeFn ?? probe;
  const createEncodePipeFn = opts.createEncodePipeFn ?? createEncodePipe;
  const createRendererFn = opts.createRendererFn ?? createRenderer;
  const muxOutputFn = opts.muxOutputFn ?? muxOutput;
  const buildAudioGraphArgvFn = opts.buildAudioGraphArgvFn ?? buildAudioGraphArgv;

  // Step A
  const narrationBySceneId = await synthesizeNarration(spec, synthesizeFn);
  const hasNarration = narrationBySceneId.size > 0;

  // Step B + C
  const audioDurations = computeAudioDurationsRecord(spec, narrationBySceneId);
  let renderSpec = spec;
  let timeline = compileTimeline(spec, { audioDurations });

  // Step E (only if captions requested and something is actually narrated)
  if (opts.captions && hasNarration) {
    renderSpec = await insertCaptionsLayers(spec, timeline, narrationBySceneId, alignFn);
    timeline = compileTimeline(renderSpec, { audioDurations });
  }

  // Step B2 — motion (change 003) and `code`-layer (change 004) compilation. Both are keyed on
  // `timeline.layers`' `layerKey`s, so both run after the timeline above is final.
  const { compiled: motionTracks, diagnostics: motionDiagnostics } = compileMotion(renderSpec, timeline);
  reportDiagnostics("motion:", motionDiagnostics);
  const motion = createResolver(motionTracks, timeline);
  reportDiagnostics("code:", await prepareCodeLayers(renderSpec, timeline));

  // Step F setup (mirrors tools/bench/src/bench.ts's renderer/tempRun lifecycle)
  const capabilities = await probeFn();
  const renderer = createRendererFn(spec.width, spec.height);
  const frameBuffer = createFrameBuffer(spec.width, spec.height);
  const tempRun = createTempRun();

  try {
    // Step D (needs tempRun.dir, so it happens inside this try so a failure still cleans up)
    const voiceTrackPath = hasNarration ? await assembleVoiceTrack(spec, timeline, narrationBySceneId, tempRun.dir) : undefined;

    const silentVideoPath = hasNarration ? path.join(tempRun.dir, "silent-video.mp4") : opts.outputPath;

    const pipe = createEncodePipeFn({
      profileName: opts.profileName,
      geometry: { width: spec.width, height: spec.height, fps: spec.fps },
      outputPath: silentVideoPath,
      capabilities,
      cpuEncode: opts.cpuEncode,
      tempRun,
    });

    for (let frame = 0; frame < timeline.frameCount; frame++) {
      await renderer.renderFrame(
        timeline,
        frame,
        frameBuffer,
        opts.scale !== undefined ? { scale: opts.scale, motion } : { motion },
      );
      await pipe.write(frameBuffer.data);
    }
    await pipe.finish();

    // Step G — mux (only if narration exists anywhere; otherwise the silent video written above
    // *is* opts.outputPath already, nothing further to do).
    if (hasNarration && voiceTrackPath) {
      const track: AudioTrack = { filePath: voiceTrackPath, role: "voice" };
      const argv = buildAudioGraphArgvFn({ tracks: [track], outputDurationSeconds: timeline.frameCount / spec.fps });
      await muxOutputFn({ silentVideoPath, audioGraphArgv: argv, outputPath: opts.outputPath, force: opts.force });
    }
  } finally {
    renderer.dispose();
    await tempRun.cleanup();
  }
}
