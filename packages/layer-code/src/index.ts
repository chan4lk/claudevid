// Public surface of `@claudevid/layer-code` (design.md's Architecture / "API Changes" section).
// Importing this module (directly, or transitively via any of the exports below) runs two
// side effects at module load, both required before a `code` layer renders end to end:
//   - `schema.ts`'s `registerLayer("code", codeLayerSchema)` (T1) — extends `@claudevid/core`'s
//     runtime layer union so `parseSpec`/`compileTimeline` accept a `type: "code"` layer.
//   - `render.ts`'s `registerPainter("code", paintCodeLayer)` (T11, below) — extends
//     `@claudevid/renderer-canvas`'s painter registry (`packages/renderer-canvas/src/painters.ts`,
//     T6) so `createRenderer().renderFrame` actually paints one. Without this second
//     registration a `code` layer would schema-validate but silently paint nothing (design.md Key
//     Decision D3) — `render.ts`'s own module doesn't self-register (a plain function export,
//     like every other file in this package), so this is the one call site that must run it.
// A caller only needs `import "@claudevid/layer-code"` (or any named import from it) before its
// first `compileTimeline`/`renderFrame` call for a `code` layer to work.
import { registerPainter } from "@claudevid/renderer-canvas";
import { paintCodeLayer } from "./render.js";

export {
  codeLayerSchema,
  BUNDLED_LANGS,
  BUNDLED_THEMES,
} from "./schema.js";
export type {
  CodeLayer,
  CodeReveal,
  CodeFocus,
  CodeDiff,
  CodeScroll,
  CodeAnnotation,
} from "./schema.js";

// `checkThemeContrast` (spec.md FR15/AC12) — the compile-time-only WCAG contrast auditor a
// caller (or a future `007` director-prompt catalogue, per spec.md's "Depended on by" note) can
// run against the bundled themes independently of any particular spec.
export { checkThemeContrast } from "./themes.js";
export type { BundledTheme } from "./themes.js";

// `compileCodeLayers` (spec.md FR3) — the named tokenizer/compiler entry point, plus its own
// plain-data IR types (FR4) a caller assembles a `CompiledCodeLayer` (below) from.
export { compileCodeLayers } from "./highlight.js";
export type { CompileCodeLayersResult, Token, TokenizedCode, TokenizedCodeLine } from "./highlight.js";

// `layout.ts`'s pure layout entry point + result shape (spec.md FR5/FR6/FR12) — a caller needs
// both this and `compileCodeLayers`'s `TokenizedCode` to assemble the `CompiledCodeLayer`
// `paintCodeLayer`/`renderCodeFrame` consume (render.ts's own header comment: "the calling
// pipeline's job, not this file's").
export { layoutCode } from "./layout.js";
export type { LayoutLine, LayoutOptions, LayoutResult } from "./layout.js";

// `diagnostics.ts` (spec.md FR13) — every `Diagnostic` builder this package uses, so a caller
// assembling its own `CompiledCodeLayer` (layout + overflow guardrails) can reuse the same
// fail-closed checks `render.ts`'s `CodeOverflowError` is the render-time half of.
export { checkLayoutDiagnostics } from "./diagnostics.js";

// `diff.ts` (spec.md FR11) — the pure LCS line diff primitive, independently useful to a caller
// (e.g. a future unified-diff-string parser, spec.md's "Open Questions, resolved" #2) beyond
// what `render.ts` uses it for internally.
export { diffLines } from "./diff.js";
export type { DiffLine } from "./diff.js";

// `annotate.ts` (spec.md FR12) — line-anchored callout positioning, independently useful to a
// caller that wants an annotation's pixel position without going through the full paint path.
export { annotationPosition } from "./annotate.js";
export type { AnnotationPosition } from "./annotate.js";

// `animations.ts` (spec.md FR10) — the pure frame-in/state-out primitives `render.ts` drives
// internally; exported so a caller (a future preview tool, a test, `007`'s director prompt) can
// query the same reveal/focus/scroll state `paintCodeLayer` itself computes, without
// reimplementing it.
export { typewriterState, lineStaggerDelays, focusState, scrollOffsetPx } from "./animations.js";
export type { TypewriterReveal, TypewriterState, FocusState } from "./animations.js";

// `render.ts` (spec.md FR7/FR8/FR9) — the render path itself: `paintCodeLayer` (the registered
// painter), `renderCodeFrame` (its cache-and-context-taking core, for a caller that wants to
// supply its own `LineCache`/`ChromeCache` instances rather than the module's lazy default
// pair), the cache factories/keys, and the `CodeOverflowError`/`isCodeLayer`/`CompiledCodeLayer`
// shapes a caller needs to assemble a compiled entry and check its own layer's type.
export {
  paintCodeLayer,
  renderCodeFrame,
  isCodeLayer,
  CodeOverflowError,
  createLineCache,
  createChromeCache,
  lineKey,
  chromeKey,
  DEFAULT_LINE_CACHE_LIMIT_BYTES,
  DEFAULT_CHROME_CACHE_LIMIT_BYTES,
} from "./render.js";
export type { CompiledCodeLayer, LineCache, ChromeCache, BitmapCache } from "./render.js";

// Side effect (T1, unconditionally imported above so it always runs) — `schema.ts` itself calls
// `registerLayer("code", codeLayerSchema)` at its own module load; re-exporting `codeLayerSchema`
// above already imports that module, so nothing further is needed here for that half.

// Side effect (T11): the second registration `schema.ts`'s own `registerLayer` call cannot
// perform itself — see this file's header comment.
registerPainter("code", paintCodeLayer);
