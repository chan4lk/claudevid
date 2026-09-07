# Spec: Animated Code Block Layer — Shiki, Compile-Time Tokenized, Line-Cached

**Change:** 004-code-block-layer
**Created:** 2026-09-07
**Status:** 🟡 Draft

## Overview

`@claudevid/layer-code` registers a `code` layer into `@claudevid/core`'s layer union
(`packages/core/src/layers.ts:118`'s `registerLayer(type, schema)` hook, the extension point
explicitly reserved for this change — see `GOALS.md`'s note "used by 004 (`code`) and 006
(`captions`)"). It renders syntax-highlighted source inside a chrome-boxed window with
typewriter, line-reveal, focus/dim, diff, scroll and annotation animations, at a per-frame cost
that does not scale with file length.

The problem this closes: Shiki tokenizing a 40-line file per frame is tens of milliseconds — the
entire per-frame budget `002-canvas-render-engine` established — and a naive block-level
`Map<string, RenderedCodeBlock>` cache (the requirement doc's own suggestion) has a 0% hit rate
during exactly the case people want most, a typewriter reveal, because the block's content
string changes every frame. This change fixes both halves: **tokenize once, at compile time**
(never inside the render loop), and **cache per LINE, not per block**, so a typewriter mutates
one cache entry per frame instead of invalidating all of them.

It also closes a correctness gap `002`/`003` don't have a mechanism for: code is the one layer
type where the *content itself*, not just its animation, is something Claude can get wrong by
generating too much of it. A 60-line file at a readable font size does not fit in a 1080p code
window. This change's `diagnostics.ts` makes an overflowing block a **blocking** compile-time
diagnostic (`Diagnostic { path, message, suggestion }`, reusing `parseSpec`'s existing
`ok: false` disposition — `packages/core/src/diagnostics.ts:11`) rather than a silently clipped
or wall-of-text frame.

### Grounding for the "why now" of the design choices below

- Tokenization must be async-capable (Shiki's `createHighlighterCore` loads engine/theme/lang
  data), but nothing downstream of it may hold a live highlighter instance — `GOALS.md`'s 004
  section states this in one line: change 005 ships timelines across `worker_threads`
  boundaries, and a Shiki highlighter is not structured-cloneable.
- `packages/motion/src/track.ts` and `packages/motion/src/properties.ts` (the `Channel` union
  and `PropertyBag`) are a **closed, sealed set** — `Channel = "opacity"|"x"|"y"|"scaleX"|
  "scaleY"|"rotation"` (`packages/motion/src/properties.ts`), verify-PASSed in change 003
  (`003: verify PASS — 12/12 ACs, 113 tests`, this repo's own commit log). `GOALS.md`'s
  forward-compatibility note in 003's spec.md floated extending this union for 004's reveal
  channel; this spec explicitly does **not** do that (see Key Decision in design.md) — code's
  internal animation state is computed as a pure function of frame directly inside
  `@claudevid/layer-code`, reusing only the two channel-agnostic utilities `@claudevid/motion`
  already exports publicly (`resolveEasing`, `orderIndices` — both in
  `packages/motion/src/index.ts`). Zero files in `packages/core`, `packages/motion`, or their
  test suites are touched by this change except one additive, backward-compatible extension
  point added to `@claudevid/renderer-canvas` (see design.md's painter-registry decision) — this
  keeps three already-verified packages untouched.
- `packages/renderer-canvas/src/raster-cache.ts` — `createRasterCache(limitBytes)`'s
  content-hash-keyed, insertion-order LRU (`entries.delete(key); entries.set(key, existing)` to
  bump recency, evict-oldest-while-over-budget) is the exact shape this change's per-line cache
  reuses, at a *finer* granularity (one entry per rendered line, not per block).

## Requirements

### Functional Requirements

- **FR1 — `code` layer schema.** `packages/layer-code/src/schema.ts` defines `codeLayerSchema`
  (Zod) and registers it via `registerLayer("code", codeLayerSchema)` at module load (a side
  effect of importing `@claudevid/layer-code`, matching the registry's documented calling
  convention). Fields (all beyond the shared `baseLayerShape` — `x`/`y`/`start`/`duration`/
  `animation`, unchanged from `packages/core/src/schema.ts:40-46`):
  - `code: string` (min 1, max 20000 chars) — the source. When `diff` is set (FR8), `code` is
    the diff's **after** state (no redundant `after` field).
  - `lang: string`, `theme?: string` — kept as free strings, not a Zod enum, validated against
    the bundled set at **compile time** by `highlight.ts` (FR2) instead of at parse time. This
    mirrors `003`'s own precedent of routing authored-content mistakes through a diagnostic with
    a helpful suggestion rather than Zod's generic "invalid enum value" message (design.md
    Grounding). `theme` defaults to `"github-dark"`.
  - `width: number`, `height: number` (both positive, **required**) — the chrome box's pixel
    size, matching `rect`'s required-`width`/`height` convention
    (`packages/core/src/schema.ts` `rectLayerSchema`) rather than `image`'s optional one, since
    a code window's box is fundamental to its legibility guardrails (FR6).
  - `title?: string`, `showLineNumbers?: boolean` (default `false`).
  - `fontSize?: number` (default `20`, auto-fit floor `12` — FR5), `tabSize?: number` (default
    `2`), `wrap?: "none" | "soft"` (default `"none"`), `maxLines?: number` (optional explicit
    cap; see FR6 for how it composes with the box-derived limit).
  - `reveal?: CodeReveal` (FR7), `focus?: CodeFocus` (FR7), `diff?: CodeDiff` (FR8),
    `scroll?: CodeScroll` (FR7), `annotations?: CodeAnnotation[]` (FR9).
- **FR2 — Bundled Shiki subset, loaded once, no network I/O.** `highlight.ts` calls
  `createHighlighterCore` exactly once per process (module-level singleton, lazily created on
  first use) with a **fixed, statically-imported** set of langs — `typescript`, `javascript`,
  `tsx`, `jsx`, `python`, `bash`, `json`, `yaml` — and themes — `github-dark`, `github-light`,
  `high-contrast` — using Shiki's fine-grained core bundle (`shiki/core` +
  `shiki/engine/javascript`, not the full `shiki` package) so the bundle's size is proportional
  to these 8 langs/3 themes, not Shiki's entire grammar library. No lang/theme is fetched from
  network or disk on demand at render time — resolved per the "Open Questions, resolved" section
  below.
- **FR3 — `compileCodeLayers`, the named tokenizer/compiler.** `compileCodeLayers(spec:
  VideoSpec): Promise<{ compiled: Map<layerKey, TokenizedCode>; diagnostics: Diagnostic[] }>` in
  `highlight.ts` walks every `code`-typed layer in `spec` (via `compileTimeline`'s already-
  flattened `Timeline.layers`, passed in alongside `spec` — same two-argument shape as
  `compileMotion(spec, timeline)`), tokenizes each **exactly once**, and returns a plain
  `Map`. Two layers with identical `(code, lang, theme)` share one tokenization call (an
  internal `Map<string, TokenizedCode>` keyed by a content hash of the triple, checked before
  calling Shiki) — duplicated snippets in one spec are not re-tokenized. This is the one place
  Shiki's async highlighter API is invoked; nothing below this function in the call graph ever
  imports `shiki`.
- **FR4 — `TokenizedCode` IR is a plain, serializable object.** `{ lines: { tokens: { text:
  string; color: string; fontStyle: number }[] }[] }` exactly, per the proposal — no class
  instances, no functions, no Shiki types anywhere in the returned value. Verified structurally
  (AC1): `JSON.parse(JSON.stringify(ir))` deep-equals `ir` for every compiled layer.
- **FR5 — Monospace fast-path layout.** `layout.ts`'s `measureLine(charCount, fontSizePx):
  number` returns `charCount * advanceWidthPx(fontSizePx)`, where `advanceWidthPx` is read once
  from the bundled `JetBrains Mono` font's own metrics (via `@napi-rs/canvas`'s `measureText` on
  a single reference character at a given size, cached per fontSize — never per-token
  `measureText` calls). `layout.ts` never calls `ctx.measureText` per token; it calls it at most
  once per distinct `fontSize` value used across a render. Tab characters expand to `tabSize`
  spaces before this measurement (FR1's `tabSize`) — expansion happens once, identically in
  `layout.ts` (measurement) and `render.ts` (paint), so char index and pixel-x never disagree
  (this is also what keeps typewriter's per-character caret position exact — see FR7).
- **FR6 — Auto-fit and declared-max-lines guardrail, fail-closed.** Given `wrap: "none"`
  (default), if the longest tab-expanded line's measured width at `fontSize` exceeds `width`
  minus chrome padding and the line-number gutter (if `showLineNumbers`), `layout.ts` retries at
  `fontSize - 1` down to a floor of `12`; if no size fits, `diagnostics.ts` emits a diagnostic
  naming the longest line's character count and the fitting fontSize gap, and `compileCodeLayers`
  marks that layer's `TokenizedCode` entry as `blocked: true`. Given `wrap: "soft"`, an
  over-width line instead wraps with a continuation indent (increasing the effective line
  count). Separately: `availableLines = floor((height - chromeVerticalPx) / lineHeightPx)`
  (`chromeVerticalPx` = title bar + border + padding, a fixed constant from `render.ts`'s chrome
  spec — design.md). The **effective line count** (after wrap expansion) exceeding
  `min(maxLines ?? Infinity, availableLines)` **and** no `scroll` config present is a diagnostic
  naming the actual line count and the max that fits, with a suggestion listing all three fixes
  (shorten the snippet, increase `height`, or add a `scroll` config) — and marks the entry
  `blocked: true`. A `scroll` config turns the box into a viewport, so this specific diagnostic
  does not apply when one is present (FR7 still fits the *visible* window, independently).
- **FR7 — Render-time refusal is the second guardrail layer.** `render.ts`'s `paintCodeLayer`
  **throws** a typed `CodeOverflowError` if asked to paint a `TokenizedCode` entry with
  `blocked: true` — this means a caller that renders without checking `compileCodeLayers`'s
  `diagnostics` array still cannot produce an overflowing frame silently; it gets a hard
  process-level failure instead of bad pixels. This is the literal requirement from `GOALS.md`'s
  004 checklist: "never render a code block that doesn't fit."
- **FR8 — Per-line raster cache and pre-rendered chrome.** `render.ts` maintains one cache of
  rendered line bitmaps, content-hash-keyed on `(tokens, fontSize, theme, dimmed: boolean,
  lineWidthPx)` — **not** on line index or layer key, so two lines with identical tokens/state
  (even across different layers or positions) share one bitmap, following
  `packages/renderer-canvas/src/raster-cache.ts`'s exact LRU shape (design.md's per-line cache
  key scheme). A separate single-entry-per-distinct-config cache holds the pre-rendered chrome
  bitmap (rounded background, border, title bar text, traffic-light dots), keyed on `(width,
  height, theme, title, showLineNumbers)` — painted once, blitted every frame, never
  re-rasterized for a border/shadow (`002`'s rule: shadows/blurs are never per-frame
  operations). A frame's composited output is: blit chrome, blit each fully-revealed line's
  cached bitmap at its `y` offset, draw at most one partially-revealed line's glyphs directly
  (typewriter's in-flight line — the one thing that is never cached, by design), draw the caret
  if enabled. Dimmed lines (FR10 focus) are a **separate** cache entry from their non-dimmed
  counterpart (the key's `dimmed` component) since the pixels differ.
- **FR9 — Font ligatures are disabled.** Code is painted character-run by character-run using
  each character's own advance width from FR5's fast path, never as a single `fillText` call
  over a multi-character span that a shaping engine could substitute a ligature glyph into. This
  is a documented constraint (see "Open Questions, resolved" below), not a per-token toggle —
  it's what keeps FR5's char-index-to-pixel-x correspondence exact for typewriter/annotation
  positioning.
- **FR10 — Animations are pure functions of frame.** `animations.ts` exports:
  - `typewriterState(reveal: CodeReveal, frameLocal: number, fps: number, lineLengths:
    number[]): { revealedLines: number; partialLineChars: number; caretOn: boolean }` for
    `reveal.mode === "typewriter"` (units: `"char"` (default) | `"token"` | `"line"`, at
    `reveal.rate` units/sec — default `30` char/s, `8` token/s, `2` line/s by unit — after an
    optional `reveal.startDelay` seconds). `caretOn` blinks at a fixed 2 Hz once revealing
    starts, using `Math.floor(frameLocal / (fps / 4)) % 2 === 0` (pure, no timers).
  - `lineStaggerDelays(childCount: number, each: number, from: StaggerSpec["from"]):
    number[]` for `reveal.mode === "line-stagger"` — delegates directly to `@claudevid/motion`'s
    exported `orderIndices` (`packages/motion/src/stagger.ts`) for the ordering, then multiplies
    by `each`, reusing 003's exact determinism guarantee (same FNV-1a hash, no `Math.random`)
    instead of re-implementing it.
  - `focusState(focus: CodeFocus, frameLocal: number, fps: number): { range: [number, number];
    dimOpacity: number }` — static `focus.lines` if no `focus.animate`; otherwise the range's
    two endpoints each lerp from `focus.animate.from` to `focus.lines` over `duration` seconds
    using `resolveEasing(focus.animate.easing ?? "linear")` (imported directly from
    `@claudevid/motion`, per the "Grounding" note above — no re-implementation of easing math).
  - `scrollOffsetPx(scroll: CodeScroll, frameLocal: number, fps: number, lineHeightPx: number):
    number` — lerps `(scroll.fromLine ?? 1)` to `scroll.toLine` (1-indexed) over `duration`
    seconds with the same `resolveEasing` reuse, returned as a vertical pixel offset.
  All four functions take only plain numbers/arrays as input and return plain data — no Shiki,
  no canvas, matching `NFR1`.
- **FR11 — Diff via `{before, after}` pair (v1's one supported input format).**
  `diff.ts`'s `diffLines(before: string, after: string): DiffLine[]` (`DiffLine = { text:
  string; kind: "unchanged" | "added" | "removed" }`) runs a deterministic LCS-based line diff
  (`packages/layer-code/src/diff.ts`, pure, no dependency on any diff library). A `CodeDiff`
  config on a layer supplies `before`; `after` is the layer's own `code` field (FR1). `diff.ts`
  never parses a unified-diff string in v1 — see "Open Questions, resolved" for the reasoning
  and the noted v1.1 follow-on. Added/removed lines get theme-derived background tints
  (`addedBg`/`removedBg`, defaulting to a fixed green/red at low alpha) that fade in over
  `diff.duration` seconds starting at `diff.revealDelay` (both via the same `animations.ts`
  frame-pure pattern as FR10).
- **FR12 — Line-anchored annotations.** `annotate.ts`'s `annotationPosition(annotation:
  CodeAnnotation, layout: LayoutResult): { x: number; y: number }` reads the target line's `y`
  directly from `layout.ts`'s own per-line offset table (the same numbers `render.ts` uses to
  position line bitmaps — one source of truth, no duplicated arithmetic) and an `x` on the
  declared `side` (`"left"` default, gutter-adjacent, or `"right"`, past the longest line).
  `annotation.line` outside `[1, codeLineCount]` is a diagnostic (FR13), not a silently-clamped
  position — consistent with `focus.lines`/`scroll.toLine` out-of-range handling below.
- **FR13 — Diagnostics, fail-closed, `core.Diagnostic`-shaped.** `diagnostics.ts` is the single
  place every diagnostic in this package is constructed (`{ path, message, suggestion }`,
  reusing `packages/core/src/diagnostics.ts:5-9`'s type directly, no local redefinition). Cases,
  each with a specific `suggestion`: unsupported `lang` (lists the 8 bundled langs),
  unsupported `theme` (lists the 3 bundled themes), line-overflow (FR6), line-too-long-to-fit
  (FR6), `focus.lines`/`scroll.toLine`/`annotations[].line` referencing a line number outside
  `[1, codeLineCount]`. `compileCodeLayers`'s returned `diagnostics` array is non-empty exactly
  when at least one of these fired; a non-empty array is a hard stop for any non-interactive
  caller — the same `ok:false`-equivalent disposition `parseSpec` and `compileMotion` already
  established in this codebase (design.md's Grounding cites both).
- **FR14 — Renderer wiring via an additive painter registry (not a new `@claudevid/renderer-
  canvas` dependency on `@claudevid/layer-code`).** `packages/renderer-canvas/src/painters.ts`
  (new, small) exports `registerPainter(type: string, paint: PainterFn)` /
  `getPainter(type): PainterFn | undefined`, mirroring `core.layers.ts`'s `registerLayer`
  extension-point shape one layer up the stack. `index.ts`'s per-layer `switch`'s `default` case
  (currently `continue` for any unrecognized `layer.layer.type` —
  `packages/renderer-canvas/src/index.ts:154-158`) is changed to consult `getPainter(layer.layer
  .type)` before falling through to `continue`, so a registered custom painter runs exactly
  where `text`/`rect`/`image` already do — same transform-bracket/hold-frame treatment, no
  special-casing. `@claudevid/layer-code`'s `index.ts` calls `registerPainter("code",
  paintCodeLayer)` at module load (the same "import to register" convention as FR1's
  `registerLayer` call). This keeps the dependency edge one-directional
  (`layer-code → renderer-canvas`, for the raster-cache/font/canvas primitives it needs) and
  avoids a cycle that a direct `renderer-canvas → layer-code` import would create.
- **FR15 — Contrast-verified bundled themes.** `themes.ts` exports `checkThemeContrast(theme:
  BundledTheme): { colorHex: string; ratio: number }[]`, computing the WCAG relative-luminance
  contrast ratio between every distinct token colour Shiki emits for that theme and the theme's
  background colour. This runs as a **test-time** check (AC12), not a runtime gate — bundled
  themes are first-party, reviewed content, not spec-authored input.

### Non-Functional Requirements

- **NFR1 — No live Shiki instance crosses a serialization boundary.** `TokenizedCode` (FR4) is
  the only thing `compileCodeLayers` returns to a caller; the highlighter instance itself never
  leaves `highlight.ts`'s module scope. This is a hard requirement for change 005's
  `worker_threads` timeline-transfer plan (`GOALS.md`).
- **NFR2 — Tokenization is compile-time-only.** No file under `packages/layer-code/src/render.ts`,
  `animations.ts`, `diff.ts`, or `annotate.ts` imports `shiki` or `highlight.ts` — enforced by a
  grep-based test (mirrors `003`'s NFR1 canvas-import grep for `packages/motion/test/`).
- **NFR3 — Per-line cache hit rate during typewriter is (N-1)/N.** For an N-line block revealed
  via typewriter, rendering every frame of the reveal produces at most one cache miss per frame
  beyond the first full pass (AC8) — the proposal's headline efficiency claim, mechanically
  measured against the cache's own `hits`/`misses` counters (same shape as
  `raster-cache.ts`'s `stats()`).
- **NFR4 — Determinism.** Given the same `VideoSpec` and frame number, `compileCodeLayers` and
  `paintCodeLayer` always produce the same output — no `Math.random`, no wall-clock reads
  (matches `003`'s `NFR2` precedent for `@claudevid/motion`).
- **NFR5 — No network fetch, ever.** Bundled langs/themes/engine are static imports resolved at
  module load from packages already in `node_modules` (installed at `pnpm install` time) — no
  `fetch`/`http` call anywhere in `packages/layer-code/src`, matching this repo's existing
  no-implicit-network-fetch posture (`GOALS.md`'s 006 BLOCK finding on the same principle,
  applied here pre-emptively).
- **NFR6 — Zero co-changes to `packages/core`, `packages/motion`, or their test suites**, beyond
  the one additive `packages/renderer-canvas/src/painters.ts` extension point and its
  one-line `index.ts` dispatch change (FR14). All three already-verified packages (`001`,
  `002`, `003`) are otherwise untouched by this change.

## Acceptance Criteria

- **AC1:** `compileCodeLayers` on a spec with one `code` layer (`lang: "typescript"`) returns a
  `TokenizedCode` whose `JSON.parse(JSON.stringify(ir))` is deep-equal to `ir` itself (FR4/NFR1
  — proves no live Shiki instance or non-serializable value is embedded).
- **AC2:** A spec with two `code` layers sharing identical `(code, lang, theme)`: a spy on the
  internal Shiki tokenize call records exactly **one** invocation for that triple across both
  layers (FR3 — cross-layer dedupe within one `compileCodeLayers` call).
- **AC3:** A `code` layer with `lang: "cobol"` produces a diagnostic whose `suggestion` lists all
  8 bundled langs by name, and `compileCodeLayers` does not throw (FR2/FR13).
- **AC4:** `layout.ts`'s `measureLine(charCount, fontSizePx)` for a fixed `fontSizePx` returns a
  value within `0.01px` of `charCount * measureLine(1, fontSizePx)` for `charCount` in `{1, 10,
  80}` — the fast-path linearity claim, asserted numerically (FR5), no image comparison.
- **AC5:** A `code` layer with 40 lines, `height` sized for `availableLines = 20`, and no
  `scroll` config: `compileCodeLayers` returns a diagnostic naming `40` and `20`, and
  `paintCodeLayer` on that entry throws `CodeOverflowError` rather than drawing (FR6/FR7).
- **AC6:** The identical scenario from AC5 but with a `scroll: { toLine: 21, duration: 1 }`
  config added: no overflow diagnostic is produced, and `paintCodeLayer` does not throw (FR6's
  scroll exemption).
- **AC7:** A static (no `reveal`) 15-line block painted for 10 consecutive identical frames:
  after the first frame, the per-line cache's `misses` counter does not increase across
  frames 2-10 (100% hit rate on a fully static block — FR8's baseline case).
- **AC8:** A 15-line block with `reveal: { mode: "typewriter", unit: "char", rate: 30 }`
  rendered across every frame of its reveal: summed across all frames, `misses <=
  totalFrames + 15` (at most one new miss per frame for the actively-typing line, plus each
  line's own first-reveal miss) while `hits / (hits + misses) >= 14/15` measured over the
  reveal's steady-state frames — the NFR3 claim, mechanically asserted against the cache's own
  counters.
- **AC9:** `diffLines("a\nb\nc", "a\nx\nc")` returns exactly `[{text:"a",kind:"unchanged"},
  {text:"b",kind:"removed"}, {text:"x",kind:"added"}, {text:"c",kind:"unchanged"}]` — a golden
  fixture pinning the LCS diff's exact output shape (FR11).
- **AC10:** For a block with `focus: { lines: [3,3] }` on a 5-line block: the raw pixel buffer
  for line 3's cached bitmap and line 1's cached bitmap (outside the focus range) differ, and
  line 1's average luminance is measurably closer to the chrome background colour than line 3's
  (the alpha-blend-toward-background dim, FR10 + the resolved colour-derivation decision below)
  — a raw-pixel assertion, not a snapshot image.
- **AC11:** `annotationPosition({line: 3, text: "note", side: "left"}, layout)` returns a `y`
  within `1px` of `layout`'s own recorded offset for line 3 (FR12), verified against
  `layout.ts`'s output directly, not re-derived independently.
- **AC12:** `checkThemeContrast` for each of the 3 bundled themes returns zero entries with
  `ratio < 3.0` against that theme's own background (FR15's documented minimum, chosen to match
  WCAG's "large text" threshold — code at typical video font sizes qualifies as large text).
- **AC13:** `pnpm --filter @claudevid/layer-code build` and `... test` succeed standalone from a
  clean checkout, and `pnpm -r run build && pnpm -r run test` (the whole workspace) still passes
  — this change does not regress `001`/`002`/`003`'s existing suites (NFR6).
- **AC14:** An end-to-end spec (`parseSpec` → `compileTimeline` → `compileCodeLayers` →
  `createRenderer().renderFrame` with the `"code"` painter registered via FR14) for a small,
  non-overflowing `code` layer produces a non-empty pixel buffer with zero diagnostics from
  either compile step — the "it actually renders" integration proof tying FR1-FR14 together.

## Edge Cases

- Tab characters in `code`: expanded to `tabSize` spaces identically in `layout.ts` (FR5's
  measurement) and `render.ts` (paint) — a single shared expansion function, never duplicated
  logic that could disagree.
- `diff.before === code` (no actual changes): `diffLines` returns every line `"unchanged"`; the
  block renders as plain highlighted code with no added/removed tint — no special-cased
  early-return needed, the LCS diff naturally produces this.
- `focus.lines`, `scroll.toLine`, or any `annotations[].line` referencing a line number outside
  `[1, codeLineCount]`: a diagnostic (FR13), never silently clamped — consistent with `003`'s
  FR9 fail-closed precedent for authored-content mistakes rather than 002/003's separate
  "clamp, don't diagnose" precedent for *rendering-time* frame overflow (design.md's Grounding
  section explains why this case is the former, not the latter).
- `reveal.mode: "typewriter"` with `rate <= 0`: rejected by the Zod schema (`z.number()
  .positive()`), not reachable as a runtime diagnostic.
- A `code` layer with `maxLines` set **lower** than what `height` would otherwise fit: the
  explicit `maxLines` wins (`min(maxLines, availableLines)`, FR6) — an author can deliberately
  reserve vertical space without triggering FR6's guardrail early.
- Two `code` layers with the same `code`/`lang` but **different** `theme`: tokenization is
  per-`(code, lang, theme)` triple (FR3), so this is correctly two cache entries, not
  incorrectly deduped to one.

## Dependencies

- **Depends on:** `001-videospec-core` (`registerLayer`, `Diagnostic` type, `Timeline`/
  `compileTimeline`'s flattened `layers` list). `002-canvas-render-engine` (the raster-cache LRU
  *pattern* reused at line granularity — `packages/renderer-canvas/src/raster-cache.ts` — plus
  the bundled `JetBrains Mono` font/`MONO_FONT_FAMILY`, `packages/renderer-canvas/src/fonts.ts`,
  and the rounded-rect chrome-painting pattern from `draw-shapes.ts`). `003-motion-system`
  (`resolveEasing`, `orderIndices` — both reused directly, not re-implemented; the free-channel
  `animation.enter`/`exit` preset mechanism already applies to any registered layer type
  including `code`, unmodified).
- **Depended on by:** `007-cli-claude-skill` (will want `layer-code`'s capability surface — the 8
  bundled langs, 3 themes, and the reveal/focus/diff/scroll animation vocabulary — for its
  director prompt, the same way it already consumes `003`'s `exportCatalogue()`). A future
  ANSI/terminal-output layer (`GOALS.md`'s "Not in any proposal" list) is a natural sibling
  reusing this change's per-line cache and chrome machinery with a different tokenizer — **not**
  built in this change (see "Open Questions, resolved" below).

## Notes

### Open Questions, resolved

1. **Shiki's weight / bundling — bundle a fixed set at build time (FR2).** A fixed,
   statically-imported set of 8 langs (`typescript`, `javascript`, `tsx`, `jsx`, `python`,
   `bash`, `json`, `yaml`) and 3 themes (`github-dark`, `github-light`, `high-contrast`), using
   Shiki's fine-grained core bundle rather than the full `shiki` package or an on-demand
   dynamic-import scheme. This directly answers the proposal's own stated concern — cold start
   for `007`'s `preview --watch` loop and for `005`'s many-spawned-batch-process model — with a
   bounded, predictable cost (no first-render network/disk-scan tax, no per-language dynamic
   `import()` the module bundler has to code-split around) at the price of a larger package
   install size, which is a one-time cost, not a per-render one. On-demand loading was rejected
   because it reintroduces exactly the "confidently emit code that renders wrong" risk this
   change exists to close, at the language-support boundary this time: a Claude-authored spec
   requesting an unbundled language would either silently fail at render time (network
   available) or produce a different failure mode per environment (network unavailable),
   instead of one deterministic, first-party-reviewed diagnostic (FR13/AC3).
2. **Diff input format — `{before, after}` pair is v1's one supported format (FR11).** A pair is
   "easier for Claude to emit correctly" (the proposal's own phrase) — no diff-syntax grammar to
   get subtly wrong, no ambiguity about hunk-header line numbers matching the actual `code`
   content. Unified-diff-string parsing (what a human or `git diff` naturally produces) is a
   real, scoped v1.1 follow-on — `diff.ts`'s pure `diffLines(before, after)` primitive is exactly
   what a unified-diff parser would need to *produce* internally (parse the string into a
   `{before, after}` pair, then call the same function), so this is additive later, not a
   redesign.
3. **ANSI/terminal-output layer — explicitly out of scope for this change.** `GOALS.md` already
   carries this as a candidate follow-on ("Not in any proposal" list, and 004's own "Open"
   line: "whether an ANSI/terminal layer folds in here or becomes change 008"). This change
   answers that: it does not fold in. Terminal output (`npm install`, test runners, `git log`)
   needs a different tokenizer (ANSI escape codes, not a Shiki grammar) but can reuse this
   change's chrome/per-line-cache/animation machinery — a real, separate follow-on change, not
   "just" a registry entry (the same reasoning `003`'s spec.md used to reject folding `push`/
   `wipe` transitions into its own closed set).
4. **Font ligatures — disabled (FR9).** Each character is painted at its own measured advance
   width; no multi-character span is ever shaped as a unit that a ligature substitution could
   apply to. This is the proposal's own "simplest option," chosen because it's what preserves
   FR5's fast advance-width path exactly (a ligated run's width is not `charCount ×
   advanceWidth` — it's narrower, by however many glyphs got merged) and FR10's typewriter caret
   math (the caret's x position is `revealedChars × advanceWidth`; a ligature would make that
   formula wrong for the one line currently being typed, which is the line most under visual
   scrutiny in a code walkthrough). Documented constraint: `=>`, `!==`, `->` etc. render as
   their separate constituent glyphs, not connected ligature glyphs, in every bundled theme.
5. **Focus/dim colour derivation — alpha-blend toward the chrome background, not OKLCH.**
   `packages/motion/src` was checked directly (`properties.ts`, `track.ts`, `easing.ts`,
   `presets.ts`, `compile.ts`, `stagger.ts`, `resolver.ts`, `index.ts`) — `003`'s own spec.md
   explicitly cut colour interpolation from v1 ("Colour, `fontSize`, `letterSpacing`... are
   out of scope for this change", `003/spec.md`'s Overview), and no OKLCH primitive exists
   anywhere in the shipped `packages/motion` or `packages/core` source. Per this change's own
   instruction to fall back when no reusable primitive exists: `render.ts` dims a line by
   compositing its token colours over the chrome's resolved background colour at a fixed alpha
   (`focus.dimOpacity`, default `0.35`, applied as `ctx.globalAlpha` during that line's cache
   bake) — a straight sRGB alpha blend, not a perceptual lightness-space computation. This is
   documented as a revisit point: if a future change ships an OKLCH colour-interpolation
   primitive in `@claudevid/motion` (`003`'s own forward-compatibility notes gesture at this),
   `render.ts`'s dim computation is the one call site to swap it into.

### Scope cuts, and why

- **Prism fallback** — not built; Shiki only (proposal's own scope cut, unchanged here).
- **Live code execution / REPL capture, editor chrome beyond a title bar (tabs/sidebar/
  minimap), semantic/LSP-aware highlighting** — all proposal scope cuts, unchanged; none of
  FR1-FR15 above needs any of them.
- **A `Channel`/`Track` extension in `@claudevid/motion` for code's reveal state** — considered
  (per `003`'s own forward-compatibility note) and rejected for v1: `animations.ts`'s pure
  frame-in/state-out functions (FR10) achieve the same outcome without reopening a
  verify-PASSed, sealed package's closed union. Revisit only if a future consumer needs code's
  reveal state to compose with `@claudevid/motion`'s `Track`/`evaluate` machinery in a way a
  pure function can't (no such consumer exists today).
