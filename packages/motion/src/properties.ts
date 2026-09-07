/**
 * Animatable channels, v1. Only the "free" channels from the cost-class table ship in this
 * change — none invalidate `@claudevid/renderer-canvas`'s raster cache (spec.md FR1, Notes
 * "Scope cuts"). Colour, `fontSize`, `letterSpacing`, and text-reveal channels are deferred
 * until a cost-diagnostic mechanism exists to guard them.
 */
export type Channel = "opacity" | "x" | "y" | "scaleX" | "scaleY" | "rotation";

export const CHANNELS: readonly Channel[] = ["opacity", "x", "y", "scaleX", "scaleY", "rotation"];

export type CostClass = "free";

/** Every v1 channel is "free": composited via `ctx.globalAlpha`/`ctx.translate`/`ctx.rotate`/
 * `ctx.scale` around the layer's existing rasterized bitmap — no re-layout, no raster-cache
 * invalidation. Kept as a table (not a hardcoded assumption) so a future invalidating channel
 * has a place to declare its own cost class without restructuring this module. */
export const COST_CLASS: Readonly<Record<Channel, CostClass>> = {
  opacity: "free",
  x: "free",
  y: "free",
  scaleX: "free",
  scaleY: "free",
  rotation: "free",
};

export function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}
