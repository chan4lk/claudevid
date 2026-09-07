// Content-hash cache over the full SynthesisRequest object (spec.md FR4, design.md D1, Technical
// Approach diagram). Cache key = SHA-256 hex of a canonically-ordered JSON serialization of the
// *entire* request object (all 5 fields) — never a hand-picked subset, so a future field addition
// (e.g. 008's lexicon digest) changes the key automatically with no cache.ts edit needed (D1).
//
// Cache entry format: one JSON file per hash, `<hash>.json`, holding `{ durationSeconds,
// audioBase64 }`. Chosen over "two sibling files" specifically to sidestep the multi-file
// atomicity problem (spec.md FR4: "a reader must never observe a partially-written entry") —
// folding everything into a single file means there is exactly one atomic operation (a rename)
// standing between "not cached" and "fully cached," never a window where one half of a pair
// exists without the other. Audio bytes are base64-encoded because they live inside JSON text
// alongside `durationSeconds`; this is a deliberate simplicity/inspectability tradeoff (readable
// with `cat`/`jq`) over a leaner binary framing, matching this task's "pick something simple and
// inspectable" guidance.
//
// Atomic writes: same discipline as models.ts's `installModels` — serialize the entry, write to a
// temp file in the same cache directory, then `fs.rename` into place. `fs.rename` within the same
// directory/filesystem is atomic on POSIX and Windows, so a reader of the final path either sees
// the complete previous file (if any) or the complete new file, never a partial one.
//
// Duration measurement: tts.ts's synthesize() documents its `audio` buffer as raw 16-bit signed
// PCM, little-endian, mono, no header (see tts.ts's "Output format note") — so
// durationSeconds = audio.length / 2 / sampleRate (2 bytes per sample, mono, no header to strip).

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { resolveCacheSubdir } from "./cache-root.js";
import type { CachedSynthesis, SynthesisRequest } from "./types.js";

/** Recursively sorts an object's keys (and its nested objects') so that `JSON.stringify`'s output
 * is independent of the key order a caller happened to use in an object literal — this is what
 * makes `hashSynthesisRequest`'s hash a function of *content*, not incidental property order
 * (spec.md FR4: "hash of the full SynthesisRequest object"). Arrays keep their element order
 * (order is semantically meaningful for arrays); only plain-object key order is normalized. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

/** SHA-256 hex digest of `request`'s canonically-ordered JSON serialization — the cache key
 * (spec.md FR4, design.md D1). Hashes all 5 `SynthesisRequest` fields (text, voice, speed,
 * modelId, modelDigest); never a hand-picked subset, so changing any single one of them changes
 * this hash (AC4). Exported so tests/callers can locate the exact cache entry a given request
 * maps to without duplicating the hashing logic. */
export function hashSynthesisRequest(request: SynthesisRequest): string {
  const canonical = canonicalize(request);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Resolves the on-disk path a given request's cache entry is (or would be) stored at:
 * `<cache root>/tts/<hash>.json` (spec.md FR7 — via `resolveCacheSubdir("tts", ...)`, the same
 * shared root helper `models.ts` uses). Pure path arithmetic, no filesystem access. */
export function resolveCacheEntryPath(request: SynthesisRequest, projectRoot?: string): string {
  const hash = hashSynthesisRequest(request);
  return path.join(resolveCacheSubdir("tts", projectRoot), `${hash}.json`);
}

/** On-disk shape of a cache entry file (see the module comment's "Cache entry format" note).
 * `audio` is base64-encoded because it's stored inside a JSON text file alongside
 * `durationSeconds`. */
interface CacheEntryFile {
  durationSeconds: number;
  audioBase64: string;
}

/** Reads and parses the cache entry at `filePath`, or returns `null` on a cache miss. Both "no
 * file at all" (ENOENT) and "file present but not valid JSON in the expected shape" (what a write
 * interrupted before its rename, or otherwise corrupted, would look like) are treated as a miss,
 * never as a thrown error: a reader must never observe a partially-written entry as anything
 * other than "not cached yet" (spec.md FR4, AC6). */
async function readCacheEntry(filePath: string): Promise<CachedSynthesis | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON — e.g. a partially-written / corrupted file. Treat exactly like "not
    // cached," never as corrupted data bubbling up to the caller (AC6).
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as CacheEntryFile).durationSeconds !== "number" ||
    typeof (parsed as CacheEntryFile).audioBase64 !== "string"
  ) {
    return null;
  }

  const entry = parsed as CacheEntryFile;
  return {
    durationSeconds: entry.durationSeconds,
    audio: Buffer.from(entry.audioBase64, "base64"),
  };
}

/** Atomically writes `entry` to `filePath`: serialize to JSON, write to a temp file in the same
 * directory, then `fs.rename` into place (same discipline as models.ts's `installModels`) — a
 * subsequent reader of `filePath` either sees the complete previous file (if any) or the complete
 * new file, never a partial write (spec.md FR4, AC6). */
async function writeCacheEntryAtomic(filePath: string, entry: CachedSynthesis): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload: CacheEntryFile = {
    durationSeconds: entry.durationSeconds,
    audioBase64: entry.audio.toString("base64"),
  };
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload));
  await fs.rename(tempPath, filePath);
}

/** Measures a synthesized block's duration in seconds from its raw audio bytes and sample rate.
 * tts.ts's synthesize() documents `audio` as raw 16-bit signed PCM, little-endian, mono, no
 * header — so duration is plain byte-length arithmetic: 2 bytes/sample, 1 channel, no header to
 * strip. Exported so durations.ts (a later task) can reuse the same formula instead of
 * re-deriving it. */
export function measureDurationSeconds(audio: Buffer, sampleRate: number): number {
  return audio.length / 2 / sampleRate;
}

/** "Get or synthesize" — the FR4 cache entry point (design.md's Technical Approach diagram: cache
 * check → hit returns the cached `{ audio, durationSeconds }` with zero calls to `synthesizeFn`;
 * miss calls `synthesizeFn(request)`, measures duration, atomically writes the entry, then
 * returns it).
 *
 * `synthesizeFn` is an injected `synthesize`-shaped function (spec.md FR2's seam) rather than an
 * import of tts.ts's real implementation, so nothing in this module (or its tests) ever triggers
 * real Kokoro inference (NFR2). `opts.projectRoot` is likewise a test seam (defaults to
 * `process.cwd()` via `resolveCacheSubdir`), so tests never touch this repo's real
 * `.claudevid/cache/`. */
export async function getOrSynthesize(
  request: SynthesisRequest,
  synthesizeFn: (req: SynthesisRequest) => Promise<{ audio: Buffer; sampleRate: number }>,
  opts?: { projectRoot?: string },
): Promise<CachedSynthesis> {
  const filePath = resolveCacheEntryPath(request, opts?.projectRoot);

  const cached = await readCacheEntry(filePath);
  if (cached) return cached;

  const { audio, sampleRate } = await synthesizeFn(request);
  const entry: CachedSynthesis = {
    audio,
    durationSeconds: measureDurationSeconds(audio, sampleRate),
  };
  await writeCacheEntryAtomic(filePath, entry);
  return entry;
}
