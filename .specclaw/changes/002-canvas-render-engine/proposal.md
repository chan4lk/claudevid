# Proposal: Canvas Render Engine (@napi-rs/canvas) with Raster Caching

**Created:** 2026-09-06
**Status:** 🟡 Draft

**Depends on:** 001-videospec-core (`Timeline`, resolved layers, easing).

## Problem

Frame generation — not encoding — is the bottleneck for this library. The requirement doc
does the arithmetic and lands on a hard target:

```
target: 10ms to 20ms per frame at 1080p
30-min 1080p30 = 54,000 frames
@ 50ms/frame → 45 minutes    @ 20ms/frame → 18 minutes    @ 10ms/frame → 9 minutes
```

The reference implementation in the doc cannot hit that, for three reasons it names but does
not solve:

1. **`ctx.getImageData()` per frame is the documented slow path.** It allocates a fresh
   `Uint8ClampedArray` of 8.3 MB every frame and forces a full readback. At 30fps that is
   ~249 MB/s of garbage, and the GC pauses alone will blow the 20ms budget.
2. **Text is re-laid-out every frame.** `ctx.fillText` with a font string re-runs font
   matching, shaping and measurement on every single frame, for a title that has not changed
   in 90 frames. The doc identifies this ("avoid per-frame text layout") without building the
   mechanism that avoids it.
3. **There is no cache, so cost scales with content, not with change.** A frame containing a
   static diagram, a static code block and one animating title costs the same as a frame where
   everything moves.

Without a render engine designed around caching from the start, every subsequent change —
motion (003), code blocks (004), captions (006) — makes renders *linearly slower*, and the
project's entire value proposition ("faster than the browser/screenshot path") evaporates.

## Proposed Solution

Build `@claudevid/renderer-canvas` on **@napi-rs/canvas**, chosen for its speed, small install
footprint and direct raw-buffer access on Apple Silicon. The engine is immediate-mode over a
cached scene graph.

**1. The one function that matters.**

```ts
renderFrame(timeline: Timeline, frame: number, target: FrameBuffer): void
```

It writes into a **caller-owned, reused** RGBA buffer. No allocation per frame. Change 005
owns a small pool of these and hands them to the encoder pipe, so the steady-state allocation
rate of the render loop is approximately zero.

**2. Escape `getImageData`.** Read pixels via `@napi-rs/canvas`'s raw path
(`canvas.data()` / `toBuffer('raw')`), which exposes the backing store rather than copying it
into a fresh typed array. Byte order and premultiplication are verified against FFmpeg's
`-pix_fmt` in a round-trip test (a solid known colour in → the same colour out of a 1-frame
encode) — getting this wrong produces a video with swapped red and blue channels that looks
plausible enough to ship, which is exactly the bug worth a test.

**3. The raster cache — the core mechanism.**
Every layer that is *visually static* is rendered once to an offscreen canvas, keyed by a
content hash of everything that affects its pixels (text, font, size, weight, colour, wrap
width, theme). Per frame, painting that layer collapses to:

```
drawImage(cachedBitmap, x, y) + globalAlpha + transform
```

which is a blit, not a layout. This is what turns 50ms/frame into 10ms/frame, and it is the
single reason to build this change separately from 003 — **the cache boundary determines what
the motion system is allowed to animate cheaply.** Properties that only require a transform or
alpha (position, scale, rotation, opacity) are free; properties that change the raster
(text content, font size, colour) invalidate and are budgeted explicitly.

**4. Text layout pipeline.** Measure → wrap → position → raster → cache. Word wrap with
`maxWidth`, line height, letter spacing, alignment, and multi-line vertical centring.
Fonts are registered explicitly via `GlobalFonts` from a bundled set (Inter + JetBrains Mono)
with a documented fallback chain, so a render on a colleague's Mac produces the same pixels as
a render on CI — system-font resolution is not reproducible and must not be relied on.

**5. Layer painters shipped here.** `text`, `rect` (incl. rounded corners, borders, linear and
radial gradients), `image` (with fit modes: cover/contain/fill, and a decoded-image cache),
and `group` (transform composition, clipping). Effects the doc flags as expensive — shadow,
blur, glassmorphism — are supported *only* through the pre-render-once path, never as
per-frame `ctx.filter`.

**6. Scene culling and dirty-rect skipping.** Only layers active at `frame` are painted.
If no layer's cache key or transform changed between frame N and N+1, the previous buffer is
reused wholesale — which makes hold frames (very common in explainer videos) nearly free.

**7. Resolution scaling for previews.** The same `Timeline` renders at a scale factor, so
`preview` at 1280×720 (change 007) is the identical composition at 0.667×, not a second code
path that can drift from the final render.

**8. `RenderStats` instrumentation.** ms/frame (p50/p95), cache hit rate, allocation count,
per-layer-type cost. Without this the 10–20ms target is an assertion; with it, it is a
measurement, and change 005's benchmark harness has something real to report.

## Scope

### In Scope

- `packages/renderer-canvas/src/index.ts` — `Renderer`, `renderFrame`, lifecycle, disposal
- `packages/renderer-canvas/src/frame-buffer.ts` — buffer pool, raw-pixel extraction, byte-order test
- `packages/renderer-canvas/src/raster-cache.ts` — content-hash keying, LRU eviction, memory ceiling
- `packages/renderer-canvas/src/text.ts` — measurement, wrapping, layout cache, glyph raster cache
- `packages/renderer-canvas/src/draw-shapes.ts` — rect, rounded rect, border, gradients, arrows/lines
- `packages/renderer-canvas/src/draw-image.ts` — decode cache, fit modes
- `packages/renderer-canvas/src/fonts.ts` — bundled font registration + fallback chain
- `packages/renderer-canvas/src/stats.ts` — instrumentation
- Determinism test: same spec → byte-identical frame hashes across runs
- Perf test: a representative 1080p scene asserted under a ms/frame ceiling in CI

### Out of Scope

- **A pluggable `Surface` port for skia-canvas / WebGL / PixiJS.** Explicitly rejected —
  @napi-rs/canvas is the committed backend for v1 (see Open Questions for the exit path).
- Animation interpolation, easing application, transitions — change 003
- Syntax highlighting and code-block rendering — change 004
- Caption rendering — change 006
- FFmpeg, worker threads, parallel chunk rendering — change 005
- Charts, data-driven diagrams, SVG import

## Impact

- **Files affected:** ~22 new
- **Complexity:** large
- **Risk:** medium-high — this change owns the project's central performance claim. The cache
  design is also the hardest thing to retrofit; a naive first version would have to be
  rewritten rather than optimized.

## Open Questions

- **Bundled fonts vs system fonts.** Bundling Inter + JetBrains Mono costs ~2–4 MB of package
  size but buys reproducible output. **Recommendation: bundle**, with an escape hatch to
  register additional families from the project config in 007.
- **Raw buffer byte order.** @napi-rs/canvas raw output must be confirmed as RGBA vs BGRA and
  premultiplied vs straight alpha, and matched to FFmpeg's `-pix_fmt`. This needs an empirical
  check on an M3 in the design phase, not an assumption.
- **Raster cache memory ceiling.** A 200-scene video with cached code blocks could hold
  hundreds of MB of bitmaps. LRU with a configurable ceiling (default? 512 MB?) — and what
  happens on eviction thrash during a parallel render in 005, where N workers each hold a cache.
- **Worker-thread safety.** Change 005 wants N renderers in parallel. Is a `Renderer` instance
  cheap enough to construct per worker, and can the raster cache be shared (via a serialized
  bitmap store) or must each worker warm its own? This materially affects 005's speedup.
- **Exit path from @napi-rs/canvas.** We are committing to it, not abstracting it. If a future
  need (GPU effects, advanced typography) forces skia-canvas, what is the realistic migration
  cost, and should painters at least avoid backend-specific APIs where it is free to do so?

---

**To proceed:** Review this proposal and approve to begin planning.
