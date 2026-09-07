import {
  linear,
  easeInQuad,
  easeOutQuad,
  easeInOutQuad,
  easeInCubic,
  easeOutCubic,
  easeInOutCubic,
  easeInExpo,
  easeOutExpo,
  easeInOutExpo,
  easeInBack,
  easeOutBack,
  easeInOutBack,
  cubicBezier,
  steps,
  type EasingFn,
} from "@claudevid/core";

export type { EasingFn };

/** Thrown by `resolveEasing`/`bakeSpring` for author error (unknown easing name, spring
 * params out of range). `compileMotion` (compile.ts) catches this and turns it into a
 * `Diagnostic` — never lets it reach the render loop as an uncaught throw. */
export class MotionConfigError extends Error {}

// Named, non-spring easing functions — every one of these delegates to @claudevid/core's own
// export (spec.md FR5). This module adds exactly one new primitive: spring/bakeSpring.
const NAMED_EASINGS: Readonly<Record<string, EasingFn>> = {
  linear,
  "ease-in-quad": easeInQuad,
  "ease-out-quad": easeOutQuad,
  "ease-in-out-quad": easeInOutQuad,
  "ease-in-cubic": easeInCubic,
  "ease-out-cubic": easeOutCubic,
  "ease-in-out-cubic": easeInOutCubic,
  "ease-in-expo": easeInExpo,
  "ease-out-expo": easeOutExpo,
  "ease-in-out-expo": easeInOutExpo,
  "ease-in-back": easeInBack,
  "ease-out-back": easeOutBack,
  "ease-in-out-back": easeInOutBack,
};

const CUBIC_BEZIER_RE = /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/;
const STEPS_RE = /^steps\(\s*(\d+)\s*(?:,\s*(start|end)\s*)?\)$/;

/** Resolves a named/parametric easing string to a function. Throws `MotionConfigError` for
 * an unrecognized name — `compileMotion` turns that into a diagnostic (spec.md Edge Cases:
 * unknown preset/easing names are never a silent no-op). */
export function resolveEasing(name: string): EasingFn {
  const named = NAMED_EASINGS[name];
  if (named) return named;

  const bezierMatch = CUBIC_BEZIER_RE.exec(name);
  if (bezierMatch) {
    const [, x1, y1, x2, y2] = bezierMatch;
    return cubicBezier(Number(x1), Number(y1), Number(x2), Number(y2));
  }

  const stepsMatch = STEPS_RE.exec(name);
  if (stepsMatch) {
    const [, n, direction] = stepsMatch;
    return steps(Number(n), (direction as "start" | "end" | undefined) ?? "end");
  }

  throw new MotionConfigError(`unknown easing "${name}"`);
}

export interface SpringSpec {
  stiffness: number;
  damping: number;
  mass: number;
  velocity?: number;
}

export interface BakedSpring {
  /** Per-frame eased progress, 0 (start) → ~1 (settled). `frames[0]` is the pre-integration
   * sample (t=0); index i>0 is after i integration steps at `1/fps`. */
  frames: number[];
  /** `false` if the bake hit the hard cap (`fps * 5` samples) without settling — the caller
   * must treat this as a diagnostic (FR9), never silently use the truncated curve as final. */
  settled: boolean;
}

const SETTLE_EPSILON = 0.001;
const SETTLE_STREAK_REQUIRED = 3;
const BAKE_CAP_SECONDS = 5;

function assertInRange(value: number, min: number, max: number, label: string): void {
  if (!(value > min && value <= max)) {
    throw new MotionConfigError(`spring ${label} must be in (${min}, ${max}], got ${value}`);
  }
}

/** Solves a damped spring via semi-implicit Euler integration at a fixed `1/fps` timestep and
 * bakes it to a fixed-length array (spec.md FR4) — the one place `fps` enters spring easing,
 * called from `compileMotion` (design.md's named baker). */
export function bakeSpring(spec: SpringSpec, fps: number): BakedSpring {
  assertInRange(spec.stiffness, 0, 1000, "stiffness");
  assertInRange(spec.damping, 0, 100, "damping");
  assertInRange(spec.mass, 0.01, 100, "mass");

  const dt = 1 / fps;
  const capSamples = Math.max(1, Math.round(fps * BAKE_CAP_SECONDS));

  let value = 0;
  let velocity = spec.velocity ?? 0;
  const frames: number[] = [value];
  let settledStreak = 0;
  let settled = false;

  while (frames.length < capSamples) {
    const acceleration = (spec.stiffness * (1 - value) - spec.damping * velocity) / spec.mass;
    velocity += acceleration * dt;
    value += velocity * dt;
    frames.push(value);

    if (Math.abs(1 - value) < SETTLE_EPSILON && Math.abs(velocity) < SETTLE_EPSILON) {
      settledStreak++;
      if (settledStreak >= SETTLE_STREAK_REQUIRED) {
        settled = true;
        break;
      }
    } else {
      settledStreak = 0;
    }
  }

  return { frames, settled };
}
