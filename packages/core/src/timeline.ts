import type { Layer, VideoSpec } from "./types.js";
import { resolveAxis, resolveSceneBackground } from "./resolve.js";

export class MissingAudioDurationError extends Error {
  constructor(public readonly sceneId: string) {
    super(`Scene "${sceneId}" has duration: "auto" but no matching entry in audioDurations`);
    this.name = "MissingAudioDurationError";
  }
}

export interface SceneWindow {
  sceneId: string;
  startFrame: number;
  endFrame: number;
  /** Frames this scene's start overlaps with the previous scene, per its own `transition`
   * (change 003). `0` for the first scene or a `"cut"`/absent transition. */
  transitionInFrames: number;
}

export interface TransitionFrame {
  outgoing: TimelineLayer[];
  incoming: TimelineLayer[];
  /** Overlap progress, `0` (just entered) to just-under-`1` (about to resolve to `incoming` alone). */
  t: number;
}

export interface TimelineLayer {
  layerKey: string;
  sceneId: string;
  type: string;
  startFrame: number;
  endFrame: number;
  x: number;
  y: number;
  background?: string;
  layer: Layer;
}

export interface Timeline {
  frameCount: number;
  sceneWindows: SceneWindow[];
  layers: TimelineLayer[];
  activeAt(frame: number): TimelineLayer[];
  /** Non-null only inside a scene's transition-overlap window (change 003). `activeAt` is
   * unchanged and unaware of transitions — this is a new, additive, opt-in query. */
  transitionAt(frame: number): TransitionFrame | null;
}

export interface CompileTimelineOptions {
  /** Seconds per scene id, required for any scene whose duration is `"auto"`. */
  audioDurations?: Record<string, number>;
}

function framesFor(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

function resolveSceneDurationSeconds(scene: VideoSpec["scenes"][number], audioDurations?: Record<string, number>): number {
  if (scene.duration !== "auto") return scene.duration;
  const seconds = audioDurations?.[scene.id];
  if (seconds === undefined) throw new MissingAudioDurationError(scene.id);
  return seconds;
}

function flattenLayers(
  layers: Layer[],
  sceneId: string,
  sceneStartFrame: number,
  sceneEndFrame: number,
  fps: number,
  width: number,
  height: number,
  background: string | undefined,
  keyPrefix: string
): TimelineLayer[] {
  const result: TimelineLayer[] = [];
  layers.forEach((layer, index) => {
    const layerKey = `${keyPrefix}/${index}`;
    const sceneFrameCount = sceneEndFrame - sceneStartFrame;

    const localStartFrame = layer.start !== undefined ? framesFor(layer.start, fps) : 0;
    const localEndFrame = layer.duration !== undefined ? localStartFrame + framesFor(layer.duration, fps) : sceneFrameCount;

    // Overflow past the scene window is a documented v1 limitation: clamp, don't diagnose.
    const clampedStart = Math.min(Math.max(localStartFrame, 0), sceneFrameCount);
    const clampedEnd = Math.min(Math.max(localEndFrame, clampedStart), sceneFrameCount);

    result.push({
      layerKey,
      sceneId,
      type: layer.type,
      startFrame: sceneStartFrame + clampedStart,
      endFrame: sceneStartFrame + clampedEnd,
      x: resolveAxis(layer.x, width),
      y: resolveAxis(layer.y, height),
      background,
      layer,
    });

    if (layer.type === "group") {
      result.push(
        ...flattenLayers(layer.children, sceneId, sceneStartFrame, sceneEndFrame, fps, width, height, background, layerKey)
      );
    }
  });
  return result;
}

function binarySearchSceneWindow(sceneWindows: SceneWindow[], frame: number): SceneWindow | undefined {
  let lo = 0;
  let hi = sceneWindows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const window = sceneWindows[mid]!;
    if (frame < window.startFrame) {
      hi = mid - 1;
    } else if (frame >= window.endFrame) {
      lo = mid + 1;
    } else {
      return window;
    }
  }
  return undefined;
}

/**
 * Turns a relative, human/Claude-authored VideoSpec into a flat, absolute, integer-frame
 * Timeline. `frameCount`, `sceneWindows`, and `activeAt` are the only timing authority in
 * the system — nothing downstream re-derives a boundary from a `duration` field.
 */
export function compileTimeline(spec: VideoSpec, opts: CompileTimelineOptions = {}): Timeline {
  let frameCursor = 0;
  const sceneWindows: SceneWindow[] = [];
  const layers: TimelineLayer[] = [];

  spec.scenes.forEach((scene, sceneIndex) => {
    const seconds = resolveSceneDurationSeconds(scene, opts.audioDurations);
    const sceneFrameCount = framesFor(seconds, spec.fps);

    // Overlapping transitions (FR12): the requested overlap is clamped so it never exceeds
    // either neighbour's own frame count minus one — a transition longer than a scene
    // degrades to the largest overlap that still leaves both scenes at least one solo frame,
    // rather than producing a negative-length scene. The clamp is silent here (matching this
    // file's existing "clamp, don't diagnose" precedent for rendering-time overflow, line
    // ~90); the diagnostic about a clamp having actually fired belongs to
    // `@claudevid/motion`'s `compileMotion`, which has both this Timeline and the spec's
    // requested duration to compare (design.md Key Decision D3).
    const requestedOverlapFrames =
      scene.transition?.kind === "cross-fade" ? framesFor(scene.transition.duration ?? 0, spec.fps) : 0;
    const prevWindow = sceneWindows[sceneIndex - 1];
    const prevFrameCount = prevWindow ? prevWindow.endFrame - prevWindow.startFrame : 0;
    const overlapFrames = Math.min(
      requestedOverlapFrames,
      Math.max(0, prevFrameCount - 1),
      Math.max(0, sceneFrameCount - 1)
    );

    const startFrame = frameCursor - overlapFrames;
    const endFrame = startFrame + sceneFrameCount;
    sceneWindows.push({ sceneId: scene.id, startFrame, endFrame, transitionInFrames: overlapFrames });

    const background = resolveSceneBackground(scene.background, spec.background);
    layers.push(
      ...flattenLayers(
        scene.layers,
        scene.id,
        startFrame,
        endFrame,
        spec.fps,
        spec.width,
        spec.height,
        background,
        `scenes/${sceneIndex}/layers`
      )
    );

    frameCursor = endFrame;
  });

  return {
    frameCount: frameCursor,
    sceneWindows,
    layers,
    activeAt(frame: number): TimelineLayer[] {
      const window = binarySearchSceneWindow(sceneWindows, frame);
      if (!window) return [];
      return layers.filter(
        (layer) => layer.sceneId === window.sceneId && frame >= layer.startFrame && frame < layer.endFrame
      );
    },
    transitionAt(frame: number): TransitionFrame | null {
      const incomingWindow = binarySearchSceneWindow(sceneWindows, frame);
      if (!incomingWindow || incomingWindow.transitionInFrames === 0) return null;

      const overlapStart = incomingWindow.startFrame;
      const overlapEnd = overlapStart + incomingWindow.transitionInFrames;
      if (frame < overlapStart || frame >= overlapEnd) return null;

      const prevWindow = sceneWindows[sceneWindows.indexOf(incomingWindow) - 1];
      if (!prevWindow) return null; // transitionInFrames > 0 implies a previous scene exists

      return {
        // No endFrame extension needed: overlapEnd === prevWindow.endFrame by construction
        // (the incoming scene's start was pulled backward by exactly the overlap, not the
        // outgoing scene's end pushed forward), so the outgoing scene's own layer.endFrame
        // values already cover the whole overlap window.
        outgoing: layers.filter(
          (layer) => layer.sceneId === prevWindow.sceneId && frame >= layer.startFrame && frame < layer.endFrame
        ),
        incoming: layers.filter(
          (layer) => layer.sceneId === incomingWindow.sceneId && frame >= layer.startFrame && frame < layer.endFrame
        ),
        t: (frame - overlapStart) / incomingWindow.transitionInFrames,
      };
    },
  };
}
