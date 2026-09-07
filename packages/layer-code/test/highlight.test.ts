// T12: full AC1/AC2/AC3 coverage (plus the "distinct theme" dedupe-boundary edge case), on top of
// T3's own minimal sanity coverage below.
import { describe, expect, it, vi } from "vitest";
import { compileTimeline } from "@claudevid/core";
import type { Layer, VideoSpec } from "@claudevid/core";
import { compileCodeLayers, _getHighlighterCoreForTests } from "../src/highlight.js";
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

  // AC2's literal claim: "a spy on the internal Shiki tokenize call records exactly one
  // invocation for that triple across both layers" — the reference-equality test above is a
  // strong proxy, but this spies on the highlighter's own `codeToTokensBase` directly, per AC2's
  // exact wording.
  it("AC2 — a spy on the highlighter's codeToTokensBase records exactly one call for a shared (code, lang, theme) triple", async () => {
    const highlighter = await _getHighlighterCoreForTests();
    const spy = vi.spyOn(highlighter, "codeToTokensBase");
    try {
      const spec = makeSpec({
        scenes: [{ id: "s", duration: 1, layers: [codeLayer(), codeLayer(), codeLayer()] }],
      });
      const timeline = compileTimeline(spec);
      const { compiled, diagnostics } = await compileCodeLayers(spec, timeline);

      expect(diagnostics).toEqual([]);
      expect(compiled.size).toBe(3);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  // Edge Case: "Two code layers with the same code/lang but different theme: tokenization is
  // per-(code, lang, theme) triple, so this is correctly two cache entries, not incorrectly
  // deduped to one."
  it("does not dedupe two layers sharing (code, lang) but with different themes", async () => {
    const spec = makeSpec({
      scenes: [
        {
          id: "s",
          duration: 1,
          layers: [codeLayer({ theme: "github-dark" }), codeLayer({ theme: "github-light" })],
        },
      ],
    });
    const timeline = compileTimeline(spec);
    const { compiled, diagnostics } = await compileCodeLayers(spec, timeline);

    expect(diagnostics).toEqual([]);
    expect(compiled.size).toBe(2);
    const [a, b] = [...compiled.values()];
    expect(a).not.toBe(b); // distinct cache entries — not deduped across themes
    // Prove the difference is real content, not just two references to equal data: github-dark
    // and github-light use different token colour palettes for the same source.
    expect(a!.lines[0]!.tokens[0]!.color).not.toBe(b!.lines[0]!.tokens[0]!.color);
  });
});

// Regression: `diagnostics.ts`'s `focusLinesOutOfRangeDiagnostic`/`scrollToLineOutOfRangeDiagnostic`/
// `annotationLineOutOfRangeDiagnostic` builders existed but nothing in the real compile path ever
// called them — `compileCodeLayers` only tokenized, it never ran `layout.ts`/`checkLayoutDiagnostics`
// against a layer's `focus`/`scroll`/`annotations`. These prove the checks are now reachable from a
// real spec through `compileCodeLayers` itself (spec.md FR12/FR13, Edge Cases: "a diagnostic, never
// silently clamped"), not only from a unit test calling a diagnostic builder directly. `codeLayer()`'s
// default `code` is two lines ("const x = 1;" / "console.log(x);"), so the valid line range is [1, 2].
describe("compileCodeLayers — out-of-range focus/scroll/annotation line diagnostics (spec.md FR12/FR13, Edge Cases)", () => {
  it("diagnoses an out-of-range focus.lines entry", async () => {
    const spec = makeSpec({
      scenes: [{ id: "s", duration: 1, layers: [codeLayer({ focus: { lines: [1, 5] } })] }],
    });
    const timeline = compileTimeline(spec);
    const { compiled, diagnostics } = await compileCodeLayers(spec, timeline);

    expect(compiled.size).toBe(1); // tokenization still succeeds — this is a layout-level diagnostic
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.path).toBe("/scenes/0/layers/0/focus/lines");
    expect(diagnostics[0]!.message).toMatch(/5/);
    expect(diagnostics[0]!.message).toMatch(/1, 2/);
  });

  it("diagnoses an out-of-range scroll.toLine entry", async () => {
    const spec = makeSpec({
      scenes: [{ id: "s", duration: 1, layers: [codeLayer({ scroll: { toLine: 99, duration: 1 } })] }],
    });
    const timeline = compileTimeline(spec);
    const { compiled, diagnostics } = await compileCodeLayers(spec, timeline);

    expect(compiled.size).toBe(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.path).toBe("/scenes/0/layers/0/scroll/toLine");
    expect(diagnostics[0]!.message).toMatch(/99/);
  });

  it("diagnoses an out-of-range scroll.fromLine entry", async () => {
    const spec = makeSpec({
      scenes: [
        { id: "s", duration: 1, layers: [codeLayer({ scroll: { toLine: 2, fromLine: 42, duration: 1 } })] },
      ],
    });
    const timeline = compileTimeline(spec);
    const { compiled, diagnostics } = await compileCodeLayers(spec, timeline);

    expect(compiled.size).toBe(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.path).toBe("/scenes/0/layers/0/scroll/fromLine");
    expect(diagnostics[0]!.message).toMatch(/42/);
  });

  it("diagnoses an out-of-range annotations[].line entry", async () => {
    const spec = makeSpec({
      scenes: [
        {
          id: "s",
          duration: 1,
          layers: [codeLayer({ annotations: [{ line: 1, text: "ok" }, { line: 99, text: "bad" }] })],
        },
      ],
    });
    const timeline = compileTimeline(spec);
    const { compiled, diagnostics } = await compileCodeLayers(spec, timeline);

    expect(compiled.size).toBe(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.path).toBe("/scenes/0/layers/0/annotations/1/line");
    expect(diagnostics[0]!.message).toMatch(/99/);
  });
});
