import { describe, expect, it } from "vitest";
import { compileTimeline } from "@claudevid/core";
import type { VideoSpec, Diagnostic } from "@claudevid/core";
import { compileMotion } from "../src/compile.js";
import { createResolver } from "../src/resolver.js";
import { _compileTracksForLayerForTests as compileTracksForLayer } from "../src/compile.js";

function makeSpec(overrides: Partial<VideoSpec> = {}): VideoSpec {
  return { version: 1, width: 1920, height: 1080, fps: 30, scenes: [], ...overrides };
}

describe("compileMotion", () => {
  it("resolves a preset for a single animated layer with no diagnostics", () => {
    const spec = makeSpec({
      scenes: [{ id: "s", duration: 2, layers: [{ type: "text", text: "hi", animation: { enter: "fade" } }] }],
    });
    const timeline = compileTimeline(spec);
    const { compiled, diagnostics } = compileMotion(spec, timeline);
    expect(diagnostics).toEqual([]);
    expect(compiled.size).toBe(1);
  });

  it("emits a diagnostic when an animation exceeds the layer's active interval, run against a real compileTimeline output (AC6)", () => {
    const spec = makeSpec({
      scenes: [
        { id: "s", duration: 0.2, layers: [{ type: "text", text: "hi", animation: { enter: "fade", duration: 5 } }] },
      ],
    });
    const timeline = compileTimeline(spec);
    const { diagnostics } = compileMotion(spec, timeline);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]!.message).toMatch(/exceeds the layer's active interval/);
  });

  it("emits a diagnostic for an unknown preset name — never a silent no-op", () => {
    const spec = makeSpec({
      scenes: [{ id: "s", duration: 1, layers: [{ type: "text", text: "hi", animation: { enter: "not-a-real-preset" } }] }],
    });
    const timeline = compileTimeline(spec);
    const { compiled, diagnostics } = compileMotion(spec, timeline);
    expect(compiled.size).toBe(0);
    expect(diagnostics[0]!.message).toMatch(/unknown preset/);
  });

  it("diagnoses animation.exit as unsupported rather than silently ignoring it", () => {
    const spec = makeSpec({
      scenes: [{ id: "s", duration: 1, layers: [{ type: "text", text: "hi", animation: { exit: "fade" } }] }],
    });
    const timeline = compileTimeline(spec);
    const { diagnostics } = compileMotion(spec, timeline);
    expect(diagnostics.some((d) => d.message.includes("exit animations are not supported"))).toBe(true);
  });

  it("diagnoses stagger set on a non-group layer instead of silently ignoring it", () => {
    const spec = makeSpec({
      scenes: [
        { id: "s", duration: 1, layers: [{ type: "text", text: "hi", animation: { enter: "fade", stagger: { each: 0.1 } } }] },
      ],
    });
    const timeline = compileTimeline(spec);
    const { diagnostics } = compileMotion(spec, timeline);
    expect(diagnostics.some((d) => d.message.includes("only meaningful on a group"))).toBe(true);
  });

  it("applies stagger to a group's children with increasing delay (FR10/FR11)", () => {
    const spec = makeSpec({
      scenes: [
        {
          id: "s",
          duration: 2,
          layers: [
            {
              type: "group",
              id: "g1",
              animation: { enter: "fade", stagger: { each: 0.1, from: "first" } },
              children: [
                { type: "text", text: "1" },
                { type: "text", text: "2" },
              ],
            },
          ],
        },
      ],
    });
    const timeline = compileTimeline(spec);
    const { compiled, diagnostics } = compileMotion(spec, timeline);
    expect(diagnostics).toEqual([]);
    expect(compiled.size).toBe(2); // the group's own entry never gets a compiled track list

    const childKeys = timeline.layers.filter((l) => l.type === "text").map((l) => l.layerKey);
    const resolver = createResolver(compiled, timeline);
    // Second child is delayed by 0.1s (3 frames @ 30fps) relative to the first: at frame 0 it
    // must still read exactly opacity 0 (not yet started), unlike the first child.
    expect(resolver.resolve(childKeys[1]!, 0)!.opacity).toBeCloseTo(0);
    expect(resolver.resolve(childKeys[1]!, 3)).toBeDefined();
  });

  it("does not apply stagger delay to a group's own (never-painted) entry", () => {
    const spec = makeSpec({
      scenes: [
        {
          id: "s",
          duration: 2,
          layers: [
            {
              type: "group",
              id: "g1",
              animation: { enter: "fade" },
              children: [{ type: "text", text: "1" }],
            },
          ],
        },
      ],
    });
    const timeline = compileTimeline(spec);
    const { compiled } = compileMotion(spec, timeline);
    const groupKey = timeline.layers.find((l) => l.type === "group")!.layerKey;
    expect(compiled.has(groupKey)).toBe(false);
  });
});

describe("compileMotion — unsettled spring diagnostic (AC4, via the internal per-layer compiler)", () => {
  it("emits a diagnostic instead of silently truncating an unsettled spring", () => {
    const compiled = new Map();
    const diagnostics: Diagnostic[] = [];
    compileTracksForLayer(
      [{ property: "opacity", from: 0, to: 1, duration: 1, easing: { stiffness: 1, damping: 0.001, mass: 1 } }],
      { layerKey: "x", startFrame: 0, endFrame: 300 } as any,
      30,
      compiled,
      diagnostics
    );
    expect(diagnostics.some((d) => d.message.includes("did not settle"))).toBe(true);
    expect(compiled.size).toBe(0);
  });
});
