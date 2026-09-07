# Tasks: Animated Code Block Layer — Shiki, Compile-Time Tokenized, Line-Cached

**Change:** 004-code-block-layer
**Created:** 2026-09-07
**Total Tasks:** 15

## Summary

15 tasks across 5 waves. Wave 1 scaffolds the new `@claudevid/layer-code` package and its
schema/registry wiring (the only thing other packages need to know exists). Wave 2 builds the
compile-time tokenize/layout/diagnostics pipeline (no rendering, no canvas). Wave 3 builds the
render path — per-line cache, chrome, and the small additive `renderer-canvas` painter registry
that makes a `code` layer actually paintable. Wave 4 builds the animation/diff/annotate
primitives and wires them into the paint path. Wave 5 is tests plus the full-workspace
regression check. Per design.md's NFR6, waves 1-4 touch zero files in `packages/core` or
`packages/motion` — the only cross-package edit anywhere in this change is the two small,
additive `renderer-canvas` files in Wave 3.

## Tasks

### Wave 1 — Package scaffolding + schema/registry

- [x] `T1` — Package scaffolding + `schema.ts`
  - Files: `packages/layer-code/package.json`, `tsup.config.ts`, `vitest.config.ts`,
    `tsconfig.json`, `src/schema.ts`, `src/index.ts` (stub re-exporting `schema.ts` only)
  - Estimate: medium
  - Kind: config
  - Notes: Mirror `packages/motion`'s package.json/tsup/vitest shape exactly (design.md
    Architecture). Dependencies: `@claudevid/core`, `@claudevid/renderer-canvas`,
    `@claudevid/motion` (all workspace), `shiki` (fine-grained: `shiki/core` +
    `shiki/engine/javascript`, per spec.md FR2 — do not add the full `shiki` package).
    `codeLayerSchema` per design.md's `schema.ts` section (all sub-schemas: `reveal`, `focus`,
    `diff`, `scroll`, `annotations`); calls `registerLayer("code", codeLayerSchema)` at module
    load (spec.md FR1). `width`/`height` required per spec.md FR1's grounding (matches `rect`,
    not `image`).

- [x] `T2` — `themes.ts`: bundled theme data + `checkThemeContrast`
  - Files: `packages/layer-code/src/themes.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T1
  - Notes: `BUNDLED_THEMES = ["github-dark","github-light","high-contrast"]` (spec.md FR2).
    `checkThemeContrast(theme)` computes WCAG relative-luminance contrast ratio between each
    theme's token colours and its background (spec.md FR15) — pure numeric function, no canvas.

### Wave 2 — Compile-time tokenize + layout + diagnostics (no rendering)

- [x] `T3` — `highlight.ts`: Shiki singleton + `compileCodeLayers`
  - Files: `packages/layer-code/src/highlight.ts`
  - Estimate: large
  - Kind: impl
  - Depends: T1, T2
  - Notes: `createHighlighterCore` lazily instantiated once (module-level singleton), bundled
    with exactly the 8 langs / 3 themes named in spec.md FR2 — static imports, no dynamic
    `import()`/network fetch (NFR5). `compileCodeLayers(spec, timeline)` per design.md's
    Technical Approach diagram: dedupes tokenization by `(code, lang, theme)` hash (FR3/AC2),
    emits `TokenizedCode` per spec.md FR4 exactly (`{ lines: { tokens: { text, color, fontStyle
    }[] }[] }` — no Shiki types in the return value, AC1's JSON round-trip must pass). Unknown
    `lang`/`theme` → diagnostic via `diagnostics.ts` (T5), never thrown (AC3).

- [x] `T4` — `layout.ts`: fast-path measurement, wrap, fit-to-width
  - Files: `packages/layer-code/src/layout.ts`
  - Estimate: large
  - Kind: impl
  - Depends: T1
  - Notes: `measureLine(charCount, fontSizePx)` — advance-width × count, cached per fontSize,
    never per-token `measureText` (spec.md FR5, AC4's linearity claim). Tab expansion (shared
    logic `render.ts` must call identically — export it from here, don't duplicate in T7).
    `wrap: "soft"` continuation-indent wrapping. Auto-fit retry loop (fontSize down to floor
    `12`, spec.md FR6). `computeAvailableLines(height, fontSize, showLineNumbers)`. Returns a
    `LayoutResult` carrying per-line `y` offsets (the one source of truth `annotate.ts`/
    `render.ts` both read — design.md's `annotationPosition` grounding).

- [x] `T5` — `diagnostics.ts`: all `Diagnostic` construction
  - Files: `packages/layer-code/src/diagnostics.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T3, T4
  - Notes: Reuses `@claudevid/core`'s `Diagnostic` type directly (spec.md FR13 — no local
    redefinition). Cases: unsupported lang (lists 8 bundled langs, AC3), unsupported theme
    (lists 3), line-overflow (names actual vs. available line count + 3-fix suggestion, AC5),
    line-too-long-to-fit, out-of-range `focus.lines`/`scroll.toLine`/`annotations[].line`
    (Edge Cases). Marks the compiled entry `blocked: true` on overflow/too-long (feeds T7's
    `CodeOverflowError`, FR7).

### Wave 3 — Render path + renderer-canvas wiring

- [x] `T6` — `renderer-canvas`: `painters.ts` registry + `index.ts` wiring
  - Files: `packages/renderer-canvas/src/painters.ts` (create), `packages/renderer-canvas/src/index.ts` (modify)
  - Estimate: small
  - Kind: impl
  - Notes: `registerPainter(type, paint)` / `getPainter(type)`, per design.md Key Decision D3 —
    mirrors `core.layers.ts`'s `registerLayer` shape one layer up. `index.ts`'s existing
    per-layer `switch`'s `default: continue` (currently `index.ts:154-158`) gains exactly one
    branch: consult `getPainter(layer.layer.type)` before falling through to `continue`. No
    existing exported function's signature changes (this task can run in parallel with T1-T5 —
    it only touches already-existing `renderer-canvas` code).

- [x] `T7` — `render.ts`: per-line cache, chrome cache, `paintCodeLayer`
  - Files: `packages/layer-code/src/render.ts`
  - Estimate: large
  - Kind: impl
  - Depends: T4, T5, T6
  - Notes: Per design.md's "Per-line cache key scheme" and `paintCodeLayer` sections. A
    package-private `createLineCache` (reuses `renderer-canvas`'s exported `createRasterCache`
    factory, own byte budget — design.md Key Decision D1, do not share `renderer-canvas`'s
    shared cache instance). Chrome pre-rendered once per `(width,height,theme,title,
    showLineNumbers)` key, blitted every frame, never re-rasterized (spec.md FR8). Throws
    `CodeOverflowError` for any `blocked: true` entry before painting anything (spec.md FR7 —
    the second, render-time guardrail). Ligatures disabled by construction: paint each
    character at its own measured advance width, never one `fillText` call over a multi-char
    span (spec.md FR9). This task does **not** yet wire in `animations.ts`/`diff.ts`/
    `annotate.ts` (T11 does) — for now, paints a fully-revealed, non-focused, non-diffed static
    block correctly (enables T13's cache tests early).

### Wave 4 — Animations, diff, annotate

- [ ] `T8` — `diff.ts`: pure LCS line diff
  - Files: `packages/layer-code/src/diff.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T1
  - Notes: `diffLines(before, after): DiffLine[]` per spec.md FR11 — deterministic, no
    third-party diff library. `{before, after}` pair is v1's only supported diff input (spec.md
    Open Question #2's resolution) — no unified-diff-string parsing in this task.

- [ ] `T9` — `animations.ts`: typewriter / line-stagger / focus / scroll, all pure
  - Files: `packages/layer-code/src/animations.ts`
  - Estimate: large
  - Kind: impl
  - Depends: T1
  - Notes: Per spec.md FR10 exactly — `typewriterState`, `lineStaggerDelays` (delegates to
    `@claudevid/motion`'s exported `orderIndices`, does not reimplement the FNV-1a ordering),
    `focusState`, `scrollOffsetPx` (both reuse `@claudevid/motion`'s exported `resolveEasing`
    directly). All four functions: plain numeric/array in, plain data out — zero canvas, zero
    Shiki (design.md Key Decision D2 — no `Track`/`PropertyBag`/`Channel` involvement at all).

- [ ] `T10` — `annotate.ts`: line-anchored callout positioning
  - Files: `packages/layer-code/src/annotate.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T4
  - Notes: `annotationPosition(annotation, layout)` reads the target line's `y` from `layout
    .ts`'s own per-line offset table (spec.md FR12 — one source of truth, no re-derived
    arithmetic). Out-of-range `annotations[].line` is T5's job (diagnostic), not this task's.

- [ ] `T11` — Wire `animations.ts`/`diff.ts`/`annotate.ts` into `paintCodeLayer`
  - Files: `packages/layer-code/src/render.ts` (extend), `packages/layer-code/src/index.ts`
    (finalize exports + `registerPainter("code", paintCodeLayer)` side effect)
  - Estimate: large
  - Kind: impl
  - Depends: T7, T8, T9, T10
  - Notes: `frameLocal = frame - layer.startFrame` drives `typewriterState`/`focusState`/
    `scrollOffsetPx` each frame (spec.md FR10); dimmed lines get a separate cache key
    (`dimmed` component, spec.md FR8) painted via the alpha-blend from design.md Key Decision
    D6 (`ctx.globalAlpha`, not a pre-blended colour — no OKLCH, per spec.md's resolved Open
    Question #5). Diff added/removed backgrounds fade in per `diff.duration`/`revealDelay`.
    Annotations drawn directly (uncached — small count, spec.md FR8's "never cached" note).
    `index.ts`'s final public export list + both side-effecting registration calls
    (`registerLayer` from T1, `registerPainter` here) land in this task.

### Wave 5 — Tests + full-workspace regression

- [ ] `T12` — Compile-time pipeline tests (highlight/layout/diagnostics)
  - Files: `packages/layer-code/test/schema.test.ts`, `highlight.test.ts`, `layout.test.ts`,
    `diagnostics.test.ts`, `themes.test.ts`, `no-shiki-outside-highlight.test.ts`
  - Estimate: large
  - Kind: test
  - Depends: T3, T4, T5, T2
  - Notes: Covers AC1, AC2, AC3, AC4, AC5, AC6, AC12, plus the Edge Cases (out-of-range focus/
    scroll/annotation lines, tab expansion, `diff.before === code`, `maxLines` overriding
    height-derived availability). `no-shiki-outside-highlight.test.ts` greps
    `packages/layer-code/src/{render,animations,diff,annotate}.ts` for any `shiki`/`highlight.js`
    import and fails the test if found (spec.md NFR2 — a hard constraint, mirrors `003`'s own
    NFR1 canvas-import grep for `packages/motion/test/`).

- [ ] `T13` — Render/cache tests
  - Files: `packages/layer-code/test/render-cache.test.ts`, `diff.test.ts`, `focus.test.ts`,
    `annotate.test.ts`
  - Estimate: large
  - Kind: test
  - Depends: T11
  - Notes: Covers AC7 (static block, 100% hit rate after first frame), AC8 (typewriter,
    `(N-1)/N` hit-rate claim — the headline NFR3 assertion, measured against the line cache's
    own `hits`/`misses` counters, no image comparison), AC9 (diff golden fixture), AC10 (focus
    dim, raw-pixel luminance comparison, not a snapshot image), AC11 (annotation position vs.
    `layout.ts`'s own offsets).

- [ ] `T14` — End-to-end integration test + `renderer-canvas` painter-registry test
  - Files: `packages/layer-code/test/integration.test.ts`,
    `packages/renderer-canvas/test/painters.test.ts`
  - Estimate: medium
  - Kind: test
  - Depends: T6, T11
  - Notes: AC14 — `parseSpec` → `compileTimeline` → `compileCodeLayers` →
    `createRenderer().renderFrame` (with `@claudevid/layer-code` imported so its registration
    side effects have run) produces a non-empty pixel buffer with zero diagnostics, for a small
    non-overflowing spec. `painters.test.ts` (design.md Key Decision D3): registry get/set
    round-trip, and an unregistered type still falls through to `continue` with no error
    (regression safety for `002`/`003`'s existing dispatch behavior).

- [ ] `T15` — Workspace-wide build/test/lint pass
  - Files: none (verification task)
  - Estimate: small
  - Kind: test
  - Depends: T12, T13, T14
  - Notes: `pnpm --filter @claudevid/layer-code build`/`test` standalone, then
    `pnpm -r run build && pnpm -r run test && pnpm -r run lint` for the whole workspace, all
    green from a clean checkout (AC13) — confirms `001`/`002`/`003`'s existing suites are
    unaffected (NFR6) and every AC in spec.md is covered by a task above; reconcile before
    marking this change built.

---

## Legend

- `[ ]` Pending
- `[~]` In Progress
- `[x]` Complete
- `[!]` Failed

**Task format:**
```
- [ ] `T<n>` — <title>
  - Files: <files to create/modify>
  - Estimate: small | medium | large
  - Kind: docs | test | config | refactor | impl | migration   (optional; hints the build subagent's role, tools, and model)
  - Depends: <task ids> (if any)
  - Notes: <additional context>
```
