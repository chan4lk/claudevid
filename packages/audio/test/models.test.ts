// Tests for models.ts (spec.md FR6, AC10, Edge Cases re: model digest mismatch). Every test
// injects a fake `fetchFn` and a test-local `PinnedModel` descriptor — never the real
// `PINNED_MODEL` (whose digest is a placeholder no fixture's bytes could ever match, and whose
// URL must never actually be requested here) — so nothing in this file makes a real network
// call. Each test also passes an explicit `projectRoot` under a fresh `os.tmpdir()` directory, so
// nothing here touches this repo's real `.claudevid/cache/` (same isolation pattern as
// cache-root.test.ts's explicit `projectRoot` override).

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ModelDigestMismatchError,
  installModels,
  resolveModelFilePath,
  verifyInstalledModel,
  type PinnedModel,
} from "../src/models.js";

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A fake `fetch` that never touches the network: it returns a fixed byte payload regardless of
 * the URL it's called with, wrapped in the minimal subset of the `Response` shape `installModels`
 * reads (`ok`, `status`, `arrayBuffer()`). */
function fakeFetch(bytes: Buffer): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }) as Response) as typeof fetch;
}

describe("models.ts (FR6, AC10)", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claudevid-models-test-"));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  const validBytes = Buffer.from("a fake kokoro model file's bytes, for test purposes only");
  const validModel: PinnedModel = {
    id: "test/fake-model",
    url: "https://example.invalid/fake-model.onnx",
    fileName: "fake-model.onnx",
    digest: sha256Hex(validBytes),
  };

  it("installModels: fetches, verifies, and writes the file when the digest matches", async () => {
    await installModels({ fetchFn: fakeFetch(validBytes), projectRoot, model: validModel });

    const filePath = resolveModelFilePath(validModel, projectRoot);
    const written = await fs.readFile(filePath);
    expect(written.equals(validBytes)).toBe(true);
  });

  it("installModels: throws ModelDigestMismatchError and writes no file when the digest doesn't match", async () => {
    const wrongDigestModel: PinnedModel = { ...validModel, digest: "f".repeat(64) };

    await expect(
      installModels({ fetchFn: fakeFetch(validBytes), projectRoot, model: wrongDigestModel }),
    ).rejects.toThrow(ModelDigestMismatchError);

    const filePath = resolveModelFilePath(wrongDigestModel, projectRoot);
    await expect(fs.readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("verifyInstalledModel: returns false when no file has been installed yet", async () => {
    await expect(verifyInstalledModel({ projectRoot, model: validModel })).resolves.toBe(false);
  });

  it("verifyInstalledModel: returns true for a freshly installed, matching file", async () => {
    await installModels({ fetchFn: fakeFetch(validBytes), projectRoot, model: validModel });

    await expect(verifyInstalledModel({ projectRoot, model: validModel })).resolves.toBe(true);
  });

  it("verifyInstalledModel: throws ModelDigestMismatchError on a deliberately corrupted cache file (AC10)", async () => {
    await installModels({ fetchFn: fakeFetch(validBytes), projectRoot, model: validModel });

    // Deliberately corrupt the cached file in place — simulates a stale/mismatched file left
    // behind by e.g. a library upgrade with no reinstall (spec.md Edge Cases).
    const filePath = resolveModelFilePath(validModel, projectRoot);
    await fs.writeFile(filePath, Buffer.from("corrupted, not the real model bytes"));

    await expect(verifyInstalledModel({ projectRoot, model: validModel })).rejects.toThrow(
      ModelDigestMismatchError,
    );
  });
});
