# Design: Canvas Render Engine (@napi-rs/canvas) with Raster Caching

**Change:** 002-canvas-render-engine
**Created:** 2026-09-06

## Technical Approach

One long-lived `Renderer` per rendering context (per worker in change 005), owning one
working canvas and one raster cache (a `Map<string, OffscreenBitmap>`). `renderFrame` is
called once per output frame; everything expensive (measurement, layout, gradient math,
image decode) happens at most once per unique content, guarded by content-hash cache keys.

```
renderFrame(timeline, frame, target, opts)
  │
  ├─ activeLayers = timeline.activeAt(frame)                     [FR10 — core already culls]
  ├─ if activeLayers.keys() == previousFrame.activeLayers.keys() [FR11 — hold-frame reuse]
  │     copy previousOutput → target; done
  ├─ ctx.save(); ctx.scale(opts.scale ?? 1, ...); ctx.restore-at-end            [FR12]
  ├─ paint background (spec/scene, always opaque)
  ├─ for each active layer (recursing into groups):                            [FR9]
  │     cacheKey = contentHash(layer)                                          [FR4]
  │     if not cached: rasterize once to an offscreen canvas, store in cache
  │     ctx.drawImage(cached, x, y) + globalAlpha/transform
  ├─ workingCanvas.data() → Buffer.copy(target.data)                           [FR3]
  └─ stats.record(...)                                                        [FR13]
```

## Architecture

```
packages/renderer-canvas/
  src/
    index.ts          # createRenderer, Renderer, renderFrame, dispose
    frame-buffer.ts   # FrameBuffer type, createFrameBuffer, createFrameBufferPool
    raster-cache.ts   # RasterCache: get-or-render, content hashing, LRU, byte ceiling
    text.ts           # measure/wrap/position, layout cache, glyph raster
    draw-shapes.ts    # rect/rounded-rect/border/gradients
    draw-image.ts     # decode cache, fit modes
    fonts.ts          # bundled font registration + fallback chain
    stats.ts          # RenderStats accumulator
  test/
    frame-buffer.test.ts   # byte order (AC2), FrameBuffer pool behavior
    raster-cache.test.ts   # cache hit/miss, LRU eviction, key collisions
    text.test.ts            # wrap correctness (AC8), layout cache
    draw-shapes.test.ts      # rect/gradient painters
    draw-image.test.ts        # fit modes, decode cache
    render.test.ts              # integration: AC1, AC3, AC5, AC6, AC9 (full Renderer)
    perf.test.ts                  # AC7 — ms/frame p95 ceiling, CI-gated
  package.json
  tsup.config.ts
  vitest.config.ts
```

### Empirical spike results (grounding NFR2, FR3)

Run against this repo's locked `@napi-rs/canvas` version, in this environment:

```
createCanvas(4,4); fillStyle="#ff0000"; fillRect(...)
canvas.data() → Buffer, first 4 bytes: [255, 0, 0, 255]     → confirms RGBA order

fillStyle="rgba(255,0,0,0.5)"; fillRect(...)
canvas.data() → first 4 bytes: [127, 0, 0, 127]             → confirms premultiplied alpha
                (straight alpha would read [255, 0, 0, 127])

GlobalFonts.registerFromPath  → function, confirmed available
```

AC2 turns the first observation into a committed regression test. The second is documented
in spec.md Notes as a non-issue for the final frame (always-opaque assumption) and not
re-tested per-frame — it would only matter if a raster-cache bitmap were read out manually
instead of composited via `ctx.drawImage`, which this package never does.

### Raster cache (`raster-cache.ts`)

```ts
export interface RasterCache {
  getOrRender(key: string, width: number, height: number, paint: (ctx: SKRSContext2D) => void): Canvas;
  stats(): { hits: number; misses: number; bytesUsed: number };
  dispose(): void;
}

export function createRasterCache(limitBytes: number): RasterCache {
  const entries = new Map<string, { canvas: Canvas; bytes: number }>(); // insertion order = LRU recency
  let bytesUsed = 0;
  let hits = 0, misses = 0;

  return {
    getOrRender(key, width, height, paint) {
      const existing = entries.get(key);
      if (existing) {
        hits++;
        entries.delete(key); entries.set(key, existing); // bump recency
        return existing.canvas;
      }
      misses++;
      const canvas = createCanvas(width, height);
      paint(canvas.getContext("2d"));
      const bytes = width * height * 4;
      entries.set(key, { canvas, bytes });
      bytesUsed += bytes;
      while (bytesUsed > limitBytes && entries.size > 1) {
        const [oldestKey, oldest] = entries.entries().next().value;
        entries.delete(oldestKey);
        bytesUsed -= oldest.bytes;
      }
      return canvas;
    },
    stats: () => ({ hits, misses, bytesUsed }),
    dispose() { entries.clear(); bytesUsed = 0; },
  };
}
```

Content-hash keys are built per painter (`text.ts` hashes `text|font|size|weight|color|
wrapWidth`; `draw-shapes.ts` hashes the shape's own resolved fields; `draw-image.ts` hashes
`src|fitMode|width|height`) — never a single generic `JSON.stringify(layer)`, because two
structurally-different layer objects that resolve to the same pixels (e.g. differing
`start`/`duration` timing fields, which don't affect appearance) should share one cache entry.

### Hold-frame reuse (`index.ts`)

```ts
let previousLayerKeys: string | null = null; // joined, sorted layerKeys — cheap to compare
let previousOutput: Buffer | null = null;

function renderFrame(timeline, frame, target, opts = {}) {
  const active = timeline.activeAt(frame);
  const keySignature = active.map(l => l.layerKey).sort().join(",");

  if (keySignature === previousLayerKeys && previousOutput) {
    previousOutput.copy(target.data);
    stats.recordHoldFrame();
    return;
  }

  paintFrame(active, opts); // the real work
  workingCanvas.data().copy(target.data);
  previousOutput = Buffer.from(target.data); // snapshot for next call's potential reuse
  previousLayerKeys = keySignature;
  stats.recordPaint();
}
```

The `previousOutput` snapshot is one extra `Buffer.from` copy per *painted* (non-reused)
frame — acceptable, since it only happens on the expensive path, never on the cheap
hold-frame path.

### Resolution scaling (FR12)

`createRenderer(width, height)` allocates the working canvas at `width × height` (the
**target** render resolution, e.g. 1280×720 for a preview) — not the spec's native
1920×1080. `renderFrame` wraps all paint calls in `ctx.scale(targetWidth / spec.width,
targetHeight / spec.height)` so every `Timeline`-resolved coordinate (computed against the
spec's native 1920×1080) is used unmodified; the transform does the scaling. Raster-cache
bitmaps are rendered at their **logical** (spec-native) size regardless of the current
target resolution, then scaled down by the same transform — one cache, reused across a
`preview` and `final` render of the same timeline, at the cost of the downscale-only
limitation noted in spec.md.

## File Changes Map

| File | Action | Description |
|------|--------|--------------|
| `packages/renderer-canvas/package.json` | create | deps: `@napi-rs/canvas`, `@claudevid/core` (workspace) |
| `packages/renderer-canvas/tsup.config.ts` | create | ESM build |
| `packages/renderer-canvas/vitest.config.ts` | create | test runner, `perf.test.ts` isolated via a separate `describe.skipIf` or CI env flag |
| `packages/renderer-canvas/tsconfig.json` | create | extends root base |
| `packages/renderer-canvas/src/frame-buffer.ts` | create | `FrameBuffer`, pool, raw extraction |
| `packages/renderer-canvas/src/raster-cache.ts` | create | content-hash LRU cache |
| `packages/renderer-canvas/src/fonts.ts` | create | font registration from `@fontsource/*` |
| `packages/renderer-canvas/src/text.ts` | create | measure/wrap/position/raster |
| `packages/renderer-canvas/src/draw-shapes.ts` | create | rect/border/gradient painters |
| `packages/renderer-canvas/src/draw-image.ts` | create | decode cache, fit modes |
| `packages/renderer-canvas/src/stats.ts` | create | `RenderStats` accumulator |
| `packages/renderer-canvas/src/index.ts` | create | `Renderer`, `renderFrame`, hold-frame reuse, group recursion |
| `packages/renderer-canvas/test/*.test.ts` | create | 7 test files per Architecture |

## Data Model Changes

New: `FrameBuffer { width, height, data: Buffer }`, `Renderer` (opaque handle),
`RenderFrameOptions { scale?: number }`, `RenderStats { msPerFrame: number[], p50, p95,
cacheHits, cacheMisses, holdFrames, perLayerTypeMs: Record<string, number> }`.

No changes to `@claudevid/core`'s data model — this package only consumes `Timeline`.

## API Changes

Public exports from `@claudevid/renderer-canvas`:

- `createRenderer(width: number, height: number, opts?: { cacheLimitBytes?: number }): Renderer`
- `Renderer.renderFrame(timeline: Timeline, frame: number, target: FrameBuffer, opts?: { scale?: number }): void`
- `Renderer.stats(): RenderStats`
- `Renderer.dispose(): void`
- `createFrameBuffer(width: number, height: number): FrameBuffer`
- `createFrameBufferPool(width: number, height: number, size: number): { acquire(): FrameBuffer; release(fb: FrameBuffer): void }`

## Key Decisions

1. **RGBA, premultiplied alpha — confirmed empirically, not assumed.** See spike results
   above. AC2 commits the RGBA finding as a regression test; the premultiplied finding is
   documented as a non-issue for extracted frames (always-opaque assumption) rather than
   solved with manual unpremultiply math, since `drawImage` already composites correctly.
2. **One `Renderer` instance = one thread, no shared cache across workers.** Proposal's
   "worker-thread safety" question is explicitly deferred to 005's design (spec.md Notes) —
   solving cross-worker cache sharing now would be speculative, since 005 doesn't exist yet
   and its chunking strategy determines whether sharing is even valuable.
3. **Hold-frame reuse compares layer-key sets, not pixel content.** Cheap (string join +
   compare) and correct for v1 because nothing varies per-frame within an active window yet
   (003 doesn't exist). Explicitly flagged as needing revisiting once motion lands — recorded
   in spec.md Notes so 003's design phase inherits the constraint rather than rediscovering it
   the hard way (a silent stale-frame bug once layers start animating).
4. **Raster cache is not keyed by scale.** A cache built during a `preview` render is reused
   at `final` resolution and vice versa; correctness is preserved because canvas transforms
   compose losslessly for downscaling. Upscaling quality is explicitly out of scope (no v1
   consumer upscales) rather than solved speculatively.
5. **Content-hash keys are field-lists per painter, not `JSON.stringify(layer)`.** Prevents
   two cache entries for visually-identical layers that merely differ in a field that doesn't
   affect pixels (e.g. timing), and prevents accidental collisions from a hash that's too
   coarse. Slightly more code per painter (an explicit key-builder) in exchange for a cache
   that actually reflects "what affects pixels," which is the proposal's own definition of
   the cache boundary.
6. **512 MB default cache ceiling, configurable, not further subdivided.** Matches the
   proposal's own suggested default; per-layer-type sub-limits are not built because no
   proposal or spec requirement calls for them (YAGNI).
7. **`draw-group` is not a separate file.** Group composition is a `ctx.save/translate/
   clip/restore` bracket around recursive painter dispatch in `index.ts` — it is not a
   distinct rendering mechanism the way text/shape/image painters are, so giving it its own
   file would be a hollow abstraction (three lines of orchestration, not a painter).

## Risks & Mitigations

- **Risk: the 10–20ms/frame target is the project's central performance claim and the
  hardest thing to retrofit** (proposal's own framing). *Mitigation:* AC7 is a CI-gated perf
  test from day one, not a bolt-on; the raster-cache design (Key Decision 5) and hold-frame
  reuse (Key Decision 3) are both built into the first version rather than layered on after a
  slow v1 ships.
- **Risk: font licensing / binary-asset drift.** *Mitigation:* fonts ship as the `@fontsource/
  inter` and `@fontsource/jetbrains-mono` npm packages (both re-package the same SIL Open Font
  License families as versioned, license-bundled `.woff2` files) rather than hand-vendored
  binary files in this repo — confirmed empirically that `GlobalFonts.registerFromPath` loads
  `.woff2` directly, so no ttf conversion step is needed. This avoids committing binary font
  assets to git entirely and gets license compliance for free from the upstream package.
- **Risk: perf test flakiness in CI** (shared/throttled CI runners can blow a ms/frame budget
  for reasons unrelated to a real regression). *Mitigation:* AC7 measures p95 over ≥10 frames
  (not a single sample) and the ceiling is set with headroom against the 20ms upper bound of
  the proposal's own target range, not the optimistic 10ms.
