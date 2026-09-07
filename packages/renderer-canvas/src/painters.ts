import type { SKRSContext2D } from "@napi-rs/canvas";
import type { TimelineLayer } from "@claudevid/core";

/**
 * A registered painter draws one active layer directly onto the current frame's `ctx`
 * (already positioned so the caller can draw at the layer's local origin — see index.ts's
 * `default` switch branch). `entry` is deliberately typed no more precisely than `unknown`:
 * `renderer-canvas` has no knowledge of a registering package's own compiled-layer shape
 * (e.g. `@claudevid/layer-code`'s `CompiledCodeLayer`) — the registered closure captures
 * whatever internal lookup it needs itself and casts `entry`/`timelineLayer.layer` on its own
 * side (design.md 004 "Data Model Changes" / Key Decision D3, D4).
 */
export type PainterFn = (entry: unknown, timelineLayer: TimelineLayer, frame: number, ctx: SKRSContext2D) => void;

const registry = new Map<string, PainterFn>();

/**
 * Extends the render dispatch without editing `index.ts`'s `switch` — mirrors
 * `packages/core/src/layers.ts`'s `registerLayer(type, schema)` shape one layer up: a
 * plain `Map`, last registration for a given `type` wins, no validation of `type` itself.
 * Used by 004 (`code`) via `@claudevid/layer-code`'s `registerPainter("code", ...)`.
 */
export function registerPainter(type: string, paint: PainterFn): void {
  registry.set(type, paint);
}

/**
 * Returns `undefined` for any `type` with no registered painter — same "unknown type is not
 * an error" contract `index.ts`'s existing `default: continue` already uses for `"group"` and
 * any other unrecognized `layer.layer.type`.
 */
export function getPainter(type: string): PainterFn | undefined {
  return registry.get(type);
}
