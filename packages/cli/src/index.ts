// Library facade for the published `claudevid` package (the CLI's `bin` entry is `cli.ts`;
// this is the `import` entry). Consumers outside this monorepo cannot depend on the individual
// `@claudevid/*` workspace packages — they are all `private: true` and cross-reference each
// other with `workspace:*` — so this module is the one public surface, and the packaging step
// bundles every workspace package into it.
//
// `@claudevid/core` is re-exported flat because it is the API most callers actually touch
// (`parseSpec`, `compileTimeline`, the `VideoSpec` types). Everything else is namespaced: the
// packages genuinely collide (both `@claudevid/motion` and `@claudevid/renderer-canvas` export
// a `MotionResolver`, and several export their own `Diagnostic`-adjacent helpers), so a flat
// `export *` would either shadow silently or fail to compile.

export * from "@claudevid/core";

export * as motion from "@claudevid/motion";
export * as renderer from "@claudevid/renderer-canvas";
export * as encoder from "@claudevid/encoder-ffmpeg";
export * as audio from "@claudevid/audio";
export * as layerCode from "@claudevid/layer-code";
export * as layerCaptions from "@claudevid/layer-captions";

// Importing these two for their `registerLayer`/`registerPainter` side effects is what makes a
// `type: "code"` / `type: "captions"` layer parse and paint (see `cli.ts`'s own header note).
// A consumer calling `renderVideo` must never have to know that; the side effects run here, at
// import time, exactly as they do for the CLI.
import "@claudevid/layer-code";
import "@claudevid/layer-captions";

/** The whole pipeline in one call: narration synthesis, timeline compilation, motion and
 * `code`-layer compilation, frame rendering, encoding, and the audio mux. This is what
 * `claudevid render` itself runs. */
export { runRenderPipeline as renderVideo } from "./render-pipeline.js";
export type { RenderPipelineOptions } from "./render-pipeline.js";
