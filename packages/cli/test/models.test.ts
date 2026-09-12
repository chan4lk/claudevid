// `claudevid models install` command logic tests (spec.md FR13/AC9, 012 spec.md FR6/AC13).
// `installModels` and `resolveModelsRoot` are both injected (NFR3) — no real network access, no
// filesystem writes, and no read of the real machine-wide model root, so the expected message is
// an exact string rather than a substring guess at whatever path this host happens to use.

import { describe, expect, it } from "vitest";

import { runModelsInstall, type ModelsInstallDeps } from "../src/commands/models.js";

/** Stands in for the real machine-wide root; any absolute path works, since nothing touches it. */
const FAKE_MODELS_ROOT = "/tmp/fake-models-root";

describe("runModelsInstall (FR13/AC9)", () => {
  it("resolves ok:true when installModels resolves", async () => {
    const deps: ModelsInstallDeps = {
      installModels: async () => {},
      resolveModelsRoot: () => FAKE_MODELS_ROOT,
    };

    const result = await runModelsInstall(deps);

    expect(result.ok).toBe(true);
  });

  it("reports the resolved machine-wide install path on success (012 FR6/AC13)", async () => {
    const deps: ModelsInstallDeps = {
      installModels: async () => {},
      resolveModelsRoot: () => FAKE_MODELS_ROOT,
    };

    const result = await runModelsInstall(deps);

    expect(result.message).toBe(`models installed successfully → ${FAKE_MODELS_ROOT}`);
  });

  it("resolves ok:false with the thrown error's message when installModels rejects", async () => {
    const deps: ModelsInstallDeps = {
      installModels: async () => {
        throw new Error("digest mismatch");
      },
      resolveModelsRoot: () => FAKE_MODELS_ROOT,
    };

    const result = await runModelsInstall(deps);

    expect(result.ok).toBe(false);
    expect(result.message).toBe("digest mismatch");
  });

  it("does not report a path on failure — the install message stays the error alone", async () => {
    const deps: ModelsInstallDeps = {
      installModels: async () => {
        throw new Error("digest mismatch");
      },
      resolveModelsRoot: () => FAKE_MODELS_ROOT,
    };

    const result = await runModelsInstall(deps);

    expect(result.message).not.toContain(FAKE_MODELS_ROOT);
  });
});
