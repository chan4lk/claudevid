// Pure path-resolution tests for cache-root.ts (006 spec.md FR7, 012 spec.md FR1-FR3). No
// filesystem access — these functions never create directories, so tests only assert on the
// returned strings.
//
// Every `resolveModelsRoot` case injects `{ env, homedir, platform }` rather than mutating
// `process.env` or reading `os.homedir()` (012 NFR2): a test that asserted against the real home
// directory would pass on the author's machine and mean nothing anywhere else, and one that wrote
// to the real root would put ~310 MB in a developer's cache.

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveCacheRoot, resolveCacheSubdir, resolveModelsRoot } from "../src/cache-root.js";

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

describe("resolveModelsRoot (012 FR1) — precedence", () => {
  const homedir = "/home/testuser";

  it("uses $CLAUDEVID_MODELS_DIR verbatim, appending nothing (AC1)", () => {
    // Appending `claudevid/models` here would turn an explicit override into a surprise —
    // see cache-root.ts's tier-1 comment.
    expect(
      resolveModelsRoot({
        env: { CLAUDEVID_MODELS_DIR: "/tmp/explicit-models" },
        homedir,
        platform: "linux",
      }),
    ).toBe("/tmp/explicit-models");
  });

  it("prefers $CLAUDEVID_MODELS_DIR over $XDG_CACHE_HOME when both are set", () => {
    expect(
      resolveModelsRoot({
        env: { CLAUDEVID_MODELS_DIR: "/tmp/explicit-models", XDG_CACHE_HOME: "/tmp/xdg" },
        homedir,
        platform: "linux",
      }),
    ).toBe("/tmp/explicit-models");
  });

  it("falls back to $XDG_CACHE_HOME/claudevid/models (AC2)", () => {
    expect(resolveModelsRoot({ env: { XDG_CACHE_HOME: "/tmp/xdg" }, homedir, platform: "linux" })).toBe(
      path.join("/tmp/xdg", "claudevid", "models"),
    );
  });

  it("prefers $XDG_CACHE_HOME over the platform default on darwin too", () => {
    expect(resolveModelsRoot({ env: { XDG_CACHE_HOME: "/tmp/xdg" }, homedir, platform: "darwin" })).toBe(
      path.join("/tmp/xdg", "claudevid", "models"),
    );
  });
});

describe("resolveModelsRoot (012 FR1) — platform defaults (AC3)", () => {
  const homedir = "/home/testuser";

  it("resolves under ~/Library/Caches on darwin", () => {
    expect(resolveModelsRoot({ env: {}, homedir, platform: "darwin" })).toBe(
      path.join(homedir, "Library", "Caches", "claudevid", "models"),
    );
  });

  it("resolves under %LOCALAPPDATA% on win32", () => {
    expect(
      resolveModelsRoot({
        env: { LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local" },
        homedir,
        platform: "win32",
      }),
    ).toBe(path.join("C:\\Users\\testuser\\AppData\\Local", "claudevid", "Cache", "models"));
  });

  it("falls back to <home>/AppData/Local on win32 when %LOCALAPPDATA% is absent", () => {
    expect(resolveModelsRoot({ env: {}, homedir, platform: "win32" })).toBe(
      path.join(homedir, "AppData", "Local", "claudevid", "Cache", "models"),
    );
  });

  it("resolves under ~/.cache on linux", () => {
    expect(resolveModelsRoot({ env: {}, homedir, platform: "linux" })).toBe(
      path.join(homedir, ".cache", "claudevid", "models"),
    );
  });

  it("treats any other platform like linux", () => {
    expect(resolveModelsRoot({ env: {}, homedir, platform: "freebsd" })).toBe(
      path.join(homedir, ".cache", "claudevid", "models"),
    );
  });
});

describe("resolveModelsRoot (012 FR1) — empty env values (AC4)", () => {
  const homedir = "/home/testuser";

  it("treats an empty CLAUDEVID_MODELS_DIR as unset rather than as the cwd", () => {
    // `export CLAUDEVID_MODELS_DIR=` must not resolve the model root to "" — that would put the
    // model wherever the process happened to start.
    expect(
      resolveModelsRoot({ env: { CLAUDEVID_MODELS_DIR: "" }, homedir, platform: "linux" }),
    ).toBe(path.join(homedir, ".cache", "claudevid", "models"));
  });

  it("treats a whitespace-only CLAUDEVID_MODELS_DIR as unset", () => {
    expect(
      resolveModelsRoot({ env: { CLAUDEVID_MODELS_DIR: "   " }, homedir, platform: "linux" }),
    ).toBe(path.join(homedir, ".cache", "claudevid", "models"));
  });

  it("treats an empty XDG_CACHE_HOME as unset and falls through to the platform default", () => {
    expect(resolveModelsRoot({ env: { XDG_CACHE_HOME: "" }, homedir, platform: "darwin" })).toBe(
      path.join(homedir, "Library", "Caches", "claudevid", "models"),
    );
  });

  it("falls through an empty CLAUDEVID_MODELS_DIR to a set XDG_CACHE_HOME", () => {
    expect(
      resolveModelsRoot({
        env: { CLAUDEVID_MODELS_DIR: "", XDG_CACHE_HOME: "/tmp/xdg" },
        homedir,
        platform: "linux",
      }),
    ).toBe(path.join("/tmp/xdg", "claudevid", "models"));
  });
});

describe("resolveModelsRoot (012 FR2) — purity (AC5)", () => {
  it("returns a path under a non-existent directory without creating it or throwing", async () => {
    const fs = await import("node:fs");
    const missing = path.join("/tmp", `claudevid-nonexistent-${process.pid}-${Date.now()}`);

    const resolved = resolveModelsRoot({
      env: { CLAUDEVID_MODELS_DIR: missing },
      homedir: "/home/testuser",
      platform: "linux",
    });

    expect(resolved).toBe(missing);
    expect(fs.existsSync(missing)).toBe(false);
  });
});
