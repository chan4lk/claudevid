/** Resolved per-frame animatable values for one layer. Produced by `@claudevid/motion`'s
 * `evaluate`, consumed by `@claudevid/renderer-canvas`'s paint loop — this type is the
 * neutral contract point both packages depend on `@claudevid/core` for, so neither package
 * depends on the other. */
export interface PropertyBag {
  opacity?: number;
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
}
