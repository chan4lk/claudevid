// Config load + merge tests (spec.md FR7). No filesystem access — exists/readFile are injected
// fakes, following tools/motion-preview's dependency-injection test style.

import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig (FR7)", () => {
  it("returns overrides alone when no config file exists", () => {
    const config = loadConfig(
      { model: "override-model" },
      { cwd: "/project", exists: () => false, readFile: () => "" },
    );
    expect(config).toEqual({ model: "override-model" });
  });

  it("loads and parses an existing config file when no overrides are given", () => {
    const config = loadConfig(
      {},
      {
        cwd: "/project",
        exists: (path) => path === "/project/claudevid.config.json",
        readFile: () => JSON.stringify({ model: "file-model", voice: "file-voice" }),
      },
    );
    expect(config).toEqual({ model: "file-model", voice: "file-voice" });
  });

  it("lets an override win over the file's value for the same field", () => {
    const config = loadConfig(
      { model: "override-model" },
      {
        cwd: "/project",
        exists: () => true,
        readFile: () => JSON.stringify({ model: "file-model", voice: "file-voice" }),
      },
    );
    expect(config).toEqual({ model: "override-model", voice: "file-voice" });
  });

  it("merges fields from both the file and overrides that don't collide", () => {
    const config = loadConfig(
      { repairAttempts: 5 },
      {
        cwd: "/project",
        exists: () => true,
        readFile: () => JSON.stringify({ model: "file-model" }),
      },
    );
    expect(config).toEqual({ model: "file-model", repairAttempts: 5 });
  });

  it("throws ConfigError on malformed JSON", () => {
    expect(() =>
      loadConfig(
        {},
        { cwd: "/project", exists: () => true, readFile: () => "{not valid json" },
      ),
    ).toThrow(ConfigError);
  });

  it("throws ConfigError when the config file is not a JSON object", () => {
    expect(() =>
      loadConfig(
        {},
        { cwd: "/project", exists: () => true, readFile: () => JSON.stringify([1, 2, 3]) },
      ),
    ).toThrow(ConfigError);
  });

  it("throws ConfigError on a field with the wrong type", () => {
    expect(() =>
      loadConfig(
        {},
        {
          cwd: "/project",
          exists: () => true,
          readFile: () => JSON.stringify({ repairAttempts: "three" }),
        },
      ),
    ).toThrow(ConfigError);
  });

  it("validates the nested brand object's fields", () => {
    const config = loadConfig(
      {},
      {
        cwd: "/project",
        exists: () => true,
        readFile: () =>
          JSON.stringify({ brand: { palette: ["#000", "#fff"], fontFamily: "Inter" } }),
      },
    );
    expect(config.brand).toEqual({ palette: ["#000", "#fff"], fontFamily: "Inter" });
  });

  it("throws ConfigError when brand.palette isn't an array of strings", () => {
    expect(() =>
      loadConfig(
        {},
        {
          cwd: "/project",
          exists: () => true,
          readFile: () => JSON.stringify({ brand: { palette: [1, 2, 3] } }),
        },
      ),
    ).toThrow(ConfigError);
  });
});
