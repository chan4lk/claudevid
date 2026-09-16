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
  decodeAudioFile,
  VOICE_TRACK_SAMPLE_RATE,
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
  /** With `captions`, render anyway when some scenes use `scene.audio` (spec.md FR17): those
   * scenes get no captions layer (there is no reference text to align against) and their ids are
   * reported back in the resolved value's `skippedCaptionSceneIds`. Without this, `captions` +
   * any `scene.audio` scene throws `CaptionsExternalAudioError`. */
  captionsAllowPartial?: boolean;
  cpuEncode?: boolean;
  force?: boolean;
  scale?: number;
  // Injectable seams (NFR3) — all default to the real implementations when omitted.
  synthesizeFn?: typeof synthesize;
  alignFn?: typeof align;
  decodeAudioFn?: typeof decodeAudioFile;
  probeFn?: typeof probe;
  createEncodePipeFn?: typeof createEncodePipe;
  createRendererFn?: typeof createRenderer;
  muxOutputFn?: typeof muxOutput;
  buildAudioGraphArgvFn?: typeof buildAudioGraphArgv;
}

/** Thrown by `runRenderPipeline` (spec.md FR17, design.md D6) when `opts.captions` is requested
 * and at least one scene drives its voice track from `scene.audio` instead of `narration` —
 * external audio carries no reference text to force-align, so it cannot be captioned. Thrown
 * before Step A (before `synthesizeFn`/`decodeAudioFn` run), unless
 * `opts.captionsAllowPartial` opts into rendering those scenes without captions. */
export class CaptionsExternalAudioError extends Error {
  readonly sceneIds: string[];

  constructor(sceneIds: string[]) {
    super(
      `--captions requires reference text to align against, but scene(s) ${sceneIds
        .map((id) => `"${id}"`)
        .join(", ")} use scene.audio (external audio, no reference text) instead of narration. ` +
        "Pass --captions-allow-partial to caption the narrated scenes and skip these.",
    );
    this.name = "CaptionsExternalAudioError";
    this.sceneIds = sceneIds;
  }
}

/** One block of collected voice-track audio, plus its running start offset (seconds, block-
 * relative to its own scene) among the other blocks of the same scene. `source` distinguishes a
 * synthesized narration block from a decoded `scene.audio` block (design.md D1's `SynthesizedBlock`
 * — the same shape for both, so everything downstream of Step A stays unchanged, spec.md FR13). */
interface SynthesizedBlock {
  text: string;
  audio: Buffer;
  sampleRate: number;
  durationSeconds: number;
  offsetSeconds: number;
  source: "narration" | "audio";
}

/**
 * Step A — collects every scene's voice-track audio up front, regardless of a scene's duration
 * mode (spec.md FR9, extended by FR13 for `scene.audio`). Every "auto"-duration scene needs its
 * blocks' measured durations to compute a timeline (Step B/C) and every voiced scene needs the
 * raw audio again for the voice-track WAV (Step D) and, if `opts.captions`, forced alignment
 * (Step E) — so collection always happens first, unconditionally.
 *
 * A scene's voice comes from exactly one of `narration` or `audio` (schema.ts's `narration` xor
 * `audio` refinement): narration is synthesized as before; `scene.audio` is decoded via
 * `decodeAudioFn` into the same `SynthesizedBlock` shape, tagged `source` so downstream steps
 * (captions, Step D) can tell them apart (design.md D1). Every block's `sampleRate` is checked
 * against `VOICE_TRACK_SAMPLE_RATE` as soon as it's known (spec.md FR13) — before any timeline is
 * compiled or frame rendered.
 *
 * Design choice (documented per this task's brief): narration calls `synthesizeFn` directly, NOT
 * `getOrSynthesize`. `getOrSynthesize`'s on-disk cache entry (`cache.ts`'s `CacheEntryFile`)
 * stores only `{ durationSeconds, audioBase64 }` — it discards `sampleRate` entirely. Step D
 * needs `{ audio, sampleRate }` together (one real sample rate for the whole assembled voice
 * track), so a cache hit would still require a second real synthesis call just to recover
 * `sampleRate`, at which point the cache adds no value at this call site. Calling `synthesizeFn`
 * directly is simpler and avoids that redundant round-trip; it does mean this pipeline does not
 * benefit from `cache.ts`'s content-addressed cache the way `computeAudioDurations` does. Decoded
 * `scene.audio` blocks are likewise never written to or read from that cache (spec.md FR16): it's
 * keyed on narration text and exists because synthesis is slow, but decoding a local file isn't.
 */
async function collectSceneAudio(
  spec: VideoSpec,
  synthesizeFn: typeof synthesize,
  decodeAudioFn: typeof decodeAudioFile,
): Promise<Map<string, SynthesizedBlock[]>> {
  const bySceneId = new Map<string, SynthesizedBlock[]>();

  for (const scene of spec.scenes) {
    if (scene.narration && scene.narration.length > 0) {
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
        checkVoiceTrackSampleRate(scene.id, sampleRate);
        const durationSeconds = audio.length / 2 / sampleRate;
        blocks.push({
          text: block.text,
          audio,
          sampleRate,
          durationSeconds,
          offsetSeconds: cumulativeSeconds,
          source: "narration",
        });
        cumulativeSeconds += durationSeconds;
      }
      bySceneId.set(scene.id, blocks);
    } else if (scene.audio) {
      const { audio, sampleRate, durationSeconds } = await decodeAudioFn(scene.audio.src);
      checkVoiceTrackSampleRate(scene.id, sampleRate);
      bySceneId.set(scene.id, [
        {
          text: "",
          audio,
          sampleRate,
          durationSeconds,
          offsetSeconds: scene.audio.padStart ?? 0,
          source: "audio",
        },
      ]);
    }
  }

  return bySceneId;
}

/** spec.md FR13: every collected block — synthesized or decoded — must agree with the voice
 * track's one true sample rate. Resampling is out of scope, so a mismatch fails closed here, in
 * Step A, before any timeline is compiled or frame rendered. */
function checkVoiceTrackSampleRate(sceneId: string, sampleRate: number): void {
  if (sampleRate !== VOICE_TRACK_SAMPLE_RATE) {
    throw new Error(
      `Scene "${sceneId}" produced audio at ${sampleRate}Hz, but the voice track requires ` +
        `${VOICE_TRACK_SAMPLE_RATE}Hz. Resampling is out of scope — every scene's audio must match.`,
    );
  }
}

/** Step B — sums each `"auto"`-duration scene's collected blocks into the `audioDurations` record
 * `compileTimeline` consults (spec.md FR9, extended by FR14). An `audio` scene's entry also
 * includes its `padStart`/`padEnd` silence — placement of the decoded block within that widened
 * window is `assembleVoiceTrack`'s job (unchanged); the pads just make the window itself longer.
 * Scenes with a fixed numeric duration are omitted, matching `compileTimeline`'s own contract
 * (only `"auto"` scenes consult this record). */
function computeAudioDurationsRecord(
  spec: VideoSpec,
  sceneAudioBySceneId: Map<string, SynthesizedBlock[]>,
): Record<string, number> {
  const record: Record<string, number> = {};
  for (const scene of spec.scenes) {
    if (scene.duration !== "auto") continue;
    const blocks = sceneAudioBySceneId.get(scene.id) ?? [];
    const decodedSeconds = blocks.reduce((sum, block) => sum + block.durationSeconds, 0);
    record[scene.id] = scene.audio
      ? (scene.audio.padStart ?? 0) + decodedSeconds + (scene.audio.padEnd ?? 0)
      : decodedSeconds;
  }
  return record;
}

/** Advisory diagnostics for `scene.audio` (spec.md FR15) — never fatal, reported the same way as
 * the motion/code diagnostics below. (a) A cross-fade transition into the scene after an `audio`
 * scene that runs longer than that scene's `padEnd` silence starts the next scene's voice before
 * this scene's own speech has finished. (b) An `audio` scene with a fixed numeric `duration`
 * shorter than `padStart + decoded + padEnd` will have its audio truncated at the scene end by
 * `assembleVoiceTrack`'s existing same-scene clamp. */
function computeAudioAdvisoryDiagnostics(
  spec: VideoSpec,
  sceneAudioBySceneId: Map<string, SynthesizedBlock[]>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  spec.scenes.forEach((scene, index) => {
    if (!scene.audio) return;

    const padStart = scene.audio.padStart ?? 0;
    const padEnd = scene.audio.padEnd ?? 0;
    const decodedSeconds = (sceneAudioBySceneId.get(scene.id) ?? []).reduce(
      (sum, block) => sum + block.durationSeconds,
      0,
    );

    const nextScene = spec.scenes[index + 1];
    if (nextScene?.transition?.kind === "cross-fade") {
      const crossFadeDuration = nextScene.transition.duration ?? 0;
      if (crossFadeDuration > padEnd) {
        diagnostics.push({
          path: `/scenes/${index}/audio`,
          message:
            `Scene "${scene.id}"'s cross-fade into "${nextScene.id}" is ${crossFadeDuration}s, longer ` +
            `than this scene's padEnd (${padEnd}s) — the next scene's voice will start over this ` +
            "scene's speech.",
        });
      }
    }

    if (typeof scene.duration === "number" && scene.duration < padStart + decodedSeconds + padEnd) {
      diagnostics.push({
        path: `/scenes/${index}/audio`,
        message:
          `Scene "${scene.id}"'s audio (padStart ${padStart}s + ${decodedSeconds}s + padEnd ${padEnd}s) ` +
          `exceeds its fixed duration (${scene.duration}s) and will be truncated at the scene end.`,
      });
    }
  });

  return diagnostics;
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
 * touched scenes get new `layers` arrays; untouched scenes are shared by reference.
 *
 * A scene whose blocks are `source: "audio"` (spec.md FR17, design.md D6) has no reference text
 * to align against, so it is skipped — the full scene list and its indices are otherwise
 * untouched — and its id is collected into the returned `skippedCaptionSceneIds`. (Only reached
 * for such a scene at all when `opts.captionsAllowPartial` let `runRenderPipeline` get this far;
 * the gate itself lives there.) */
async function insertCaptionsLayers(
  spec: VideoSpec,
  timeline: Timeline,
  sceneAudioBySceneId: Map<string, SynthesizedBlock[]>,
  alignFn: typeof align,
): Promise<{ spec: VideoSpec; skippedCaptionSceneIds: string[] }> {
  const skippedCaptionSceneIds: string[] = [];

  const scenes = await Promise.all(
    spec.scenes.map(async (scene) => {
      const blocks = sceneAudioBySceneId.get(scene.id);
      if (!blocks || blocks.length === 0) return scene;

      if (blocks[0]!.source === "audio") {
        skippedCaptionSceneIds.push(scene.id);
        return scene;
      }

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

  return { spec: { ...spec, scenes }, skippedCaptionSceneIds };
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

/** Shared render pipeline (spec.md FR9, design.md D1/D2): collects each scene's voice-track audio
 * (synthesized narration or decoded `scene.audio`), compiles the timeline, optionally inserts
 * forced-aligned captions layers, renders every frame through the encoder, and (if any scene has
 * voice audio) muxes the assembled voice track against the silent video into `opts.outputPath`.
 * Always disposes the renderer and cleans up the temp run, including on error (mirrors
 * `tools/bench/src/bench.ts`'s try/finally shape). Resolves to `{ skippedCaptionSceneIds }`:
 * empty unless `opts.captionsAllowPartial` caused some `scene.audio` scenes to render without
 * captions (spec.md FR17). */
export async function runRenderPipeline(
  spec: VideoSpec,
  opts: RenderPipelineOptions,
): Promise<{ skippedCaptionSceneIds: string[] }> {
  const synthesizeFn = opts.synthesizeFn ?? synthesize;
  const alignFn = opts.alignFn ?? align;
  const decodeAudioFn = opts.decodeAudioFn ?? decodeAudioFile;
  const probeFn = opts.probeFn ?? probe;
  const createEncodePipeFn = opts.createEncodePipeFn ?? createEncodePipe;
  const createRendererFn = opts.createRendererFn ?? createRenderer;
  const muxOutputFn = opts.muxOutputFn ?? muxOutput;
  const buildAudioGraphArgvFn = opts.buildAudioGraphArgvFn ?? buildAudioGraphArgv;

  // Captions gate (spec.md FR17, design.md D6) — checked before Step A so a caption request that
  // can't be honored fails before any synthesis/decode work happens.
  const audioSceneIds = spec.scenes.filter((scene) => scene.audio).map((scene) => scene.id);
  if (opts.captions && audioSceneIds.length > 0 && !opts.captionsAllowPartial) {
    throw new CaptionsExternalAudioError(audioSceneIds);
  }

  // Step A
  const sceneAudioBySceneId = await collectSceneAudio(spec, synthesizeFn, decodeAudioFn);
  const hasVoice = sceneAudioBySceneId.size > 0;

  // Step B + C
  const audioDurations = computeAudioDurationsRecord(spec, sceneAudioBySceneId);
  let renderSpec = spec;
  let timeline = compileTimeline(spec, { audioDurations });

  // Advisory diagnostics (spec.md FR15) — never fatal, reported the same way as motion/code below.
  reportDiagnostics("audio:", computeAudioAdvisoryDiagnostics(spec, sceneAudioBySceneId));

  // Step E (only if captions requested and something is actually voiced)
  let skippedCaptionSceneIds: string[] = [];
  if (opts.captions && hasVoice) {
    const inserted = await insertCaptionsLayers(spec, timeline, sceneAudioBySceneId, alignFn);
    renderSpec = inserted.spec;
    skippedCaptionSceneIds = inserted.skippedCaptionSceneIds;
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
    const voiceTrackPath = hasVoice ? await assembleVoiceTrack(spec, timeline, sceneAudioBySceneId, tempRun.dir) : undefined;

    const silentVideoPath = hasVoice ? path.join(tempRun.dir, "silent-video.mp4") : opts.outputPath;

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

    // Step G — mux (only if voice audio exists anywhere; otherwise the silent video written above
    // *is* opts.outputPath already, nothing further to do).
    if (hasVoice && voiceTrackPath) {
      const track: AudioTrack = { filePath: voiceTrackPath, role: "voice" };
      const argv = buildAudioGraphArgvFn({ tracks: [track], outputDurationSeconds: timeline.frameCount / spec.fps });
      await muxOutputFn({ silentVideoPath, audioGraphArgv: argv, outputPath: opts.outputPath, force: opts.force });
    }
  } finally {
    renderer.dispose();
    await tempRun.cleanup();
  }

  return { skippedCaptionSceneIds };
}
