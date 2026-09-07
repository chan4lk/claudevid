// Pure path-resolution tests for cache-root.ts (spec.md FR7). No filesystem access — these
// functions never create directories, so tests only assert on the returned strings.

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveCacheRoot, resolveCacheSubdir } from "../src/cache-root.js";

describe("resolveCacheRoot (FR7)", () => {
  it("defaults to process.cwd()/.claudevid/cache when no projectRoot is given", () => {
    expect(resolveCacheRoot()).toBe(path.join(process.cwd(), ".claudevid", "cache"));
  });

  it("resolves under an explicit projectRoot override instead of process.cwd()", () => {
    const projectRoot = "/tmp/some-other-project";
    expect(resolveCacheRoot(projectRoot)).toBe(path.join(projectRoot, ".claudevid", "cache"));
  });
});

describe("resolveCacheSubdir (FR7)", () => {
  it("joins the named subdirectory onto the shared cache root", () => {
    const projectRoot = "/tmp/some-other-project";
    expect(resolveCacheSubdir("tts", projectRoot)).toBe(
      path.join(resolveCacheRoot(projectRoot), "tts"),
    );
  });

  it("produces distinct paths for different subdirectory names under the same root", () => {
    const projectRoot = "/tmp/some-other-project";
    const ttsDir = resolveCacheSubdir("tts", projectRoot);
    const modelsDir = resolveCacheSubdir("models", projectRoot);

    expect(ttsDir).not.toBe(modelsDir);
    expect(path.dirname(ttsDir)).toBe(resolveCacheRoot(projectRoot));
    expect(path.dirname(modelsDir)).toBe(resolveCacheRoot(projectRoot));
  });
});
