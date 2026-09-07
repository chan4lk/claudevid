// `claudevid models install` command logic tests (spec.md FR13/AC9). `installModels` is
// injected (NFR3) — no real network access or filesystem writes.

import { describe, expect, it } from "vitest";

import { runModelsInstall, type ModelsInstallDeps } from "../src/commands/models.js";

describe("runModelsInstall (FR13/AC9)", () => {
  it("resolves ok:true when installModels resolves", async () => {
    const deps: ModelsInstallDeps = {
      installModels: async () => {},
    };

    const result = await runModelsInstall(deps);

    expect(result.ok).toBe(true);
  });

  it("resolves ok:false with the thrown error's message when installModels rejects", async () => {
    const deps: ModelsInstallDeps = {
      installModels: async () => {
        throw new Error("digest mismatch");
      },
    };

    const result = await runModelsInstall(deps);

    expect(result.ok).toBe(false);
    expect(result.message).toBe("digest mismatch");
  });
});
