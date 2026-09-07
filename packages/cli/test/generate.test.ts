// `claudevid generate` tests (spec.md FR5). Every external effect (Anthropic call, disk I/O,
// render pipeline) is an injected fake — no real network access, no real filesystem (mirrors
// test/validate.test.ts's dependency-injection style).

import { describe, expect, it, vi } from "vitest";

import type { VideoSpec } from "@claudevid/core";
import type { CatalogueEntry } from "@claudevid/motion";
import type { GenerateResult } from "@claudevid/claude";

import type { runRenderPipeline as RunRenderPipeline } from "../src/render-pipeline.js";

import {
  parseGenerateArgs,
  slugify,
  runGenerate,
  DEFAULT_MODEL_ID,
  type GenerateDeps,
} from "../src/commands/generate.js";
import { ArgError } from "../src/args.js";

const FAKE_SPEC: VideoSpec = {
  version: 1,
  width: 1920,
  height: 1080,
  fps: 30,
  scenes: [
    {
      id: "intro",
      duration: 3,
      layers: [{ type: "text", text: "Hello", x: "center", y: "center" }],
    },
  ],
};

function baseDeps(overrides: Partial<GenerateDeps> = {}): GenerateDeps {
  return {
    apiKeyEnv: { ANTHROPIC_API_KEY: "sk-test" },
    generateSpec: vi.fn(async (): Promise<GenerateResult> => ({ spec: FAKE_SPEC, attempts: 2 })),
    buildDirectorPrompt: vi.fn(() => "system prompt"),
    exportCatalogue: (): CatalogueEntry[] => [],
    bundledLangs: ["ts"],
    bundledThemes: ["github-dark"],
    config: {},
    writeFile: vi.fn(),
    ...overrides,
  };
}

describe("parseGenerateArgs (FR5)", () => {
  it("throws ArgError when the prompt is missing", () => {
    expect(() => parseGenerateArgs([])).toThrow(ArgError);
  });

  it("parses the prompt plus --render, --model, --out, --repair-attempts", () => {
    const args = parseGenerateArgs([
      "Explain closures",
      "--render",
      "--model",
      "claude-x",
      "--out",
      "specs/closures.json",
      "--repair-attempts",
      "5",
    ]);

    expect(args).toEqual({
      prompt: "Explain closures",
      outPath: "specs/closures.json",
      render: true,
      model: "claude-x",
      repairAttempts: 5,
    });
  });

  it("defaults render to false and leaves optional fields undefined", () => {
    const args = parseGenerateArgs(["Explain closures"]);

    expect(args.render).toBe(false);
    expect(args.model).toBeUndefined();
    expect(args.outPath).toBeUndefined();
    expect(args.repairAttempts).toBeUndefined();
  });

  it("rejects a non-positive-integer --repair-attempts", () => {
    expect(() => parseGenerateArgs(["p", "--repair-attempts", "0"])).toThrow(ArgError);
    expect(() => parseGenerateArgs(["p", "--repair-attempts", "abc"])).toThrow(ArgError);
  });
});

describe("slugify (FR5)", () => {
  it("lowercases and replaces non-alphanumerics with hyphens", () => {
    expect(slugify("Explain React Server Components!")).toBe("explain-react-server-components");
  });

  it("collapses repeated separators and trims leading/trailing hyphens", () => {
    expect(slugify("  ---Hello   World---  ")).toBe("hello-world");
  });

  it("truncates long prompts to a reasonable length with no trailing hyphen", () => {
    const long = "a".repeat(30) + " " + "b".repeat(30);
    const slug = slugify(long);

    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("runGenerate (FR5)", () => {
  it("fails fast without calling generateSpec when ANTHROPIC_API_KEY is unset", async () => {
    const deps = baseDeps({ apiKeyEnv: {} });

    const result = await runGenerate({ prompt: "hi", render: false }, deps);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("ANTHROPIC_API_KEY");
    expect(deps.generateSpec).not.toHaveBeenCalled();
  });

  it("fails fast when ANTHROPIC_API_KEY is an empty string", async () => {
    const deps = baseDeps({ apiKeyEnv: { ANTHROPIC_API_KEY: "" } });

    const result = await runGenerate({ prompt: "hi", render: false }, deps);

    expect(result.ok).toBe(false);
    expect(deps.generateSpec).not.toHaveBeenCalled();
  });

  it("writes the generated spec as valid JSON on success and reports attempts", async () => {
    const deps = baseDeps();

    const result = await runGenerate({ prompt: "Explain hooks", render: false }, deps);

    expect(result.ok).toBe(true);
    expect(result.outPath).toBe("specs/explain-hooks.json");
    expect(result.message).toContain("specs/explain-hooks.json");
    expect(result.message).toContain("2 attempts");

    expect(deps.writeFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContent] = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(writtenPath).toBe("specs/explain-hooks.json");
    expect(JSON.parse(writtenContent as string)).toEqual(FAKE_SPEC);
  });

  it("uses the explicit --out path when given", async () => {
    const deps = baseDeps();

    const result = await runGenerate({ prompt: "Explain hooks", outPath: "custom/out.json", render: false }, deps);

    expect(result.outPath).toBe("custom/out.json");
  });

  it("resolves the model as args.model, then config.model, then the default constant", async () => {
    const deps = baseDeps({ config: { model: "config-model" } });

    await runGenerate({ prompt: "p", render: false, model: "cli-model" }, deps);
    expect((deps.generateSpec as ReturnType<typeof vi.fn>).mock.calls[0]![1].model).toBe("cli-model");

    const deps2 = baseDeps({ config: { model: "config-model" } });
    await runGenerate({ prompt: "p", render: false }, deps2);
    expect((deps2.generateSpec as ReturnType<typeof vi.fn>).mock.calls[0]![1].model).toBe("config-model");

    const deps3 = baseDeps();
    await runGenerate({ prompt: "p", render: false }, deps3);
    expect((deps3.generateSpec as ReturnType<typeof vi.fn>).mock.calls[0]![1].model).toBe(DEFAULT_MODEL_ID);
  });

  it("returns ok:false with the thrown error's message when generateSpec rejects", async () => {
    const deps = baseDeps({
      generateSpec: vi.fn(async () => {
        throw new Error("generation failed after 3 attempts: []");
      }),
    });

    const result = await runGenerate({ prompt: "hi", render: false }, deps);

    expect(result.ok).toBe(false);
    expect(result.message).toBe("generation failed after 3 attempts: []");
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it("calls runRenderPipeline after a successful generate when args.render is true", async () => {
    const runRenderPipeline = vi.fn<typeof RunRenderPipeline>(async () => {});
    const deps = baseDeps({ runRenderPipeline });

    const result = await runGenerate({ prompt: "Explain hooks", render: true }, deps);

    expect(result.ok).toBe(true);
    expect(runRenderPipeline).toHaveBeenCalledTimes(1);
    expect(runRenderPipeline.mock.calls[0]![0]).toEqual(FAKE_SPEC);
    expect(runRenderPipeline.mock.calls[0]![1]).toMatchObject({ profileName: "final" });
  });

  it("does not call runRenderPipeline when args.render is false", async () => {
    const runRenderPipeline = vi.fn<typeof RunRenderPipeline>(async () => {});
    const deps = baseDeps({ runRenderPipeline });

    await runGenerate({ prompt: "Explain hooks", render: false }, deps);

    expect(runRenderPipeline).not.toHaveBeenCalled();
  });

  it("still reports the generate as ok when the render step fails, distinguishing the failure", async () => {
    const runRenderPipeline = vi.fn<typeof RunRenderPipeline>(async () => {
      throw new Error("ffmpeg exploded");
    });
    const deps = baseDeps({ runRenderPipeline });

    const result = await runGenerate({ prompt: "Explain hooks", render: true }, deps);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("ffmpeg exploded");
  });
});
