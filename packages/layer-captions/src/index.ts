// Public surface of `@claudevid/layer-captions` (design.md's Architecture / "API Changes"
// section). This is a T5 stub: `schema.ts`'s `registerLayer("captions", captionsLayerSchema)`
// (spec.md FR6) runs at module load via the re-export below, so a `captions` layer already
// parses through `@claudevid/core`'s `parseSpec`/`compileTimeline` (AC5's schema half).
//
// The painter side (`render.ts`'s `paintCaptionsLayer` + this file's own
// `registerPainter("captions", paintCaptionsLayer)` call, mirroring
// `packages/layer-code/src/index.ts`'s exact pattern) is T6, not yet implemented — a `captions`
// layer will schema-validate but not yet render until that task lands (see
// `packages/layer-code/src/index.ts`'s header comment for why the two registrations are
// separate calls).
export { captionsLayerSchema } from "./schema.js";
export type { CaptionsLayer } from "./schema.js";
