import type { PropertyBag } from "@claudevid/core";
import type { Channel } from "./properties.js";
import type { EasingFn, SpringSpec } from "./easing.js";

export type EasingRef = string | SpringSpec;

/**
 * A single from→to animation segment for one channel. Authored only by first-party preset
 * code (`presets.ts`) in v1 — never spec-authored — so `duration` is required and there are
 * no `keyframes`/`repeat`/`direction` fields to leave ambiguous (spec.md FR2, Notes "Scope
 * cuts").
 */
export interface Track {
  property: Channel;
  from: number;
  to: number;
  /** Seconds. Required — no default to disagree about. */
  duration: number;
  /** Seconds. Default `0`. */
  delay?: number;
  /** Default `"linear"`. */
  easing?: EasingRef;
}

/**
 * A `Track` with timing already converted to frames (and, for a spring `easing`, already
 * baked) by `compileMotion` — the one place `fps` is in scope. `evaluate` never sees seconds
 * or fps, only frame counts, matching `Timeline`'s own frame-indexed authority (spec.md FR3,
 * design.md Key Decision D1).
 */
export interface ResolvedTrack {
  property: Channel;
  from: number;
  to: number;
  delayFrames: number;
  durationFrames: number;
  /** Set when `easing` was a named/parametric string (not a spring). */
  easingFn?: EasingFn;
  /** Set when `easing` was a `SpringSpec` — per-frame eased progress, already baked. */
  bakedFrames?: number[];
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Pure lookup: given a layer's resolved tracks and the current absolute frame, returns the
 * resolved `PropertyBag`. `trackStartFrame` is the layer's own active-interval start frame
 * (from `Timeline`) — tracks are always relative to it. */
export function evaluate(tracks: ResolvedTrack[], frame: number, trackStartFrame: number): PropertyBag {
  const bag: PropertyBag = {};

  for (const track of tracks) {
    const localFrame = frame - trackStartFrame - track.delayFrames;
    let progress: number;

    if (track.bakedFrames) {
      const idx = Math.max(0, Math.min(track.bakedFrames.length - 1, localFrame));
      progress = track.bakedFrames[idx]!;
    } else {
      const t = clamp01(track.durationFrames === 0 ? 1 : localFrame / track.durationFrames);
      progress = (track.easingFn ?? ((x: number) => x))(t);
    }

    bag[track.property] = track.from + (track.to - track.from) * progress;
  }

  return bag;
}
