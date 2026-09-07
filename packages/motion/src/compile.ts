import type { VideoSpec, Timeline, TimelineLayer, Diagnostic, Animation } from "@claudevid/core";
import { resolvePreset } from "./presets.js";
import { resolveEasing, bakeSpring, MotionConfigError, BAKE_CAP_SECONDS } from "./easing.js";
import { orderIndices } from "./stagger.js";
import type { Track, ResolvedTrack } from "./track.js";

export interface CompileMotionResult {
  compiled: Map<string, ResolvedTrack[]>;
  diagnostics: Diagnostic[];
}

function framesFor(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

/** True when `candidateKey` is a *direct* child of `parentKey` — one path segment deeper,
 * not a grandchild through a nested group (core's `flattenLayers` appends `/${index}` per
 * nesting level, so a grandchild key would contain a second `/` after the parent's prefix). */
function isDirectChild(parentKey: string, candidateKey: string): boolean {
  const prefix = `${parentKey}/`;
  if (!candidateKey.startsWith(prefix)) return false;
  return !candidateKey.slice(prefix.length).includes("/");
}

/** Resolves `animation.enter` against the preset registry, applying any top-level
 * `duration`/`delay`/`easing` override uniformly across the preset's own tracks. `undefined`
 * (with a diagnostic already pushed) for an unknown preset name — never a silent no-op
 * (spec.md Edge Cases). */
function resolvePresetTracks(anim: Animation, diagnostics: Diagnostic[], layerKey: string): Track[] | undefined {
  const tracks = resolvePreset(anim.enter!);
  if (!tracks) {
    diagnostics.push({
      path: `/${layerKey}/animation/enter`,
      message: `unknown preset "${anim.enter}"`,
      suggestion: "check the preset name against exportCatalogue()",
    });
    return undefined;
  }
  return tracks.map((t) => ({
    ...t,
    duration: anim.duration ?? t.duration,
    delay: anim.delay ?? t.delay,
    easing: anim.easing ?? t.easing,
  }));
}

function resolveTrack(track: Track, fps: number): ResolvedTrack {
  const delayFrames = framesFor(track.delay ?? 0, fps);

  if (typeof track.easing === "object") {
    const { frames, settled } = bakeSpring(track.easing, fps);
    if (!settled) {
      throw new UnsettledSpringError(`spring for "${track.property}" did not settle within the ${BAKE_CAP_SECONDS}s bake cap`);
    }
    return { property: track.property, from: track.from, to: track.to, delayFrames, durationFrames: frames.length, bakedFrames: frames };
  }

  const easingFn = resolveEasing(track.easing ?? "linear");
  const durationFrames = framesFor(track.duration, fps);
  return { property: track.property, from: track.from, to: track.to, delayFrames, durationFrames, easingFn };
}

class UnsettledSpringError extends Error {}

function compileTracksForLayer(
  tracks: Track[],
  tl: TimelineLayer,
  fps: number,
  compiled: Map<string, ResolvedTrack[]>,
  diagnostics: Diagnostic[]
): void {
  const frameCount = tl.endFrame - tl.startFrame;
  const resolved: ResolvedTrack[] = [];

  for (const track of tracks) {
    let rt: ResolvedTrack;
    try {
      rt = resolveTrack(track, fps);
    } catch (err) {
      if (err instanceof MotionConfigError || err instanceof UnsettledSpringError) {
        diagnostics.push({ path: `/${tl.layerKey}/animation`, message: err.message });
        continue;
      }
      throw err;
    }

    if (rt.delayFrames + rt.durationFrames > frameCount) {
      diagnostics.push({
        path: `/${tl.layerKey}/animation`,
        message: `animation (${rt.delayFrames + rt.durationFrames}f) exceeds the layer's active interval (${frameCount}f)`,
        suggestion: "shorten the animation or lengthen the layer",
      });
    }
    resolved.push(rt);
  }

  if (resolved.length > 0) compiled.set(tl.layerKey, resolved);
}

/** Test-only export (mirrors renderer-canvas's `_layoutCacheSizeForTests` convention) — lets
 * compile.test.ts exercise the unsettled-spring diagnostic path directly, since no shipped
 * v1 preset uses spring easing (AC4). */
export { compileTracksForLayer as _compileTracksForLayerForTests };

/**
 * The named baker/compiler (spec.md FR8): resolves every layer's `animation.enter` against
 * the preset registry, applies group stagger (FR10/FR11), bakes any spring easing using
 * `spec.fps` (design.md Key Decision D1), and clamp-checks each result against its layer's
 * active interval (FR9). Runs once, after `compileTimeline` and before the render loop.
 * `animation.exit` and non-group `animation.stagger` are diagnosed, not silently ignored —
 * see spec.md Notes for what's deferred and why.
 */
export function compileMotion(spec: VideoSpec, timeline: Timeline): CompileMotionResult {
  const diagnostics: Diagnostic[] = [];
  const compiled = new Map<string, ResolvedTrack[]>();

  for (const tl of timeline.layers) {
    const anim = tl.layer.animation;
    if (!anim) continue;

    if (anim.exit) {
      diagnostics.push({
        path: `/${tl.layerKey}/animation/exit`,
        message: "exit animations are not supported yet — deferred to a follow-up change",
        suggestion: "remove animation.exit for now",
      });
    }

    if (tl.layer.type === "group") {
      // The group's own entry is never painted (002 FR9) and its x/y is inert (FR11) — its
      // *animation* is what children inherit, resolved once and cloned per child.
      if (!anim.enter) continue;
      const baseTracks = resolvePresetTracks(anim, diagnostics, tl.layerKey);
      if (!baseTracks) continue;

      const children = timeline.layers.filter((c) => isDirectChild(tl.layerKey, c.layerKey));
      const order = anim.stagger ? orderIndices(children.map((c) => c.layerKey), anim.stagger.from) : null;

      children.forEach((child, i) => {
        const delayOffset = order ? anim.stagger!.each * order[i]! : 0;
        const tracks = delayOffset === 0 ? baseTracks : baseTracks.map((t) => ({ ...t, delay: (t.delay ?? 0) + delayOffset }));
        compileTracksForLayer(tracks, child, spec.fps, compiled, diagnostics);
      });
      continue;
    }

    if (anim.stagger) {
      diagnostics.push({
        path: `/${tl.layerKey}/animation/stagger`,
        message: "stagger is only meaningful on a group layer's animation",
        suggestion: "move stagger to the parent group's animation, or remove it here",
      });
    }

    if (!anim.enter) continue;
    const tracks = resolvePresetTracks(anim, diagnostics, tl.layerKey);
    if (!tracks) continue;
    compileTracksForLayer(tracks, tl, spec.fps, compiled, diagnostics);
  }

  return { compiled, diagnostics };
}
