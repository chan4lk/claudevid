import type { Timeline, PropertyBag } from "@claudevid/core";
import { evaluate } from "./track.js";
import type { ResolvedTrack } from "./track.js";

export interface MotionResolver {
  resolve(layerKey: string, frame: number): PropertyBag | undefined;
}

/** Wraps `compileMotion`'s output in the tiny shape `renderer-canvas`'s `renderFrame` consumes
 * (spec.md FR15) — closes over each layer's own active-interval start frame, already known to
 * `Timeline`, so the caller never has to thread it through separately. */
export function createResolver(compiled: Map<string, ResolvedTrack[]>, timeline: Timeline): MotionResolver {
  const startFrameByKey = new Map(timeline.layers.map((l) => [l.layerKey, l.startFrame]));

  return {
    resolve(layerKey: string, frame: number): PropertyBag | undefined {
      const tracks = compiled.get(layerKey);
      if (!tracks) return undefined;
      const trackStartFrame = startFrameByKey.get(layerKey);
      if (trackStartFrame === undefined) return undefined;
      return evaluate(tracks, frame, trackStartFrame);
    },
  };
}
