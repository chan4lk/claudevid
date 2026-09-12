// Tests for models-migration.ts (012 spec.md FR7/FR8, AC10-AC12).
//
// Every test injects both roots under a fresh `os.tmpdir()` directory (NFR2) — nothing here reads
// or writes the real machine-wide model root, which on a developer's machine holds ~310 MB they
// would rather keep.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateProjectModelsCache } from "../src/models-migration.js";

describe("migrateProjectModelsCache (012 FR7/FR8)", () => {
  let tmp: string;
  let projectRoot: string;
  let modelsRoot: string;
  /** Where the pre-012 project-local model cache lived. */
  let legacyModelsDir: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "claudevid-migration-test-"));
    projectRoot = path.join(tmp, "project");
    modelsRoot = path.join(tmp, "machine-wide", "models");
    legacyModelsDir = path.join(projectRoot, ".claudevid", "cache", "models");
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** Populates the project-local cache the way a pre-012 install would have left it: a model file
   * nested a couple of directories deep (transformers.js writes a tree, not one flat file), plus a
   * sibling `tts/` synthesis cache that must survive untouched. */
  async function seedLegacyCache(): Promise<void> {
    const nested = path.join(legacyModelsDir, "onnx-community", "Kokoro-82M-v1.0-ONNX", "onnx");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "model.onnx"), "fake model weights");
    await fs.writeFile(path.join(legacyModelsDir, "config.json"), "{}");

    const ttsDir = path.join(projectRoot, ".claudevid", "cache", "tts");
    await fs.mkdir(ttsDir, { recursive: true });
    await fs.writeFile(path.join(ttsDir, "abc123.json"), '{"cached":"synthesis"}');
  }

  it("moves a populated project-local cache to the machine-wide root and removes the source (AC10)", async () => {
    await seedLegacyCache();

    const result = await migrateProjectModelsCache({ projectRoot, modelsRoot });

    expect(result).toEqual({ migrated: true, reason: "migrated" });

    // Every file arrived, nesting preserved.
    const movedModel = path.join(modelsRoot, "onnx-community", "Kokoro-82M-v1.0-ONNX", "onnx", "model.onnx");
    expect(await fs.readFile(movedModel, "utf8")).toBe("fake model weights");
    expect(await fs.readFile(path.join(modelsRoot, "config.json"), "utf8")).toBe("{}");

    // The source is gone.
    await expect(fs.stat(legacyModelsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the sibling project-local tts/ synthesis cache untouched (AC10, FR5)", async () => {
    await seedLegacyCache();

    await migrateProjectModelsCache({ projectRoot, modelsRoot });

    const ttsEntry = path.join(projectRoot, ".claudevid", "cache", "tts", "abc123.json");
    expect(await fs.readFile(ttsEntry, "utf8")).toBe('{"cached":"synthesis"}');
  });

  it("is a no-op when the machine-wide root already exists — never merges, never deletes (AC11)", async () => {
    await seedLegacyCache();
    await fs.mkdir(modelsRoot, { recursive: true });
    await fs.writeFile(path.join(modelsRoot, "existing.onnx"), "already installed");

    const result = await migrateProjectModelsCache({ projectRoot, modelsRoot });

    expect(result).toEqual({ migrated: false, reason: "destination-exists" });
    // Destination untouched: no merge happened.
    expect(await fs.readdir(modelsRoot)).toEqual(["existing.onnx"]);
    // Source untouched: nothing was deleted on a path the user did not ask for.
    expect(await fs.readFile(path.join(legacyModelsDir, "config.json"), "utf8")).toBe("{}");
  });

  it("skips when there is no project-local models directory at all", async () => {
    await fs.mkdir(projectRoot, { recursive: true });

    const result = await migrateProjectModelsCache({ projectRoot, modelsRoot });

    expect(result).toEqual({ migrated: false, reason: "nothing-to-migrate" });
    await expect(fs.stat(modelsRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips when the project-local models directory exists but is empty (Edge Case 7)", async () => {
    await fs.mkdir(legacyModelsDir, { recursive: true });

    const result = await migrateProjectModelsCache({ projectRoot, modelsRoot });

    expect(result).toEqual({ migrated: false, reason: "nothing-to-migrate" });
    // No empty destination is created for nothing.
    await expect(fs.stat(modelsRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is idempotent — a second call after a successful migration is a cheap no-op", async () => {
    await seedLegacyCache();

    expect((await migrateProjectModelsCache({ projectRoot, modelsRoot })).migrated).toBe(true);
    expect(await migrateProjectModelsCache({ projectRoot, modelsRoot })).toEqual({
      migrated: false,
      reason: "destination-exists",
    });
  });

  it("contains failure: returns failed, never throws, and leaves the source intact (AC12, FR8)", async () => {
    await seedLegacyCache();

    // A destination whose *parent* is a regular file: `mkdir` of it fails with ENOTDIR, standing in
    // for the unwritable-$HOME case an intact-filesystem test cannot otherwise produce.
    const blocker = path.join(tmp, "blocker");
    await fs.writeFile(blocker, "not a directory");
    const blockedRoot = path.join(blocker, "nested", "models");

    const result = await migrateProjectModelsCache({ projectRoot, modelsRoot: blockedRoot });

    expect(result.migrated).toBe(false);
    expect(result.reason).toBe("failed");
    expect(result.error).toBeInstanceOf(Error);

    // The whole point of FR8: the user's existing cache survives a failed migration.
    expect(await fs.readFile(path.join(legacyModelsDir, "config.json"), "utf8")).toBe("{}");
  });
});
