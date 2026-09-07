// The fixed reference `VideoSpec` `bench.ts` renders/encodes (spec.md FR11/AC13, design.md's
// `tools/bench/src/bench.ts` section). Deliberately SHORT — a couple of scenes at 1080p30
// totalling `REFERENCE_DURATION_SECONDS` seconds — NOT the full 30-minute duration the
// documented `<15/<10/<5`min targets describe (that real-hardware run is deferred, per spec.md
// Notes' "Bench finding"). `bench.ts` scales those targets down to this spec's own duration
// when reporting rather than comparing against them literally.
//
// Kept to `text`/`rect` layers only — no `@claudevid/motion` (animation resolution) and no
// `@claudevid/layer-code` (the `code` layer type from change 004) — so this package's only
// dependencies beyond `@claudevid/core` are `@claudevid/renderer-canvas` and this change's own
// `@claudevid/encoder-ffmpeg` (design.md: "the only consumer of the render stack" in this
// change), not the rest of the layer/motion ecosystem a benchmark harness has no need of.

import type { VideoSpec } from "@claudevid/core";

const SCENE_DURATION_SECONDS = 5;

/** Total wall-clock length of `referenceSpec()`'s timeline — two scenes at
 * `SCENE_DURATION_SECONDS` each, e.g. 10s at 1080p30 (spec.md AC13's example). */
export const REFERENCE_DURATION_SECONDS = SCENE_DURATION_SECONDS * 2;

/** Builds a fresh reference `VideoSpec` — a title-card scene and a body scene, each with one
 * `rect` and one `text` layer. Exercises the real render pipeline (background fill, rect
 * painting, text layout/painting, per-scene layer flattening) without needing motion, code, or
 * image assets. */
export function referenceSpec(): VideoSpec {
  return {
    version: 1,
    width: 1920,
    height: 1080,
    fps: 30,
    background: "#101020",
    scenes: [
      {
        id: "title",
        duration: SCENE_DURATION_SECONDS,
        layers: [
          {
            type: "rect",
            x: "center",
            y: "center",
            width: 900,
            height: 360,
            fill: "#2a6df4",
            radius: 24,
          },
          {
            type: "text",
            x: "center",
            y: "center",
            text: "claudevid bench",
            fontSize: 72,
            color: "#ffffff",
            align: "center",
          },
        ],
      },
      {
        id: "body",
        duration: SCENE_DURATION_SECONDS,
        layers: [
          {
            type: "rect",
            x: 120,
            y: 120,
            width: 640,
            height: 320,
            fill: "#f4762a",
          },
          {
            type: "text",
            x: "center",
            y: 880,
            text: "reference render — encoder-ffmpeg bench",
            fontSize: 48,
            color: "#ffffff",
            align: "center",
          },
        ],
      },
    ],
  };
}
