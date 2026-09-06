export type EasingFn = (t: number) => number;

export const linear: EasingFn = (t) => t;

export const easeInQuad: EasingFn = (t) => t * t;
export const easeOutQuad: EasingFn = (t) => t * (2 - t);
export const easeInOutQuad: EasingFn = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

export const easeInCubic: EasingFn = (t) => t * t * t;
export const easeOutCubic: EasingFn = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic: EasingFn = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export const easeInExpo: EasingFn = (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10));
export const easeOutExpo: EasingFn = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const easeInOutExpo: EasingFn = (t) => {
  if (t === 0) return 0;
  if (t === 1) return 1;
  return t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2;
};

const BACK_C1 = 1.70158;
const BACK_C3 = BACK_C1 + 1;
const BACK_C2 = BACK_C1 * 1.525;

export const easeInBack: EasingFn = (t) => BACK_C3 * t * t * t - BACK_C1 * t * t;
export const easeOutBack: EasingFn = (t) => 1 + BACK_C3 * Math.pow(t - 1, 3) + BACK_C1 * Math.pow(t - 1, 2);
export const easeInOutBack: EasingFn = (t) =>
  t < 0.5
    ? (Math.pow(2 * t, 2) * ((BACK_C2 + 1) * 2 * t - BACK_C2)) / 2
    : (Math.pow(2 * t - 2, 2) * ((BACK_C2 + 1) * (t * 2 - 2) + BACK_C2) + 2) / 2;

/**
 * CSS-compatible cubic-bezier(x1, y1, x2, y2) easing, matching the timing-function spec:
 * `t` is elapsed-time progress (the bezier's x-axis); the return value is the eased
 * progress (its y-axis). Solved via Newton-Raphson with a bisection fallback, the same
 * approach browsers use for `cubic-bezier()`.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  const bezierComponent = (t: number, p1: number, p2: number) => {
    const c = 3 * p1;
    const b = 3 * (p2 - p1) - c;
    const a = 1 - c - b;
    return ((a * t + b) * t + c) * t;
  };
  const bezierComponentDerivative = (t: number, p1: number, p2: number) => {
    const c = 3 * p1;
    const b = 3 * (p2 - p1) - c;
    const a = 1 - c - b;
    return (3 * a * t + 2 * b) * t + c;
  };

  function solveXForT(x: number): number {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const currentX = bezierComponent(t, x1, x2) - x;
      const derivative = bezierComponentDerivative(t, x1, x2);
      if (Math.abs(derivative) < 1e-6) break;
      t -= currentX / derivative;
    }
    let lo = 0;
    let hi = 1;
    let guess = t;
    for (let i = 0; i < 20 && (guess < 0 || guess > 1 || Math.abs(bezierComponent(guess, x1, x2) - x) > 1e-6); i++) {
      const currentX = bezierComponent(guess, x1, x2);
      if (currentX < x) lo = guess;
      else hi = guess;
      guess = (lo + hi) / 2;
    }
    return guess;
  }

  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return bezierComponent(solveXForT(t), y1, y2);
  };
}

export type StepDirection = "start" | "end";

/** CSS-compatible `steps(n, direction)`. */
export function steps(n: number, direction: StepDirection = "end"): EasingFn {
  return (t: number) => {
    const clamped = Math.min(1, Math.max(0, t));
    const step = direction === "start" ? Math.ceil(clamped * n) : Math.floor(clamped * n);
    return Math.min(1, step / n);
  };
}
