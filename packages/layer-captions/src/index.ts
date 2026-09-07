// Public surface of `@claudevid/layer-captions` (design.md's Architecture / "API Changes"
// section). Importing this module (directly, or transitively via any of the exports below) runs
// two side effects at module load, both required before a `captions` layer renders end to end:
//   - `schema.ts`'s `registerLayer("captions", captionsLayerSchema)` (T5) — extends
//     `@claudevid/core`'s runtime layer union so `parseSpec`/`compileTimeline` accept a
//     `type: "captions"` layer.
//   - `render.ts`'s `registerPainter("captions", paintCaptionsLayer)` (T6, below) — extends
//     `@claudevid/renderer-canvas`'s painter registry (`packages/renderer-canvas/src/painters.ts`)
//     so `createRenderer().renderFrame` actually paints one. Without this second registration a
//     `captions` layer would schema-validate but silently paint nothing (mirrors
//     `packages/layer-code/src/index.ts`'s own Key Decision D3 note) — `render.ts`'s own module
//     doesn't self-register (a plain function export, like every other file in this package), so
//     this is the one call site that must run it.
// A caller only needs `import "@claudevid/layer-captions"` (or any named import from it) before
// its first `compileTimeline`/`renderFrame` call for a `captions` layer to work.
import { registerPainter } from "@claudevid/renderer-canvas";
import { paintCaptionsLayer } from "./render.js";

export { captionsLayerSchema } from "./schema.js";
export type { CaptionsLayer } from "./schema.js";

// `render.ts` (spec.md FR6; design.md Key Decision D7) — the render path itself: the registered
// painter, its pure active-word lookup helper (independently useful to a caller — a future
// preview tool, a test — that wants the same "what word is active right now" answer without
// going through a full canvas paint), and the `isCaptionsLayer` guard a caller needs to narrow
// `TimelineLayer.layer` to `CaptionsLayer` itself.
export { paintCaptionsLayer, findActiveWordIndex, isCaptionsLayer } from "./render.js";

// Side effect (T5, unconditionally imported above so it always runs) — `schema.ts` itself calls
// `registerLayer("captions", captionsLayerSchema)` at its own module load; re-exporting
// `captionsLayerSchema` above already imports that module, so nothing further is needed here for
// that half.

// Side effect (T6): the second registration `schema.ts`'s own `registerLayer` call cannot
// perform itself — see this file's header comment.
registerPainter("captions", paintCaptionsLayer);
