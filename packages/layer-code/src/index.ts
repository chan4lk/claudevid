// Later waves add `themes.ts`, `highlight.ts`, `layout.ts`, `diagnostics.ts`, `diff.ts`,
// `animations.ts`, `annotate.ts`, and `render.ts` exports here, plus the side-effecting
// `registerPainter("code", paintCodeLayer)` call (design.md's Architecture). For now this is a
// stub that only re-exports the schema module (T1's scope).
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
