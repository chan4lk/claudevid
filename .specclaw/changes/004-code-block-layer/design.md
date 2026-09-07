# Design: Animated Code Block Layer — Shiki, Compile-Time Tokenized, Line-Cached

**Change:** 004-code-block-layer
**Created:** 2026-09-07

## Technical Approach

```
parseSpec(json)                              [core, unchanged]
        │
        ▼
compileTimeline(spec)                        [core, unchanged]
        │
        ▼
    Timeline ───────────────────────────────────────┐
        │                                            │
        ▼                                            │
compileCodeLayers(spec, timeline)  [layer-code, new]  │
  ├─ for each `code`-typed TimelineLayer:              │
  │    dedupe-key = hash(code, lang, theme)             │
  │    if not tokenized yet: highlighter.codeToTokens()   │  (Shiki, async init once)
  │    → TokenizedCode (plain object, FR4)                 │
  │    layout: measure/wrap/fit-to-width (layout.ts)        │
  │    diagnostics: unsupported lang/theme, overflow,        │
  │                 out-of-range focus/scroll/annotation line │
  └─ → { compiled: Map<layerKey, TokenizedCode & {           │
          layout: LayoutResult; blocked: boolean }>,          │
          diagnostics: Diagnostic[] }                          │
        │                                                      │
        ▼                                                      │
  if diagnostics.length: caller stops (fail-closed, same        │
  disposition as parseSpec/compileMotion) — never reaches render │
        │                                                        │
        ▼                                                        │
registerPainter("code", paintCodeLayer)      [layer-code → renderer-canvas, side effect on import]
        │
        ▼
renderer.renderFrame(timeline, frame, target, { motion })   [renderer-canvas, extended: FR14]
  └─ per active layer: painter = getPainter(layer.layer.type) ?? builtin-switch
       "code" → paintCodeLayer(compiledEntry, frame, lineCache, chromeCache)
         ├─ if compiledEntry.blocked: throw CodeOverflowError (FR7 — second guardrail)
         ├─ frameLocal = frame - layer.startFrame
         ├─ animations.ts: typewriterState / focusState / scrollOffsetPx / diff fade (FR10/FR11)
         ├─ chrome: chromeCache.getOrRender(chromeKey, ...)   — blit, never re-painted
         ├─ each fully-revealed line: lineCache.getOrRender(lineKey, ...) — blit
         ├─ the one partially-revealed line (typewriter): drawn directly, never cached
         └─ annotations: annotate.ts positions, drawn directly (cheap, small count)
```

Two packages change, one is new:

- **`@claudevid/layer-code`** (new) — everything above `compileCodeLayers` through
  `paintCodeLayer`. Depends on `@claudevid/core` (schema/diagnostics/registerLayer),
  `@claudevid/renderer-canvas` (raster-cache-shaped LRU reused at line granularity, bundled
  fonts, canvas primitives, the new `painters.ts` registry), `@claudevid/motion`
  (`resolveEasing`, `orderIndices` only — not `Track`/`evaluate`/`Channel`), and `shiki`
  (`shiki/core` + `shiki/engine/javascript`, fine-grained bundle).
- **`@claudevid/renderer-canvas`** (extended, minimal) — one new file (`painters.ts`, ~15
  lines) and a one-branch change to `index.ts`'s existing per-layer `switch`'s `default` case.
  No existing exported function's signature changes.
- **`@claudevid/core`, `@claudevid/motion`** — **untouched.** Zero files modified (NFR6).

## Grounding sources

- `packages/core/src/layers.ts:118-121` (`registerLayer(type, schema)` / `layerUnion()`) — the
  exact extension point this change's `schema.ts` calls at module load; the function's own
  comment ("used by 004 (`code`) and 006 (`captions`)") is this repo's own forward-reference to
  this change.
- `packages/core/src/diagnostics.ts:5-11` (`Diagnostic { path, message, suggestion }`,
  `ParseResult = {ok:true,...}|{ok:false, diagnostics}`) — reused verbatim by
  `compileCodeLayers`'s return shape (FR13), the same disposition `compileMotion`
  (`003/design.md`'s Key Decision, "`compileMotion` diagnostics reuses [`parseSpec`'s]
  disposition") already established — this is the third package to adopt it, not a new
  precedent.
- `packages/renderer-canvas/src/raster-cache.ts` (full file) — `createRasterCache(limitBytes)`'s
  `Map` with insertion-order-as-LRU-recency (`entries.delete(key); entries.set(key, existing)`
  on hit, evict-oldest-while-over-budget on miss, `bytes = width * height * 4` accounting) is
  reused **verbatim as a pattern** (not imported directly — see Key Decision D1 below for why a
  separate, line-granularity instance exists instead of extending the shared one) for this
  change's per-line cache.
- `packages/renderer-canvas/src/text.ts:53-55,77-88` (`contentHash` via plain string-join, the
  raster-cache key built from every visually-relevant field, layout cached alongside the raster
  under the identical key) — the pattern `layout.ts`/`render.ts` follow for the per-line cache
  key (design's "Per-line cache key scheme" section below).
- `packages/renderer-canvas/src/fonts.ts:10` (`MONO_FONT_FAMILY = "JetBrains Mono, monospace"`)
  and `draw-shapes.ts:14-19` (`ctx.roundRect` chrome-painting pattern) — reused directly for
  the bundled monospace font and the chrome's rounded-rect background/border.
- `packages/renderer-canvas/src/index.ts:154-158` (the per-layer `switch`'s `default: continue`
  for any `layer.layer.type` with no built-in case) — the exact site FR14's `painters.ts`
  registry hooks into; the one-branch change is `default: { const p = getPainter(layer.layer
  .type); if (p) { /* run p, same transform-bracket path as text/rect/image */ } else continue;
  }`.
- `packages/motion/src/index.ts:1-21` (public export list) — confirms `resolveEasing` (from
  `easing.ts`) and `orderIndices` (from `stagger.ts`) are both already public, channel-agnostic
  exports; `Track`/`evaluate`/`Channel`/`PropertyBag`/`compileMotion` are the parts this change
  deliberately does **not** touch or extend (spec.md's "Open Questions, resolved" #5 / Scope
  cuts).
- `packages/motion/src/properties.ts` + `packages/motion/src/track.ts` (read directly, in full)
  — confirms `Channel` is a closed 6-member string union and `PropertyBag` has exactly those 6
  optional fields, with no colour/discrete-step channel and no OKLCH/colour-interpolation helper
  anywhere in the package — the concrete check spec.md's Open Question #5 required before
  falling back to alpha-blend.
- `.specclaw/changes/003-motion-system/spec.md`'s Overview ("Colour, `fontSize`,
  `letterSpacing`, and text-reveal channels... are out of scope for this change") and its Notes
  "Forward-compatibility notes for later changes" (predicting a 004 `revealChars` `Channel`
  extension) — this design explicitly declines that extension (see Key Decision D2), so a future
  reader doesn't rediscover the option from zero.
- `packages/core/src/schema.ts:48-59,62-72` (`textLayerSchema`/`rectLayerSchema` — required vs.
  optional `width`/`height` conventions) — grounds FR1's choice to make `code`'s `width`/
  `height` required, following `rect`'s convention rather than `image`'s.

## Architecture

```
packages/layer-code/
  package.json                # deps: @claudevid/core, @claudevid/renderer-canvas,
                               #       @claudevid/motion (workspace), shiki
  tsup.config.ts               # ESM build, mirrors packages/motion's tsup.config.ts
  vitest.config.ts               # mirrors packages/motion's vitest.config.ts
  tsconfig.json                    # extends ../../tsconfig.base.json
  src/
    schema.ts                        # CodeLayer zod schema + type, registerLayer("code", ...)
    themes.ts                         # BUNDLED_THEMES data, checkThemeContrast()
    highlight.ts                       # createHighlighterCore singleton, compileCodeLayers()
    layout.ts                           # measureLine, wrap, fit-to-width, computeAvailableLines
    diagnostics.ts                       # all Diagnostic construction for this package
    diff.ts                               # diffLines() — pure LCS line diff
    animations.ts                          # typewriterState/lineStaggerDelays/focusState/
                                            # scrollOffsetPx — all pure (frame) -> state
    annotate.ts                             # annotationPosition()
    render.ts                                # per-line cache, chrome cache, paintCodeLayer,
                                              # CodeOverflowError, isCodeLayer guard
    index.ts                                 # public exports; side-effecting registerLayer +
                                              # registerPainter calls
  test/
    schema.test.ts
    highlight.test.ts                        # AC1, AC2, AC3
    layout.test.ts                           # AC4
    diagnostics.test.ts                      # AC5, AC6, Edge Cases (out-of-range lines)
    render-cache.test.ts                     # AC7, AC8
    diff.test.ts                             # AC9
    focus.test.ts                            # AC10
    annotate.test.ts                         # AC11
    themes.test.ts                           # AC12
    no-shiki-outside-highlight.test.ts       # NFR2 grep-based import check
    integration.test.ts                      # AC14

packages/renderer-canvas/src/
  painters.ts                  # NEW: registerPainter(type, paint) / getPainter(type)
  index.ts                     # MODIFY: default case consults getPainter() before `continue`
packages/renderer-canvas/test/
  painters.test.ts             # NEW: registry get/set, unknown type still no-ops
```

### `schema.ts`

```ts
import { z } from "zod";
import { registerLayer } from "@claudevid/core";

export const BUNDLED_LANGS = ["typescript","javascript","tsx","jsx","python","bash","json","yaml"] as const;
export const BUNDLED_THEMES = ["github-dark","github-light","high-contrast"] as const;

const revealSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("typewriter"), unit: z.enum(["char","token","line"]).optional(),
             rate: z.number().positive().optional(), startDelay: z.number().min(0).optional(),
             caret: z.boolean().optional() }),
  z.object({ mode: z.literal("line-stagger"), each: z.number().positive(),
             from: z.enum(["first","center","last","random"]).optional() }),
]);
const focusSchema = z.object({
  lines: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  dimOpacity: z.number().min(0).max(1).optional(),
  animate: z.object({ from: z.tuple([z.number().int().positive(), z.number().int().positive()]),
                       duration: z.number().positive(), delay: z.number().min(0).optional(),
                       easing: z.string().optional() }).optional(),
});
const diffSchema = z.object({ before: z.string().min(1), addedBg: z.string().optional(),
                               removedBg: z.string().optional(), revealDelay: z.number().min(0).optional(),
                               duration: z.number().positive().optional() });
const scrollSchema = z.object({ toLine: z.number().int().positive(), fromLine: z.number().int().positive().optional(),
                                 duration: z.number().positive(), delay: z.number().min(0).optional(),
                                 easing: z.string().optional() });
const annotationSchema = z.object({ line: z.number().int().positive(), text: z.string().min(1),
                                     side: z.enum(["left","right"]).optional(), color: z.string().optional(),
                                     delay: z.number().min(0).optional() });

export const codeLayerSchema = z.object({
  ...baseLayerShape,               // imported from @claudevid/core's shared shape (x/y/start/duration/animation)
  type: z.literal("code"),
  code: z.string().min(1).max(20000),
  lang: z.string().min(1),
  theme: z.string().min(1).optional(),
  width: z.number().positive(),
  height: z.number().positive(),
  title: z.string().optional(),
  showLineNumbers: z.boolean().optional(),
  fontSize: z.number().min(12).optional(),
  tabSize: z.number().int().positive().optional(),
  wrap: z.enum(["none","soft"]).optional(),
  maxLines: z.number().int().positive().optional(),
  reveal: revealSchema.optional(),
  focus: focusSchema.optional(),
  diff: diffSchema.optional(),
  scroll: scrollSchema.optional(),
  annotations: z.array(annotationSchema).optional(),
});
export type CodeLayer = z.infer<typeof codeLayerSchema>;

registerLayer("code", codeLayerSchema);   // side effect: importing this module (or index.ts) registers it
```

`baseLayerShape` is not exported from `@claudevid/core` today (`packages/core/src/schema.ts:40`
is module-private) — `schema.ts` restates the four shared fields (`x`, `y`, `start`, `duration`,
`animation`) locally using the same Zod primitives `@claudevid/core` exports
(`coordinateSchema`-equivalent via a plain `z.union([...])`, since that helper is also
module-private). This is a small, deliberate duplication rather than a `core` export-surface
change — six lines of Zod, not worth reopening a sealed package's public API for.

### Per-line cache key scheme (`render.ts`)

Directly modeled on `raster-cache.ts`'s content-hash approach (`text.ts`'s `contentHash` —
plain string-join, not cryptographic, since `Map` keys only need uniqueness/stability):

```ts
function lineKey(tokens: Token[], fontSize: number, theme: string, dimmed: boolean, lineWidthPx: number): string {
  return [
    theme, fontSize, dimmed, Math.round(lineWidthPx),
    tokens.map((t) => `${t.text} ${t.color} ${t.fontStyle}`).join(""),
  ].join("|");
}
```

Deliberately **excludes** line index and layer key — two lines with identical tokens/state (a
repeated `}` closing line, or two layers showing the same snippet) share one cache entry, same
as `text.ts`'s existing "two layers with identical text/font/color share one cached bitmap"
comment (`text.ts:74-76`). The cache instance itself (`createLineCache(limitBytes)`) is
package-private to `layer-code`, sized independently from `renderer-canvas`'s own
`RasterCache` (a fresh `Renderer` per process still gets its own line cache — no cross-process
or cross-`Renderer` sharing, matching `002`'s existing per-`Renderer` cache lifetime).

Chrome cache key: `[width, height, theme, title ?? "", showLineNumbers].join("|")` — one entry
per distinct chrome configuration, painted once (rounded background + border + title bar text +
traffic-light dots), blitted every frame underneath the line bitmaps.

### `paintCodeLayer` (`render.ts`)

```ts
export class CodeOverflowError extends Error {}

export function paintCodeLayer(
  entry: CompiledCodeLayer,          // { ir: TokenizedCode; layout: LayoutResult; blocked: boolean }
  layer: CodeLayer,
  frameLocal: number,
  fps: number,
  lineCache: LineCache,
  chromeCache: ChromeCache
): Canvas {
  if (entry.blocked) throw new CodeOverflowError("cannot render an overflowing code block — see compile-time diagnostics");

  const chrome = chromeCache.getOrRender(chromeKey(layer), layer.width, layer.height, paintChrome(layer));
  const canvas = createCanvas(layer.width, layer.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(chrome, 0, 0);

  const focus = layer.focus ? focusState(layer.focus, frameLocal, fps) : undefined;
  const scrollPx = layer.scroll ? scrollOffsetPx(layer.scroll, frameLocal, fps, entry.layout.lineHeightPx) : 0;
  const reveal = layer.reveal?.mode === "typewriter"
    ? typewriterState(layer.reveal, frameLocal, fps, entry.layout.lineCharCounts)
    : { revealedLines: entry.ir.lines.length, partialLineChars: 0, caretOn: false };

  for (let i = 0; i < reveal.revealedLines; i++) {
    const dimmed = focus ? (i + 1 < focus.range[0] || i + 1 > focus.range[1]) : false;
    const key = lineKey(entry.ir.lines[i].tokens, effectiveFontSize, layer.theme ?? "github-dark", dimmed, entry.layout.contentWidthPx);
    const bitmap = lineCache.getOrRender(key, entry.layout.contentWidthPx, entry.layout.lineHeightPx,
      paintLine(entry.ir.lines[i].tokens, dimmed ? (layer.focus?.dimOpacity ?? 0.35) : 1));
    ctx.drawImage(bitmap, gutterWidthPx, i * entry.layout.lineHeightPx - scrollPx);
  }
  if (reveal.partialLineChars > 0) {
    paintPartialLine(ctx, entry.ir.lines[reveal.revealedLines]?.tokens ?? [], reveal.partialLineChars,
      gutterWidthPx, reveal.revealedLines * entry.layout.lineHeightPx - scrollPx);   // never cached — FR8
  }
  if (reveal.caretOn) paintCaret(ctx, /* x from reveal.partialLineChars * advanceWidth */, /* y */);
  for (const a of layer.annotations ?? []) {
    const pos = annotationPosition(a, entry.layout);
    paintAnnotation(ctx, a, pos, scrollPx);
  }
  return canvas;
}
```

`paintLine`/`paintChrome`/`paintPartialLine`/`paintCaret`/`paintAnnotation` are small internal
paint-closure helpers (each returns a `(ctx) => void` for `getOrRender`, matching `draw-shapes
.ts`'s `paintRectLayer` shape exactly). `dimOpacity`'s alpha-blend (spec.md's resolved Open
Question #5) is applied inside `paintLine`'s closure via `ctx.globalAlpha = dimmed ? dimOpacity :
1` before each token's `fillText` — a straight sRGB composite over whatever the chrome bitmap
already painted at that position (drawn first, underneath), not a pre-computed blended colour
value.

### `TimelineLayer.layer` narrowing (no `@claudevid/core` type change)

`core.Layer` (`packages/core/src/layers.ts:95`, `TextLayer | RectLayer | ImageLayer |
GroupLayer`) is a closed static union — `registerLayer`'s own comment describes itself as
extending the **runtime** Zod union only (`packages/core/src/layers.ts:117`: "Extends the layer
union without editing this file"). `@claudevid/layer-code` does not reopen `core`'s `Layer`
type. Instead:

```ts
export function isCodeLayer(layer: { type: string }): layer is CodeLayer {
  return layer.type === "code";
}
```

`render.ts`'s painter entry point receives `timelineLayer.layer` typed as `core.Layer`, checks
`isCodeLayer`, and narrows via an `as CodeLayer` cast inside the guard's `true` branch — the one
place in this package that crosses the static-type gap between core's closed union and
layer-code's own `CodeLayer` type. This is the same structural gap `registerLayer`'s own design
already accepted (a registered runtime schema has no corresponding static union member in
`core`) — documented here rather than "fixed" by editing a sealed package's public type.

## File Changes Map

| File | Action | Description |
|------|--------|-------------|
| `packages/layer-code/package.json` | create | deps: core, renderer-canvas, motion (workspace), `shiki` |
| `packages/layer-code/tsup.config.ts` | create | ESM build |
| `packages/layer-code/vitest.config.ts` | create | test runner |
| `packages/layer-code/tsconfig.json` | create | extends root base |
| `packages/layer-code/src/schema.ts` | create | `CodeLayer` zod schema + type, `registerLayer("code", ...)` |
| `packages/layer-code/src/themes.ts` | create | `BUNDLED_THEMES`, `checkThemeContrast()` |
| `packages/layer-code/src/highlight.ts` | create | Shiki singleton, `compileCodeLayers()` |
| `packages/layer-code/src/layout.ts` | create | `measureLine`, wrap, fit-to-width, `computeAvailableLines` |
| `packages/layer-code/src/diagnostics.ts` | create | all `Diagnostic` construction for this package |
| `packages/layer-code/src/diff.ts` | create | `diffLines()` — pure LCS line diff |
| `packages/layer-code/src/animations.ts` | create | `typewriterState`/`lineStaggerDelays`/`focusState`/`scrollOffsetPx` |
| `packages/layer-code/src/annotate.ts` | create | `annotationPosition()` |
| `packages/layer-code/src/render.ts` | create | per-line cache, chrome cache, `paintCodeLayer`, `CodeOverflowError` |
| `packages/layer-code/src/index.ts` | create | public exports; `registerLayer`/`registerPainter` side effects |
| `packages/layer-code/test/*.test.ts` | create | 10 test files per Architecture |
| `packages/renderer-canvas/src/painters.ts` | create | `registerPainter(type, paint)` / `getPainter(type)` |
| `packages/renderer-canvas/src/index.ts` | modify | `default` case in the per-layer switch consults `getPainter()` |
| `packages/renderer-canvas/test/painters.test.ts` | create | registry get/set + unknown-type no-op |

Note: the proposal's own impact estimate ("~16 new") is exceeded here (14 `layer-code` src
files + 10 test files + 3 `renderer-canvas` files = 27) — almost entirely test-file granularity
(one file per numbered AC cluster, matching `003`'s own `test/` layout) plus the two small,
additive `renderer-canvas` files FR14 requires to make the layer actually renderable. No file
outside `packages/layer-code` and these two `renderer-canvas` files is touched.

## Data Model Changes

New types (all `@claudevid/layer-code`, none exported from `@claudevid/core`): `CodeLayer`,
`CodeReveal`, `CodeFocus`, `CodeDiff`, `CodeScroll`, `CodeAnnotation`, `TokenizedCode`, `Token`,
`LayoutResult`, `CompiledCodeLayer`, `DiffLine`. New types in `@claudevid/renderer-canvas`:
`PainterFn` (`(entry: unknown, timelineLayer: TimelineLayer, frame: number, ctx: SKRSContext2D)
=> void`-shaped — deliberately untyped-beyond-`unknown` on the entry parameter, since
`renderer-canvas` has no knowledge of `layer-code`'s `CompiledCodeLayer` shape; the registered
closure captures its own compiled-map lookup internally). No types in `@claudevid/core` or
`@claudevid/motion` change (NFR6).

## API Changes

New public exports from `@claudevid/layer-code`: `codeLayerSchema`, `CodeLayer` type,
`compileCodeLayers`, `TokenizedCode`/`Token` types, `diffLines`, `annotationPosition`,
`checkThemeContrast`, `BUNDLED_LANGS`/`BUNDLED_THEMES`, `paintCodeLayer`, `CodeOverflowError`,
`isCodeLayer`. Importing `@claudevid/layer-code`'s `index.ts` registers both the schema
(`registerLayer`) and the painter (`registerPainter`) as side effects — a caller only needs
`import "@claudevid/layer-code"` before its first `compileTimeline`/`renderFrame` call for a
`code` layer to work end-to-end.

`@claudevid/renderer-canvas` additions: `registerPainter`, `getPainter`, `PainterFn` type.
No existing export's signature changes.

## Key Decisions

1. **D1 — A separate, package-private line cache instance, not an extension of
   `renderer-canvas`'s shared `RasterCache`.** `createRasterCache` (`raster-cache.ts`) is
   already generic (`getOrRender(key, width, height, paint)` — no layer-type awareness), so it
   could in principle be imported and reused directly for line bitmaps. Rejected: sizing.
   `renderer-canvas`'s cache is sized once, for the whole render (`DEFAULT_CACHE_LIMIT_BYTES =
   512 * 1024 * 1024`, shared across every text/rect/image bitmap in the spec); a busy code
   walkthrough scene can easily contain more distinct line bitmaps than every other layer type
   combined, and giving lines their own budget means a code-heavy scene can't silently evict a
   frequently-reused `text` title bitmap it has nothing to do with. A second instance, created
   with `createRasterCache`'s own exported factory (imported, not re-implemented — the pattern
   is grounded in the same file) but a separate `Map`/byte-budget, gets isolation at the cost of
   a second (small) memory ceiling — a straightforward, explicit trade over silent cross-layer-
   type eviction pressure.
2. **D2 — No `Channel`/`PropertyBag` extension in `@claudevid/motion`; `animations.ts` is pure
   frame-in/state-out instead.** `003`'s own forward-compatibility note floated a `revealChars`
   channel. Rejected for this change: `Channel`/`Track`/`evaluate`/`compileMotion` are a sealed,
   verify-PASSed surface (`003: verify PASS — 12/12 ACs, 113 tests`) whose whole contract is "six
   free channels, nothing invalidating" (`003/spec.md`'s own Overview) — code's reveal/focus/
   diff/scroll state isn't a free channel in that sense (it drives *which cache entries get
   painted*, not a `ctx.transform`/`globalAlpha` bracket around an already-rendered bitmap), so
   forcing it through `Track`/`PropertyBag` would mean either inventing a 7th channel whose
   "cost class" is nothing like the other six, or bypassing the cost-class table's whole point.
   A pure `(frameLocal, fps, config) => state` function per animation (FR10) gets the same
   frame-purity/testability guarantee (`NFR4`, mirroring `003`'s `NFR2`) with zero coupling to
   `motion`'s internal registry, and reuses `resolveEasing`/`orderIndices` — the two pieces that
   generalize cleanly — directly.
3. **D3 — The renderer-integration wiring (`painters.ts`) is in-scope for this change, not
   deferred.** The proposal's file list doesn't mention `renderer-canvas` at all. Without some
   wiring, though, a `code` layer registered via `registerLayer` alone would schema-validate but
   never paint a pixel — `index.ts`'s existing dispatch `switch` has no `"code"` case and its
   `default` silently `continue`s (`index.ts:154-158`), the same silent-skip behavior it already
   uses for `"group"` and any future unregistered type. Shipping `layer-code` without this would
   mean AC14 (the end-to-end "it actually renders" proof `GOALS.md` implies every layer package
   needs) is unreachable. The registry shape (D3's `painters.ts`) is deliberately the smallest
   change that makes it reachable: additive, one new file, one `default`-branch edit, no
   existing signature touched — matching `003`'s own precedent for how to extend a sealed
   package's render loop (FR15 in `003`: "Existing call sites that omit this parameter are
   unaffected").
4. **D4 — `render.ts → renderer-canvas`, never `renderer-canvas → layer-code`.** The
   alternative wiring (renderer-canvas imports and calls `layer-code`'s paint function directly,
   the same way it already imports its own sibling `paintTextLayer`/`paintRectLayer`/
   `paintImageLayer`) was considered and rejected: `layer-code` needs `renderer-canvas`'s raster-
   cache pattern, bundled fonts, and canvas primitives, so the dependency edge already runs
   `layer-code → renderer-canvas`; a reverse import would create a cycle (a real one, not just
   an awkward one — `renderer-canvas`'s `package.json` would need `@claudevid/layer-code` as a
   dependency, and `layer-code`'s `package.json` would need `@claudevid/renderer-canvas`, and
   pnpm's workspace linker would refuse or silently miscompile it). The registry (D3) breaks the
   cycle: `renderer-canvas` never imports `layer-code`'s module at all, only a structurally-typed
   closure `layer-code` hands it at runtime via `registerPainter`.
5. **D5 — `lang`/`theme` are free strings validated by a diagnostic, not a Zod enum.** A Zod
   `z.enum([...])` violation produces a generic Zod issue message ("Invalid enum value.
   Expected 'typescript' | 'javascript' | ..., received 'cobol'") routed through `parseSpec`'s
   existing `suggestionFor` (`diagnostics.ts:18-31`), which has no case for `invalid_enum_value`
   and would return `suggestion: undefined` — a diagnostic with no actionable fix, the exact
   failure mode this whole change exists to prevent for code content. Validating at compile time
   in `highlight.ts` instead means `diagnostics.ts` can hand-author the message and suggestion
   (AC3: "lists all 8 bundled langs by name") the way `compileMotion`'s unknown-preset-name
   diagnostic already does (`003/design.md`'s `compile.ts` section).
6. **D6 — Alpha-blend-toward-background for dim, not a pre-blended colour value.** Baking the
   dimmed colour into each token at tokenize time (mutating `TokenizedCode`) was considered and
   rejected: it would need a second, dimmed copy of every line's `TokenizedCode` (doubling
   `compileCodeLayers`'s output size) and would hard-code the chrome background colour into the
   IR, breaking FR4's "plain, theme-agnostic IR" property. Applying `ctx.globalAlpha` at paint
   time instead (over the already-painted chrome background) keeps `TokenizedCode` themeless and
   reuses the one thing canvas already does for free — no colour-space math anywhere in this
   change (consistent with spec.md's resolved Open Question #5).

## Risks & Mitigations

- **Risk: Shiki's `createHighlighterCore` bundle, even fine-grained, meaningfully increases
  `layer-code`'s install size and cold-start relative to the rest of this workspace's packages
  (all previously zero-dependency beyond `@napi-rs/canvas`/Zod).** *Mitigation:* this is the
  explicit, accepted trade of Open Question #1's resolution (a one-time install cost, not a
  per-render one); AC13's standalone-package build/test check keeps this measurable and
  regression-visible per change, rather than silently growing.
- **Risk: the per-line cache (D1) doubles this render path's memory ceiling relative to a naive
  shared-cache design.** *Mitigation:* deliberate and bounded — `createLineCache`'s budget is a
  constructor parameter (same shape as `createRasterCache`'s `limitBytes`), sized independently
  and documented; AC7/AC8 verify the *hit-rate* claim the whole design exists for, not just that
  the cache exists.
- **Risk: the `painters.ts` registry (D3) is the one change to an already-verified, merged
  package (`002`).** *Mitigation:* scoped to exactly one new file plus one `default`-branch edit
  in `index.ts`'s existing `switch`; every other exported function and every existing dispatch
  case (`text`/`rect`/`image`/`group`) is untouched — `packages/renderer-canvas/test/
  painters.test.ts` (new) plus the existing `render.test.ts` suite re-run unmodified (AC13)
  verifies no regression to `002`'s or `003`'s own suites.
- **Risk: `layout.ts`'s auto-fit-then-overflow-diagnostic sequencing (FR6) is two guardrails
  layered on top of each other (width-fit retry, then line-count check) — getting the order
  wrong could let a line-count overflow through disguised as a successful width-fit at a tiny,
  unreadable font size.** *Mitigation:* the width-fit retry has its own hard floor (`12px`,
  FR6) independent of the line-count check, so the two guardrails compose rather than one
  silently absorbing the other — AC5's fixture is sized so the block only fails the line-count
  check (its lines fit width-wise at the default font size), keeping the two paths independently
  testable rather than conflated in one fixture.
