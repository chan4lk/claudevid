// End-to-end integration test (spec.md AC14): the full real pipeline —
//   parseSpec -> compileTimeline -> compileCodeLayers -> createRenderer().renderFrame
// — for a small, non-overflowing `code` layer, asserting zero diagnostics from either
// compile step (compileCodeLayers's tokenize diagnostics, and layout.ts/diagnostics.ts's
// `checkLayoutDiagnostics`) and a non-empty (meaningfully-painted) pixel buffer.
//
// This file (not any `src/` module) is "the calling pipeline" render.ts's own comments defer
// to for assembling a real `CompiledCodeLayer` (`ir` + `layout` + `blocked`) from
// `compileCodeLayers`'s plain `Map<layerKey, TokenizedCode>` output and `layoutCode`'s
// `LayoutResult`, and splicing it onto the `Timeline`'s `TimelineLayer.layer` so that
// `renderer-canvas`'s generic registry dispatch (`packages/renderer-canvas/src/index.ts`'s
// `default` switch branch, which hands the registered painter `layer.layer` itself as
// `entry` — see `paintCodeLayer`'s doc comment in `render.ts`) has a real compiled entry to
// paint from, not just the raw authored `CodeLayer`.
//
// Importing from `../src/index.js` (this package's own public surface, T11) — rather than a
// deeper relative path — is deliberate: it is what runs this package's module-load side
// effects (`registerLayer("code", ...)`, `registerPainter("code", paintCodeLayer)`) that make
// `parseSpec`/`compileTimeline` accept a `code` layer and `renderFrame` know how to paint one,
// exactly as AC14 requires ("with `@claudevid/layer-code` imported so its registration side
// effects have run").
import { describe, expect, it } from "vitest";
import { compileTimeline, parseSpec } from "@claudevid/core";
import type { TimelineLayer } from "@claudevid/core";
import { createFrameBuffer, createRenderer } from "@claudevid/renderer-canvas";
import { checkLayoutDiagnostics, compileCodeLayers, layoutCode, type CompiledCodeLayer } from "../src/index.js";
import type { CodeLayer } from "../src/schema.js";

const WIDTH = 1280;
const HEIGHT = 720;
// `DEFAULT_BACKGROUND` (`packages/renderer-canvas/src/index.ts`) — the scene below leaves
// `background` unset, so this is the opaque colour every unpainted pixel starts as.
const SCENE_BACKGROUND: [number, number, number, number] = [0, 0, 0, 255];

function codeSpec() {
  return {
    version: 1,
    width: WIDTH,
    height: HEIGHT,
    fps: 30,
    scenes: [
      {
        id: "scene-1",
        duration: 2,
        layers: [
          {
            type: "code",
            code: "const x = 1;\nconsole.log(x);",
            lang: "javascript",
            theme: "github-dark",
            width: 640,
            height: 360,
            x: 100,
            y: 100,
          },
        ],
      },
    ],
  };
}

describe("layer-code end-to-end integration (spec.md AC14)", () => {
  it("parseSpec -> compileTimeline -> compileCodeLayers -> renderFrame paints a code layer with zero diagnostics", async () => {
    // 1. parseSpec — the "code" layer type validates only because importing `../src/index.js`
    // above already ran `registerLayer("code", codeLayerSchema)` (T1) at module load.
    const parsed = parseSpec(codeSpec());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return; // narrows for TS; the assertion above already fails the test otherwise.

    // 2. compileTimeline — core's own compile step; no code-layer-specific diagnostics of its
    // own (FR13's diagnostics all live in this package), included here purely as the pipeline
    // AC14 names.
    const timeline = compileTimeline(parsed.spec);

    // 3. compileCodeLayers — spec.md FR3's tokenize/compile entry point (lang/theme
    // diagnostics live here).
    const { compiled, diagnostics: compileDiagnostics } = await compileCodeLayers(parsed.spec, timeline);
    expect(compileDiagnostics).toEqual([]);

    const codeTimelineLayer = timeline.layers.find((l) => l.type === "code");
    expect(codeTimelineLayer).toBeDefined();
    if (!codeTimelineLayer) return;

    const codeLayer = codeTimelineLayer.layer as unknown as CodeLayer;
    const ir = compiled.get(codeTimelineLayer.layerKey);
    expect(ir).toBeDefined();
    if (!ir) return;

    // Layout + overflow guardrail (spec.md FR5/FR6/FR13, layout.ts/diagnostics.ts) — the
    // second diagnostic-producing compile step AC14 requires zero diagnostics from.
    const sourceLines = codeLayer.code.split("\n");
    const layout = layoutCode(sourceLines, {
      width: codeLayer.width,
      height: codeLayer.height,
      fontSize: codeLayer.fontSize,
      tabSize: codeLayer.tabSize,
      wrap: codeLayer.wrap,
      showLineNumbers: codeLayer.showLineNumbers,
    });
    const { diagnostics: layoutDiagnostics, blocked } = checkLayoutDiagnostics(codeTimelineLayer.layerKey, layout, {
      maxLines: codeLayer.maxLines,
      hasScroll: Boolean(codeLayer.scroll),
    });
    expect(layoutDiagnostics).toEqual([]);
    expect(blocked).toBe(false);

    // Splice the compiled entry (ir + layout + blocked) onto the Timeline's own TimelineLayer
    // object, in place — `Timeline.activeAt`/`transitionAt` close over this same `layers`
    // array (`packages/core/src/timeline.ts`), so this mutation is visible to `renderFrame`
    // without rebuilding the Timeline. `renderer-canvas`'s generic dispatch branch hands the
    // registered painter this very object as both `timelineLayer.layer` (for `paintCodeLayer`'s
    // own `lang`/`theme`/`width`/`height`/... reads) and `entry` (for its `ir`/`layout`/
    // `blocked` reads) — see `paintCodeLayer`'s doc comment in `render.ts`.
    const compiledEntry: CompiledCodeLayer = { ir, layout, blocked };
    codeTimelineLayer.layer = { ...codeLayer, ...compiledEntry } as unknown as TimelineLayer["layer"];

    // 4. createRenderer().renderFrame — the actual paint call.
    const renderer = createRenderer(WIDTH, HEIGHT);
    const target = createFrameBuffer(WIDTH, HEIGHT);
    await renderer.renderFrame(timeline, 10, target);

    // Non-empty pixel buffer: at least one pixel differs from the opaque scene background
    // (mirrors `packages/renderer-canvas/test/render.test.ts`'s "Overall proof something was
    // painted at all" assertion style).
    let nonBackgroundCount = 0;
    for (let i = 0; i < target.data.length; i += 4) {
      if (
        target.data[i] !== SCENE_BACKGROUND[0] ||
        target.data[i + 1] !== SCENE_BACKGROUND[1] ||
        target.data[i + 2] !== SCENE_BACKGROUND[2] ||
        target.data[i + 3] !== SCENE_BACKGROUND[3]
      ) {
        nonBackgroundCount++;
      }
    }
    expect(nonBackgroundCount).toBeGreaterThan(0);

    // Narrower proof: within the code layer's own resolved chrome box (x/y + width/height),
    // at least one pixel differs from the scene background — the "github-dark" theme's chrome
    // background (`#24292e`, `themes.ts`) is distinct from the scene's default opaque black, so
    // this fails if the painter silently no-op'd (e.g. the registry dispatch never reached the
    // registered "code" painter) while still passing the loose "something, somewhere" check
    // above.
    const boxX0 = codeTimelineLayer.x;
    const boxY0 = codeTimelineLayer.y;
    const boxX1 = Math.min(WIDTH, boxX0 + codeLayer.width);
    const boxY1 = Math.min(HEIGHT, boxY0 + codeLayer.height);

    let foundInBox = false;
    for (let y = boxY0; y < boxY1 && !foundInBox; y++) {
      for (let x = boxX0; x < boxX1 && !foundInBox; x++) {
        const idx = (y * WIDTH + x) * 4;
        if (
          target.data[idx] !== SCENE_BACKGROUND[0] ||
          target.data[idx + 1] !== SCENE_BACKGROUND[1] ||
          target.data[idx + 2] !== SCENE_BACKGROUND[2]
        ) {
          foundInBox = true;
        }
      }
    }
    expect(foundInBox).toBe(true);
  });
});
