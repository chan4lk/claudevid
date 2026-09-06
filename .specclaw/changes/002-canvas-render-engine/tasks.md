# Tasks: Canvas Render Engine (@napi-rs/canvas) with Raster Caching

**Change:** 002-canvas-render-engine
**Created:** 2026-09-06
**Total Tasks:** 12

## Summary

12 tasks across 4 waves. Wave 1 scaffolds the package and font assets. Wave 2 builds the
independent low-level pieces (frame buffer, raster cache, fonts, stats) in parallel. Wave 3
builds the painters, which all consume the raster cache. Wave 4 wires the `Renderer`
orchestration (hold-frame reuse, scaling, group recursion) and the test suite, including the
CI-gated perf test.

## Tasks

### Wave 1 — Package scaffold + font assets

- [ ] `T1` — `packages/renderer-canvas` package scaffold
  - Files: `packages/renderer-canvas/package.json`, `packages/renderer-canvas/tsup.config.ts`, `packages/renderer-canvas/vitest.config.ts`, `packages/renderer-canvas/tsconfig.json`
  - Estimate: small
  - Kind: config
  - Depends: none
  - Notes: deps `@napi-rs/canvas` (confirmed installable in this environment via spike),
    `@claudevid/core` as a workspace dependency; devDeps mirror `packages/core`.

- [ ] `T2` — Bundle Inter + JetBrains Mono fonts with license files
  - Files: `packages/renderer-canvas/assets/fonts/Inter-Regular.ttf`, `packages/renderer-canvas/assets/fonts/Inter-Bold.ttf`, `packages/renderer-canvas/assets/fonts/JetBrainsMono-Regular.ttf`, `packages/renderer-canvas/assets/fonts/LICENSE-OFL.txt`
  - Estimate: small
  - Kind: config
  - Depends: none
  - Notes: SIL Open Font License — vendor the actual license text in the same commit as the
    font files, not as a follow-up. Source fonts from their official OFL-licensed release
    artifacts (Google Fonts' Inter release, JetBrains' official JetBrains Mono release).

### Wave 2 — Independent low-level pieces (parallel)

- [ ] `T3` — `frame-buffer.ts`: FrameBuffer, pool, raw extraction
  - Files: `packages/renderer-canvas/src/frame-buffer.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T1
  - Notes: `createFrameBuffer(width,height)` allocates `Buffer.allocUnsafe(width*height*4)`;
    `createFrameBufferPool` is a simple free-list (array of buffers + acquire/release), sized
    to the pool's `size` param — no dynamic growth in v1 (YAGNI, change 005 controls pool size
    to match its worker count).

- [ ] `T4` — `raster-cache.ts`: content-hash LRU cache
  - Files: `packages/renderer-canvas/src/raster-cache.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T1
  - Notes: implement exactly the `createRasterCache(limitBytes)` shape from design.md —
    `getOrRender(key, width, height, paint)`, `stats()`, `dispose()`. LRU via re-insertion on
    hit (`Map` iteration order = recency) — no separate doubly-linked-list structure needed at
    this scale.

- [ ] `T5` — `fonts.ts`: bundled font registration + fallback chain
  - Files: `packages/renderer-canvas/src/fonts.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T1, T2
  - Notes: `registerBundledFonts(): void` calls `GlobalFonts.registerFromPath` for each bundled
    file exactly once (guard against double-registration if called twice — `GlobalFonts.has`
    or a module-level boolean flag); exports the documented fallback chain string
    (`"Inter, sans-serif"` / `"JetBrains Mono, monospace"`) for `text.ts` to use as defaults.

- [ ] `T6` — `stats.ts`: RenderStats accumulator
  - Files: `packages/renderer-canvas/src/stats.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T1
  - Notes: `createStatsCollector()` returns `{ recordFrameMs(ms), recordCacheHit(),
    recordCacheMiss(), recordHoldFrame(), recordPaint(), recordLayerTypeMs(type, ms), stats():
    RenderStats }`. `p50`/`p95` computed from the raw `msPerFrame` array on demand in `stats()`
    (sort + index), not maintained incrementally — simplicity over a streaming percentile
    structure that nothing here needs yet.

### Wave 3 — Painters (parallel, all depend on the raster cache)

- [ ] `T7` — `text.ts`: measure/wrap/position/raster + layout cache
  - Files: `packages/renderer-canvas/src/text.ts`
  - Estimate: large
  - Kind: impl
  - Depends: T4, T5
  - Notes: word-wrap via `ctx.measureText` per word against `maxWidth`; multi-line vertical
    centring computes total block height from line count × line height, then offsets the first
    line's baseline so the block is centred on the layer's resolved `y`. Layout result (line
    array + total dimensions) and the rasterized bitmap share one cache entry keyed together
    (FR4/FR5) — measuring is not repeated on a cache hit.

- [ ] `T8` — `draw-shapes.ts`: rect/rounded-rect/border/gradients
  - Files: `packages/renderer-canvas/src/draw-shapes.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T4
  - Notes: rounded corners via `ctx.roundRect` if available in this `@napi-rs/canvas` version,
    else a manual arc-based path (check during implementation, don't assume); linear/radial
    gradients built from the layer's resolved fill definition, cached the same as a solid fill
    (the gradient object itself is deterministic from its inputs, so it's part of the content
    hash, not re-created per cache hit).

- [ ] `T9` — `draw-image.ts`: decode cache + fit modes
  - Files: `packages/renderer-canvas/src/draw-image.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T4
  - Notes: decode via `@napi-rs/canvas`'s `loadImage` (or equivalent), keyed by `src` in a
    decode cache separate from the raster cache (a decoded image is reused across fit-mode
    variants — cover/contain/fill of the *same* source shouldn't decode 3 times); fit-mode math
    computes the source/dest rects for `ctx.drawImage`'s 9-argument form.

### Wave 4 — Orchestration + full test suite

- [ ] `T10` — `index.ts`: Renderer, renderFrame, hold-frame reuse, group recursion, scaling
  - Files: `packages/renderer-canvas/src/index.ts`
  - Estimate: large
  - Kind: impl
  - Depends: T3, T4, T6, T7, T8, T9
  - Notes: implements the `renderFrame` pipeline from design.md exactly — hold-frame check
    first (FR11), then scale transform (FR12), then background paint, then per-active-layer
    dispatch (recursing into `group` per FR9), then the single `Buffer.copy` into `target`
    (FR3), then `stats.record*`. This is the task with the most acceptance criteria riding on
    it (AC1, AC3, AC5, AC6, AC9).

- [ ] `T11` — Unit tests: frame-buffer, raster-cache, text, draw-shapes, draw-image
  - Files: `packages/renderer-canvas/test/frame-buffer.test.ts`, `packages/renderer-canvas/test/raster-cache.test.ts`, `packages/renderer-canvas/test/text.test.ts`, `packages/renderer-canvas/test/draw-shapes.test.ts`, `packages/renderer-canvas/test/draw-image.test.ts`
  - Estimate: large
  - Kind: test
  - Depends: T3, T4, T7, T8, T9
  - Notes: covers AC2 (byte order — the committed regression test for the empirical spike),
    AC4 (cache hit is cheaper / doesn't re-measure), AC8 (word-wrap line count).

- [ ] `T12` — Integration + perf tests: render.test.ts, perf.test.ts
  - Files: `packages/renderer-canvas/test/render.test.ts`, `packages/renderer-canvas/test/perf.test.ts`
  - Estimate: medium
  - Kind: test
  - Depends: T10
  - Notes: `render.test.ts` covers AC1, AC3 (determinism), AC5 (hold-frame), AC6 (scaling),
    AC9 (dispose) using a real `compileTimeline` output from `@claudevid/core` — not hand-built
    `Timeline` fixtures, so this is the first true cross-package integration test in the repo.
    `perf.test.ts` covers AC7 (p95 < 20ms/frame over ≥10 frames on a representative scene) and
    AC10 (build + test succeed from a clean checkout — run both as this task's final step).

---

## Legend

- `[ ]` Pending
- `[~]` In Progress
- `[x]` Complete
- `[!]` Failed
