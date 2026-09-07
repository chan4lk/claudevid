// Model pinning + digest verification (spec.md FR6, design.md Key Decision D5, Edge Cases —
// "model digest mismatch on load from cache ... fails closed per FR6, never silently re-fetches").
//
// Deliberate scope boundary: this module owns the URL+digest pin, the one-shot download+verify
// (`installModels`), and the re-verify-on-every-load check (`verifyInstalledModel`) — real,
// tested, single-file digest verification primitives. `tts.ts` imports `PINNED_MODEL.id` from
// here as its single source of truth for which model to load, and routes its cache directory
// through this package's shared cache root (design.md D2) — but it loads that model via
// `@huggingface/transformers`'s own multi-file hub client (config/tokenizer/ONNX shards), which
// has no single byte sequence to check against `PINNED_MODEL.digest`. `installModels`/
// `verifyInstalledModel` below apply to an explicit single-file fetch scenario, not to Kokoro's
// own resolver (see the "Scope boundary" comment at the top of tts.ts).
//
// Network access is confined to `installModels()` alone (spec.md FR6's "no network access
// outside the explicit install command") — `verifyInstalledModel` and every helper below it only
// touch the local filesystem.

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { resolveCacheSubdir } from "./cache-root.js";

/** Shape of a pinned model descriptor: what to fetch, what filename to cache it under, and the
 * SHA-256 digest it must match. `installModels`/`verifyInstalledModel` accept an optional
 * override of this shape so tests can exercise the real verification machinery against a
 * test-local pin instead of the committed production digest (which no test fixture's bytes can
 * be crafted to match — SHA-256 preimage resistance). Production call sites never pass an
 * override and get `PINNED_MODEL`. */
export interface PinnedModel {
  id: string;
  url: string;
  fileName: string;
  digest: string;
}

/** The Kokoro ONNX model this package pins (spec.md FR6, design.md D5: "Model pinning replaces
 * 'download with integrity check against a self-served hash.' URL + SHA-256 digest committed
 * in-repo"). `url` is `onnx-community/Kokoro-82M-v1.0-ONNX`'s primary fp32 weight file on Hugging
 * Face, matching the model id `tts.ts` currently loads via kokoro-js's own resolution (see
 * `DEFAULT_MODEL_ID` in tts.ts) — this is the same model, pinned to an explicit, verifiable
 * source instead of "whatever kokoro-js's default resolution fetches today."
 *
 * TODO: replace `digest` below with the real sha256 of the pinned model file once fetched during
 * a real install — computed via `sha256sum model.onnx` (or `shasum -a 256 model.onnx`) against
 * the actual downloaded bytes. The value below is a syntactically-valid placeholder only; it does
 * not correspond to any real file and installing against it will (correctly) fail closed until
 * replaced. */
export const PINNED_MODEL: PinnedModel = {
  id: "onnx-community/Kokoro-82M-v1.0-ONNX",
  url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx",
  fileName: "kokoro-82m-v1.0.onnx",
  digest: "0000000000000000000000000000000000000000000000000000000000000000",
};

/** Thrown by `installModels`/`verifyInstalledModel` whenever a model file's actual SHA-256 digest
 * doesn't match the expected pinned digest (spec.md FR6/AC10, design.md D6 "fail-closed
 * everywhere"). Carries both digests so a caller/log can show exactly what was expected vs. what
 * was found, without re-deriving either. */
export class ModelDigestMismatchError extends Error {
  constructor(
    public readonly modelId: string,
    public readonly expectedDigest: string,
    public readonly actualDigest: string,
  ) {
    super(
      `Model "${modelId}" failed digest verification: expected sha256 ${expectedDigest} but got ` +
        `${actualDigest}. Refusing to use this file. Run \`claudevid models install\` again after ` +
        "confirming the pinned URL/digest are correct — this file is never re-downloaded silently.",
    );
    this.name = "ModelDigestMismatchError";
  }
}

/** SHA-256 hex digest of `bytes`, via Node's `crypto` module (spec.md FR6: "computes its SHA-256
 * digest via Node's crypto module"). Pure, synchronous, no I/O. */
function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Resolves the local cache path a given `model` is (or would be) stored at:
 * `<cache root>/models/<model.fileName>` (spec.md FR7 — via `resolveCacheSubdir("models", ...)`,
 * the one shared cache-root helper `cache.ts` also uses). Pure path arithmetic, no filesystem
 * access — exported so tests can locate the exact file `installModels` writes (e.g. to corrupt it
 * for AC10's "deliberately corrupted local cache file" case) without duplicating this logic. */
export function resolveModelFilePath(model: PinnedModel = PINNED_MODEL, projectRoot?: string): string {
  return path.join(resolveCacheSubdir("models", projectRoot), model.fileName);
}

/** Downloads `model.url` (default: `PINNED_MODEL`), verifies its SHA-256 digest against
 * `model.digest`, and only then writes it into the local models cache
 * (`resolveModelFilePath(model, projectRoot)`) — spec.md FR6, AC10.
 *
 * Fail-closed on a digest mismatch (design.md D6): throws `ModelDigestMismatchError` *before*
 * writing anything, so a mismatched download never lands on disk claiming to be valid — there is
 * no partial or wrong file left behind to be picked up by a later `verifyInstalledModel` call.
 *
 * `fetchFn` defaults to the global `fetch` (the only network call this module ever makes — FR6's
 * "no network access outside the explicit install command"); tests inject a fake `fetchFn` that
 * returns controlled bytes with no real HTTP request, mirroring tts.ts's `synthesize()` and
 * encoder-ffmpeg's probe.ts's `execFn` injection seam. `projectRoot`/`model` are test seams too —
 * production call sites pass neither and get the real cache root and `PINNED_MODEL`. */
export async function installModels(opts?: {
  fetchFn?: typeof fetch;
  projectRoot?: string;
  model?: PinnedModel;
}): Promise<void> {
  const model = opts?.model ?? PINNED_MODEL;
  const fetchFn = opts?.fetchFn ?? fetch;

  const response = await fetchFn(model.url);
  if (!response.ok) {
    throw new Error(
      `Failed to download pinned model "${model.id}" from ${model.url}: HTTP ${response.status}`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());

  const actualDigest = sha256Hex(bytes);
  if (actualDigest !== model.digest) {
    // Fail closed: return before touching disk at all. No temp file, no partial file, nothing
    // left behind that a later `verifyInstalledModel` call could mistake for a valid install.
    throw new ModelDigestMismatchError(model.id, model.digest, actualDigest);
  }

  const finalPath = resolveModelFilePath(model, opts?.projectRoot);
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  // Write-to-temp-then-rename, same atomicity discipline as cache.ts's entries (spec.md FR4) —
  // a reader of `finalPath` never observes a partially-written file.
  const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, bytes);
  await fs.rename(tempPath, finalPath);
}

/** Re-verifies the locally cached model file (if present) against `model.digest` (default:
 * `PINNED_MODEL`) — spec.md FR6's "every load from the local cache re-verifies the digest and
 * fails closed ... on mismatch." Makes zero network calls.
 *
 * - No cached file present: resolves `false` (nothing to verify — this is "not installed yet",
 *   not a corruption case; callers should direct the user to `installModels`/`claudevid models
 *   install`, not silently trigger a download themselves).
 * - Cached file present and its digest matches: resolves `true`.
 * - Cached file present but its digest does NOT match (AC10's "deliberately corrupted local cache
 *   file" case, and the Edge Cases' "cache dir shared across a library upgrade with no reinstall"
 *   case): throws `ModelDigestMismatchError` rather than resolving `false` — a mismatch is a
 *   distinct, actionable failure from "not installed," and design.md D6 requires failing closed
 *   (never silently re-downloading) here. */
export async function verifyInstalledModel(opts?: {
  projectRoot?: string;
  model?: PinnedModel;
}): Promise<boolean> {
  const model = opts?.model ?? PINNED_MODEL;
  const filePath = resolveModelFilePath(model, opts?.projectRoot);

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }

  const actualDigest = sha256Hex(bytes);
  if (actualDigest !== model.digest) {
    throw new ModelDigestMismatchError(model.id, model.digest, actualDigest);
  }
  return true;
}
