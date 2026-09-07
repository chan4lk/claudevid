# Spec: Canvas Render Engine (@napi-rs/canvas) with Raster Caching

**Change:** 002-canvas-render-engine
**Created:** 2026-09-06
**Status:** 🟡 Draft

## Overview

`@claudevid/renderer-canvas` paints a `Timeline` (from `@claudevid/core`) into caller-owned
RGBA frame buffers on `@napi-rs/canvas`, hitting a 10–20ms/frame budget at 1080p through a
content-hashed raster cache — every visually static layer is painted once to an offscreen
canvas and blitted thereafter, not re-laid-out per frame.

Two facts were empirically verified against the actual `@napi-rs/canvas` build available in
this environment (documented in design.md, not assumed):
- `canvas.data()` returns **RGBA**, matching FFmpeg's `-pix_fmt rgba`.
- Pixels are **premultiplied alpha** — verified with a 50%-alpha fill (`rgba(255,0,0,0.5)`
  reads back as `[127,0,0,127]`, not `[255,0,0,127]`).

## Requirements

### Functional Requirements

- **FR1 — `renderFrame(timeline, frame, target, opts?)`.** The one function that matters.
  Paints all `Timeline.activeAt(frame)` layers into a caller-owned `FrameBuffer` (`{ width,
  height, data: Buffer }`, RGBA, `width * height * 4` bytes). No allocation on the steady-state
  path: the `Renderer` instance owns one internal working canvas, reused across calls; only a
  raster-cache miss allocates (a new offscreen canvas for that one layer, cached thereafter).
- **FR2 — `Renderer` lifecycle.** `createRenderer(width, height): Renderer` with `.dispose()`
  releasing the raster cache and working canvas. One `Renderer` is not shared across concurrent
  `renderFrame` calls (single-threaded use per instance — change 005's parallelism is one
  `Renderer` per worker, not one shared across workers).
- **FR3 — Raw pixel extraction, no `getImageData`.** `frame-buffer.ts` copies the working
  canvas's backing store (`canvas.data()`) into the caller's `FrameBuffer.data` via a single
  `Buffer.copy`/`.set()` — never `ctx.getImageData()`, which allocates a fresh typed array
  every call.
- **FR4 — Raster cache.** `raster-cache.ts` keys an offscreen bitmap by a content hash of
  everything that affects its pixels (for `text`: text/font/size/weight/color/wrap width;
  for `rect`: fill/stroke/radius/dimensions; for `image`: decoded source + fit mode +
  dimensions). Cache is an LRU with a configurable byte ceiling (default 512 MB per
  Open Question); eviction drops the least-recently-painted entry. A cache hit is
  `ctx.drawImage(cachedBitmap, x, y)` plus `globalAlpha`/transform — no re-layout.
- **FR5 — Text layout pipeline.** `text.ts`: measure → word-wrap (`maxWidth`) → position
  (line height, multi-line vertical centring, alignment) → raster → cache. Layout is computed
  once per unique `(text, font, size, weight, wrapWidth)` tuple and cached alongside the
  rasterized bitmap — a hold frame re-measures nothing.
- **FR6 — Bundled fonts.** `fonts.ts` registers Inter + JetBrains Mono via
  `GlobalFonts.registerFromPath` at renderer construction, with a documented fallback chain.
  System-font resolution is never relied on for the bundled families, so output is
  reproducible across machines.
- **FR7 — Shape painters.** `draw-shapes.ts`: rect (incl. rounded corners via a single radius),
  solid fill, border (color + width). Goes through the raster-cache path in FR4. **Gradients
  are not in v1**: core's `RectLayer.fill` (change 001) is a plain `z.string().optional()` with
  no structured `{type, stops}` shape, so there is nothing for a gradient painter to consume
  without inventing an ad-hoc string mini-language — deferred to a real schema change if a
  future proposal needs it, not solved here with a guessed encoding. Likewise, "arrows/lines"
  from the original proposal text are dropped: core's `Layer` union has no `line`/`arrow` type.
- **FR8 — Image painter.** `draw-image.ts`: decode once (keyed by `src`), cache the decoded
  bitmap, then paint per fit mode (`cover`/`contain`/`fill`) against the layer's resolved box.
- **FR9 — Group composition.** Verified during implementation: core's `compileTimeline`
  (`flattenLayers`) already recurses into `group.children` and flattens each child into its
  own independent `TimelineLayer` with absolute resolved coordinates — `Timeline.activeAt`
  hands the renderer a flat list where group children are indistinguishable from top-level
  layers. `index.ts` therefore needs **no group-specific code at all**: its layer-type switch
  has a `default: continue` that silently skips the group's own entry (`type: "group"`), and
  children are already dispatched to their real painter. There is no `ctx.translate`/clip
  bracket and no recursion in this package — that was the pre-implementation design guess in
  an earlier revision of this file, superseded once `flattenLayers` was actually read. Note:
  this also means a group's own `x`/`y` currently has no effect on its children's position
  (tracked as a known limitation in `GOALS.md`'s 003 section, not solved here).
- **FR10 — Scene culling.** `renderFrame` paints exactly `timeline.activeAt(frame)` — core
  already computes this; the renderer does not re-derive active-layer membership.
- **FR11 — Hold-frame reuse.** If `timeline.activeAt(frame)` is the identical set of
  `layerKey`s as the previous call's `activeAt(frame - 1)` (v1 has no per-frame-varying
  position/style — that is change 003's job — so an identical layer-key set means an
  identical frame), `renderFrame` copies the previous output into `target` without repainting.
- **FR12 — Resolution scaling.** `opts?.scale` (default `1`) renders the identical composition
  at `width * scale` × `height * scale` via a single `ctx.scale(scale, scale)` wrapping all
  paint calls — not a second code path. Raster-cache entries are **not** keyed by scale (a
  cache built at `scale: 1` is reused, then downscaled by the canvas transform); acceptable
  because v1's only scale use case (change 007's `preview`) always scales *down*.
- **FR13 — `RenderStats`.** `stats.ts` accumulates, per `renderFrame` call and cumulatively:
  `msPerFrame` (raw samples, with `p50`/`p95` computed on demand), `cacheHits`/`cacheMisses`,
  and per-layer-type paint time. Exposed via `renderer.stats()`.

### Non-Functional Requirements

- **NFR1 — No `@claudevid/core` re-implementation.** The renderer consumes `Timeline` exactly
  as compiled by 001; it does not re-derive frame windows, coordinate resolution, or scene
  boundaries.
- **NFR2 — Byte-order correctness.** A round-trip test (known solid color in → same color out
  through a 1-frame FFmpeg encode, or at minimum a direct raw-buffer assertion) guards against
  a silent R/B channel swap, which produces a plausible-looking but wrong video.
- **NFR3 — Zero steady-state allocation.** After the raster cache is warm, a `renderFrame`
  call for an all-cache-hit frame allocates no new canvas, no new typed array beyond the one
  `Buffer.copy` into the caller's `target`.
- **NFR4 — Determinism.** Two `renderFrame` calls for the same `(timeline, frame)` produce
  byte-identical `FrameBuffer.data`.
- **NFR5 — Reproducible fonts.** Bundled-family text renders identically regardless of what
  fonts are installed on the host OS.

## Acceptance Criteria

- **AC1:** `renderFrame` for a scene with one static text layer produces a `FrameBuffer` whose
  pixel data matches a hand-computed expectation for that text's bounding box (non-background
  pixels present where the glyphs should be).
- **AC2:** A round-trip test — fill a canvas with pure red (`#ff0000`), extract via
  `canvas.data()` — asserts byte order `[255, 0, 0, 255]` at the first pixel (RGBA, matching
  FFmpeg's `rgba` `-pix_fmt`), proving NFR2's empirical byte-order finding holds in this repo's
  actual dependency-locked `@napi-rs/canvas` version, not just in the design-time spike.
- **AC3:** Rendering the same `(timeline, frame)` twice produces byte-identical `FrameBuffer`
  data (NFR4) — a determinism test comparing two independent `renderFrame` calls.
- **AC4:** A raster-cache hit is measurably cheaper than a miss: rendering the same static
  text layer at frame N and frame N+1 records a cache hit on the second call
  (`renderer.stats().cacheHits === 1` after two calls of an unchanging layer), and painting a
  bitmap on hit does not re-invoke the text-measurement path (assert via a spy/counter on the
  measure function, or by asserting `layoutCacheSize` stays at 1 across both calls).
- **AC5:** Hold-frame reuse: two consecutive frames with an identical `activeAt` layer-key set
  produce `FrameBuffer.data` that is `Buffer`-equal, and the second call is recorded as a
  hold-frame reuse in `RenderStats` (not counted as a fresh paint).
- **AC6:** Resolution scaling: `renderFrame(timeline, frame, target720p, { scale: 720/1080 })`
  produces a frame whose non-background pixel bounding box is proportionally scaled relative
  to the `scale: 1` render of the same frame (same composition, different resolution).
- **AC7:** A representative 1080p scene (title text + a rect + an image layer, all static)
  renders in under 20ms/frame on a warm cache, measured over at least 10 consecutive frames
  and asserted via `RenderStats.msPerFrame` p95 — the change's central performance claim,
  checked in CI.
- **AC8:** Word-wrap correctness: a text layer with `maxWidth` narrower than its content wraps
  onto multiple lines, and the rendered bitmap's height reflects the wrapped line count (not a
  single-line render clipped or overflowing).
- **AC9:** `Renderer.dispose()` releases the raster cache (a subsequent `renderer.stats()` call
  after dispose reports `cacheHits: 0, cacheMisses: 0` — a fresh state — or throws if the
  renderer is used after dispose; pick one and test it).
- **AC10:** `pnpm --filter @claudevid/renderer-canvas build` and `... test` both succeed from
  a clean checkout.

## Edge Cases

- A layer with zero active frames in a given `Timeline` (e.g. a scene that turned out
  zero-length per 001's edge cases) — `renderFrame` must never be asked to paint it, since
  `activeAt` already excludes it; no special-case needed here, just verified by an integration
  test using a real `compileTimeline` output.
- A raster-cache key collision across two visually-different layers must not occur — content
  hash must include every field that affects pixels (guarded by FR4's explicit field list per
  layer type, tested per painter).
- `scale` values other than the `preview` use case (e.g. `scale > 1`, upscaling) are not
  quality-tested in v1 — documented limitation (Notes), since v1 has no consumer that upscales.
- A `background` color string that is not fully opaque (e.g. `"rgba(0,0,0,0)"`) breaks the
  premultiplied-alpha assumption at frame extraction — documented limitation (Notes), not
  solved here; v1 assumes the composited frame is always opaque.

## Dependencies

- **Runtime:** `@napi-rs/canvas`.
- **Depends on:** 001-videospec-core (`Timeline`, `TimelineLayer`, resolved coordinates,
  `Coordinate`/`Layer` types).
- **Depended on by:** 003 (motion — paints via the same painters, evaluates tracks before
  calling `renderFrame`), 004 (code layer — its own painter, same raster-cache mechanism),
  005 (encoder — owns the `FrameBuffer` pool and calls `renderFrame` per chunk frame), 006
  (captions — its own painter).

## Notes

- The two empirically-verified facts (RGBA order, premultiplied alpha) came from a live spike
  against the actual `@napi-rs/canvas` version this repo installs — see design.md's Key
  Decisions for the exact bytes observed. AC2 turns that spike into a committed regression
  test so a future `@napi-rs/canvas` upgrade that silently changes byte order is caught here.
- Premultiplied alpha is a non-issue for the **final** extracted frame because v1 assumes the
  composited frame is always fully opaque (spec/scene background is always an opaque color);
  it only matters for intermediate raster-cache bitmaps, and those are composited back onto
  the working canvas through the canvas API's own compositor (`drawImage`), which handles
  premultiplication correctly without any manual math in this package.
- Worker-thread safety (proposal's open question) is deferred to change 005's design: this
  change specifies that a `Renderer` is single-instance/single-thread-at-a-time (FR2); 005
  decides whether N workers each construct their own `Renderer` (simple, no cross-worker
  cache sharing) or something more elaborate. Not solved here — YAGNI until 005 needs it.
- Raster-cache memory ceiling defaults to 512 MB (proposal's suggested default) — configurable
  via `createRenderer(width, height, { cacheLimitBytes })`. Not exposed further (e.g. per
  layer-type limits) in v1 — no proposal calls for it.
- Hold-frame reuse (FR11) is a v1-only mechanism: it works because nothing in this change or
  001 varies a layer's position/style per frame within its active window. Change 003 (motion)
  will need to either bypass hold-frame detection for animated layers or extend the dirty-check
  to include evaluated track values — flagged here as a forward-compatibility note for 003's
  design phase, not solved in this change.
