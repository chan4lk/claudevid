import type { SKRSContext2D } from "@napi-rs/canvas";
import { createCanvas } from "@napi-rs/canvas";
import type { Timeline, TimelineLayer, PropertyBag } from "@claudevid/core";
import { createRasterCache, type RasterCache } from "./raster-cache.js";
import { createStatsCollector, type RenderStats } from "./stats.js";
import { registerBundledFonts } from "./fonts.js";
import { paintTextLayer } from "./text.js";
import { paintRectLayer } from "./draw-shapes.js";
import { paintImageLayer } from "./draw-image.js";
import { loadAndCacheImage } from "./draw-image.js";
import type { FrameBuffer } from "./frame-buffer.js";
import { getPainter } from "./painters.js";

export type { FrameBuffer } from "./frame-buffer.js";
export { createFrameBuffer, createFrameBufferPool } from "./frame-buffer.js";
export type { RenderStats } from "./stats.js";
export { registerPainter, getPainter } from "./painters.js";
export type { PainterFn } from "./painters.js";

const DEFAULT_CACHE_LIMIT_BYTES = 512 * 1024 * 1024;
const DEFAULT_BACKGROUND = "#000000";

/** Structural (duck-typed) contract for change 003's motion resolver — matches
 * `@claudevid/motion`'s `MotionResolver` shape exactly, but this package does not depend on
 * `@claudevid/motion` (spec.md FR13/FR15: neither package gains a new dependency; `PropertyBag`
 * is the shared neutral type both already get from `@claudevid/core`). */
export interface MotionResolver {
  resolve(layerKey: string, frame: number): PropertyBag | undefined;
}

export interface RenderFrameOptions {
  scale?: number;
  /** When present, each active layer's paint call is wrapped in a transform bracket built
   * from its resolved `PropertyBag` (spec.md FR14/FR15). Omitting it (existing call sites)
   * changes nothing — additive only (NFR3). */
  motion?: MotionResolver;
}

/** `ctx.save()`s, applies opacity + a center-origin translate/rotate/scale bracket from a
 * resolved `PropertyBag`, and leaves the canvas positioned so the caller can draw at the
 * *local* origin `(0, 0)` — the caller must `ctx.restore()` once done. `boxWidth`/`boxHeight`
 * are the layer's own rendered size (design.md FR14 — no separate origin override in v1). */
function applyMotionTransform(
  ctx: SKRSContext2D,
  bag: PropertyBag,
  x: number,
  y: number,
  boxWidth: number,
  boxHeight: number
): void {
  ctx.save();
  ctx.globalAlpha = bag.opacity ?? 1;
  const centerX = x + boxWidth / 2 + (bag.x ?? 0);
  const centerY = y + boxHeight / 2 + (bag.y ?? 0);
  ctx.translate(centerX, centerY);
  ctx.rotate(((bag.rotation ?? 0) * Math.PI) / 180);
  ctx.scale(bag.scaleX ?? 1, bag.scaleY ?? 1);
  ctx.translate(-boxWidth / 2, -boxHeight / 2);
}

export interface CreateRendererOptions {
  cacheLimitBytes?: number;
}

export interface Renderer {
  renderFrame(timeline: Timeline, frame: number, target: FrameBuffer, opts?: RenderFrameOptions): Promise<void>;
  stats(): RenderStats;
  dispose(): void;
}

/**
 * `width`/`height` fix the one working canvas for this Renderer's lifetime, and every
 * `target: FrameBuffer` passed to `renderFrame` must be sized to match (FR3's raw-copy
 * extraction is a straight `Buffer` copy, no resampling). `opts.scale` in `renderFrame` is
 * NOT a ratio against a spec's native resolution — `Timeline` (core's compiled output)
 * exposes no width/height, only pixel-resolved layer coordinates, so there is nothing to
 * divide by here. It is a direct multiplier handed straight to `ctx.scale(scale, scale)`:
 * callers that want a scaled-down preview construct a smaller Renderer (e.g. 1280x720) and
 * pass `scale = 1280 / <spec width>` themselves, so `Timeline`-resolved coordinates (always
 * in the spec's native pixel space) land in the right place on the smaller canvas.
 */
export function createRenderer(width: number, height: number, opts: CreateRendererOptions = {}): Renderer {
  registerBundledFonts();

  const workingCanvas = createCanvas(width, height);
  const ctx = workingCanvas.getContext("2d");
  const cacheLimitBytes = opts.cacheLimitBytes ?? DEFAULT_CACHE_LIMIT_BYTES;
  let cache: RasterCache = createRasterCache(cacheLimitBytes);
  let stats = createStatsCollector();

  // Hold-frame reuse (FR11): `previousOutput` is an independent `Buffer.from` snapshot,
  // not a view into `target.data` — the caller owns `target` and may reuse/mutate it
  // (e.g. a FrameBuffer pool) between calls, so aliasing into it would go stale.
  let previousLayerKeys: string | null = null;
  let previousOutput: Buffer | null = null;

  async function paintFrame(active: TimelineLayer[], scale: number, motion: MotionResolver | undefined, frame: number): Promise<void> {
    // Background is per-scene, not per-layer: every active layer in the same frame shares
    // the same scene and therefore the same `background` string (set once by core's
    // `flattenLayers`), so painting it once from the first active layer (or the opaque
    // default) avoids a redundant full-canvas fillRect per layer. During a cross-fade
    // (change 003) this is called once per side (outgoing, then incoming under a `globalAlpha`
    // set by the caller) — each call's `active` list is a single scene's layers, so this still
    // holds; the second call's fillRect blends over the first via the ambient alpha rather
    // than clearing it, which is exactly the two-pass cross-dissolve (design.md Key Decision D5).
    const background = active[0]?.background ?? DEFAULT_BACKGROUND;
    ctx.fillStyle = background;
    // Unscaled and outside the `ctx.scale` bracket below: the working canvas is reused
    // across calls (FR1 — no per-frame allocation), so a scale < 1 must still clear the
    // *entire* physical canvas or the previous frame's pixels bleed through around the edges.
    ctx.fillRect(0, 0, workingCanvas.width, workingCanvas.height);

    ctx.save();
    ctx.scale(scale, scale);
    for (const layer of active) {
      const layerStart = Date.now();
      const bag = motion?.resolve(layer.layerKey, frame);
      switch (layer.layer.type) {
        case "text": {
          const bitmap = paintTextLayer(cache, layer.layer, layer.layerKey);
          if (bag) {
            applyMotionTransform(ctx, bag, layer.x, layer.y, bitmap.width, bitmap.height);
            ctx.drawImage(bitmap, 0, 0);
            ctx.restore();
          } else {
            ctx.drawImage(bitmap, layer.x, layer.y);
          }
          break;
        }
        case "rect": {
          const bitmap = paintRectLayer(cache, layer.layer);
          if (bag) {
            applyMotionTransform(ctx, bag, layer.x, layer.y, bitmap.width, bitmap.height);
            ctx.drawImage(bitmap, 0, 0);
            ctx.restore();
          } else {
            ctx.drawImage(bitmap, layer.x, layer.y);
          }
          break;
        }
        case "image": {
          if (bag) {
            // paintImageLayer resolves its own box (layer.width/height ?? natural image size)
            // internally — peek it here via the same decode cache (a no-op re-lookup once
            // loaded) so the transform bracket can be established before drawing.
            const image = await loadAndCacheImage(layer.layer.src);
            const boxWidth = layer.layer.width ?? image.naturalWidth;
            const boxHeight = layer.layer.height ?? image.naturalHeight;
            applyMotionTransform(ctx, bag, layer.x, layer.y, boxWidth, boxHeight);
            await paintImageLayer(ctx, layer.layer, 0, 0);
            ctx.restore();
          } else {
            await paintImageLayer(ctx, layer.layer, layer.x, layer.y);
          }
          break;
        }
        default: {
          // "group" (already flattened into per-child entries by core's `flattenLayers` —
          // see timeline.ts): no painter is ever registered for it, always falls through to
          // `continue` below. Any other type registered via `registerLayer` (change 004's
          // `registerPainter` registry, painters.ts) gets a chance here before the same
          // silent-skip fallback (FR9/dispatch contract) for a type with neither a built-in
          // case nor a registered painter.
          const paint = getPainter(layer.layer.type);
          if (!paint) continue;
          // Same transform-bracket shape as the text/rect/image cases above, minus the
          // box-center pivot those use before `drawImage`-ing a bitmap: a registered painter
          // draws directly onto `ctx` rather than handing back a sized bitmap, so there is no
          // box width/height here to center a rotate/scale pivot on. The bracket still
          // applies opacity/translate/rotate/scale from the resolved `bag`, pivoted at the
          // layer's own (x, y) anchor, and otherwise just translates to (x, y) — a painter
          // that needs box-center pivoting reads its own layer's width/height off
          // `layer.layer` (cast internally, per design.md 004 Key Decision D3/D4) and
          // compensates itself.
          ctx.save();
          if (bag) {
            ctx.globalAlpha = bag.opacity ?? 1;
            ctx.translate(layer.x + (bag.x ?? 0), layer.y + (bag.y ?? 0));
            ctx.rotate(((bag.rotation ?? 0) * Math.PI) / 180);
            ctx.scale(bag.scaleX ?? 1, bag.scaleY ?? 1);
          } else {
            ctx.translate(layer.x, layer.y);
          }
          paint(layer.layer, layer, frame, ctx);
          ctx.restore();
          break;
        }
      }
      stats.recordLayerTypeMs(layer.layer.type, Date.now() - layerStart);
    }
    ctx.restore();
  }

  return {
    async renderFrame(timeline, frame, target, frameOpts = {}) {
      const frameStart = Date.now();
      // `transitionAt` is new and additive (design.md Key Decision D6) — defensively optional
      // so a `Timeline` from a caller that predates change 003 still works (NFR3).
      const transition = timeline.transitionAt?.(frame) ?? null;
      const active = transition ? [...transition.outgoing, ...transition.incoming] : timeline.activeAt(frame);

      const motion = frameOpts.motion;
      // A layer with a resolved `PropertyBag` genuinely differs frame-to-frame — the
      // hold-frame fast path (002 FR11) would otherwise reuse a stale animated frame, exactly
      // the bug 002's own spec.md flagged as change 003's job to fix (FR16).
      const anyMotion = motion ? active.some((l) => motion.resolve(l.layerKey, frame) !== undefined) : false;
      const keySignature = active
        .map((l) => l.layerKey)
        .sort()
        .join(",");

      if (!transition && !anyMotion && keySignature === previousLayerKeys && previousOutput) {
        previousOutput.copy(target.data);
        stats.recordHoldFrame();
        stats.recordFrameMs(Date.now() - frameStart);
        return;
      }

      const scale = frameOpts.scale ?? 1;
      if (transition) {
        // Two-pass cross-dissolve (design.md Key Decision D5): outgoing scene painted opaque,
        // then the incoming scene painted on top under `globalAlpha = t` — no new compositing
        // math, just the existing per-scene paint called twice.
        await paintFrame(transition.outgoing, scale, motion, frame);
        ctx.save();
        ctx.globalAlpha = transition.t;
        await paintFrame(transition.incoming, scale, motion, frame);
        ctx.restore();
      } else {
        await paintFrame(active, scale, motion, frame);
      }

      workingCanvas.data().copy(target.data);
      previousOutput = Buffer.from(target.data);
      previousLayerKeys = keySignature;
      stats.recordPaint();
      stats.recordFrameMs(Date.now() - frameStart);
    },
    stats() {
      // Cache hit/miss counts live on `RasterCache`, not `StatsCollector` (painters only
      // ever see the cache, never the stats collector) — merge them in here so
      // `renderer.stats()` is the one place callers read a complete `RenderStats`.
      const cacheStats = cache.stats();
      return { ...stats.stats(), cacheHits: cacheStats.hits, cacheMisses: cacheStats.misses };
    },
    dispose() {
      // Dispose contract (AC9): replace both the raster cache and the stats collector with
      // fresh instances, rather than throwing on reuse. A `stats()` call after `dispose()`
      // therefore reports an all-zero `RenderStats` (`cacheHits: 0`, `cacheMisses: 0`,
      // `msPerFrame: []`, ...) — a clean-slate Renderer, not a poisoned one. A subsequent
      // `renderFrame` call still works; it just repaints everything (empty cache) and
      // restarts hold-frame tracking (`previousOutput`/`previousLayerKeys` reset too).
      cache.dispose();
      cache = createRasterCache(cacheLimitBytes);
      stats = createStatsCollector();
      previousLayerKeys = null;
      previousOutput = null;
    },
  };
}
