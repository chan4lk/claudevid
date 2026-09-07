// Minimal sanity coverage for T3's own implementation (compiles and runs end-to-end). Full,
// exhaustive AC verification (AC1/AC2/AC3 and their edge cases) is a later task's job (T12) —
// this file only proves `compileCodeLayers` tokenizes, dedupes, and diagnoses without throwing.
import { describe, expect, it } from "vitest";
import { compileTimeline } from "@claudevid/core";
import type { Layer, VideoSpec } from "@claudevid/core";
import { compileCodeLayers } from "../src/highlight.js";
import "../src/schema.js"; // side effect: registers the "code" layer type

function makeSpec(overrides: Partial<VideoSpec> = {}): VideoSpec {
  return { version: 1, width: 1920, height: 1080, fps: 30, scenes: [], ...overrides };
}

// `Layer` (`@claudevid/core`) is a closed static union with no "code" member — `registerLayer`
// only extends the runtime Zod union, so a plain `code`-typed layer literal needs the same cast
// `highlight.ts` itself documents for this structural gap (design.md).
function codeLayer(overrides: Record<string, unknown> = {}): Layer {
  return {
    type: "code",
    code: "const x = 1;\nconsole.log(x);",
    lang: "typescript",
    width: 800,
    height: 400,
    ...overrides,
  } as unknown as Layer;
}

describe("compileCodeLayers", () => {
  it("tokenizes a single code layer into a plain, JSON-round-trippable TokenizedCode", async () => {
    const spec = makeSpec({ scenes: [{ id: "s", duration: 1, layers: [codeLayer()] }] });
    const timeline = compileTimeline(spec);
    const { compiled, diagnostics } = await compileCodeLayers(spec, timeline);

    expect(diagnostics).toEqual([]);
    expect(compiled.size).toBe(1);
    const ir = [...compiled.values()][0]!;
    expect(ir.lines.length).toBe(2);
    expect(ir.lines[0]!.tokens.length).toBeGreaterThan(0);
    for (const line of ir.lines) {
      for (const token of line.tokens) {
        expect(typeof token.text).toBe("string");
        expect(typeof token.color).toBe("string");
        expect(typeof token.fontStyle).toBe("number");
      }
    }
    expect(JSON.parse(JSON.stringify(ir))).toEqual(ir);
  });

  it("dedupes tokenization across two layers sharing the same (code, lang, theme)", async () => {
    const spec = makeSpec({
      scenes: [{ id: "s", duration: 1, layers: [codeLayer(), codeLayer()] }],
    });
    const timeline = compileTimeline(spec);
    const { compiled, diagnostics } = await compileCodeLayers(spec, timeline);

    expect(diagnostics).toEqual([]);
    expect(compiled.size).toBe(2);
    const [a, b] = [...compiled.values()];
    expect(a).toBe(b); // identical cached TokenizedCode reference — one tokenize call, not two
  });

  it("emits a diagnostic listing the bundled langs for an unsupported lang, never throws", async () => {
    const spec = makeSpec({
      scenes: [{ id: "s", duration: 1, layers: [codeLayer({ lang: "cobol" })] }],
    });
    const timeline = compileTimeline(spec);
    const { compiled, diagnostics } = await compileCodeLayers(spec, timeline);

    expect(compiled.size).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.path).toBe("/scenes/0/layers/0/lang");
    expect(diagnostics[0]!.suggestion).toMatch(/typescript/);
    expect(diagnostics[0]!.suggestion).toMatch(/yaml/);
  });

  it("emits a diagnostic for an unsupported theme rather than throwing", async () => {
    const spec = makeSpec({
      scenes: [{ id: "s", duration: 1, layers: [codeLayer({ theme: "solarized" })] }],
    });
    const timeline = compileTimeline(spec);
    const { compiled, diagnostics } = await compileCodeLayers(spec, timeline);

    expect(compiled.size).toBe(0);
    expect(diagnostics[0]!.message).toMatch(/unsupported theme/);
    expect(diagnostics[0]!.suggestion).toMatch(/github-dark/);
  });

  it("resolves the 'bash' spec id against Shiki's own 'shellscript' grammar id", async () => {
    const spec = makeSpec({
      scenes: [{ id: "s", duration: 1, layers: [codeLayer({ lang: "bash", code: "echo hi" })] }],
    });
    const timeline = compileTimeline(spec);
    const { compiled, diagnostics } = await compileCodeLayers(spec, timeline);

    expect(diagnostics).toEqual([]);
    expect(compiled.size).toBe(1);
  });
});
