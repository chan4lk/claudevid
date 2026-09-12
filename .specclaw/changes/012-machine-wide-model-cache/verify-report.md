# Verify Report: Machine-wide model cache

**Change:** 012-machine-wide-model-cache
**Verified:** 2026-09-12
**Verdict:** ✅ PASS

## Commands

Run through `npx pnpm@10.33.2` on `PATH`, because bare `pnpm` is broken in this environment — its
global shim points into a store path that no longer exists. This is `.specclaw/learnings.md`
**L1**, already recorded; a red verdict from bare `pnpm` here is an environment artifact.

| Command | Exit |
|---------|------|
| `pnpm -r run build` | 0 |
| `pnpm -r run lint` | 0 |
| `pnpm -r run test` | 0 |
| `pnpm package` | 0 — 243.6 kB, 28 files |

**544 tests across 11 packages, all passing.** `packages/audio` 113 (was 88 before this change —
+25 new), `packages/cli` 72 (+2).

## Acceptance Criteria

| AC | Status | Evidence |
|----|--------|----------|
| AC1 — `CLAUDEVID_MODELS_DIR` verbatim | ✅ | `cache-root.test.ts` "uses $CLAUDEVID_MODELS_DIR verbatim"; also confirmed against the **global install**: `resolveModelsRoot({env:{CLAUDEVID_MODELS_DIR:'/mnt/models'}})` → `/mnt/models` |
| AC2 — `$XDG_CACHE_HOME/claudevid/models` | ✅ | test + global install → `/tmp/xdg/claudevid/models` |
| AC3 — platform defaults | ✅ | 4 tests: darwin, win32 (with and without `%LOCALAPPDATA%`), linux, plus a non-listed platform |
| AC4 — empty env treated as unset | ✅ | 4 tests (empty, whitespace-only, empty XDG, empty→XDG fallthrough); global install → falls back to `~/Library/Caches/claudevid/models` |
| AC5 — resolver makes no filesystem calls | ✅ | returns a path under a non-existent dir; `existsSync` false afterwards |
| AC6 — project cache resolution unchanged | ✅ | the 4 pre-existing `resolveCacheRoot`/`resolveCacheSubdir` assertions pass **unmodified** |
| AC7 — install/verify round-trip under an injected root | ✅ | `models.test.ts`, re-pointed to the `modelsRoot` seam |
| AC8 — `tts.ts`/`align.ts` use `resolveModelsRoot`, drop `resolveCacheSubdir` | ✅ | source read; `grep resolveCacheSubdir packages/audio/src/{tts,align}.ts` → no matches |
| AC9 — `installModels` keeps temp-file + rename | ✅ | unchanged in `models.ts`; its atomicity test still passes |
| AC10 — migration moves a populated cache, source removed | ✅ | 2 tests, **plus a real migration on this machine** (below) |
| AC11 — destination exists ⇒ no-op, no merge, no delete | ✅ | test asserts destination contents unchanged *and* source intact |
| AC12 — failure contained, source intact | ✅ | blocked-destination test: `reason: "failed"`, nothing thrown, source files still readable |
| AC13 — `models install` reports the resolved root | ✅ | `cli/test/models.test.ts`, exact string against an injected root; a 4th test asserts the path is *not* leaked into the failure message |
| AC14 — build + lint + test green | ✅ | table above |

## End-to-end verification on real hardware

The unit tests all use injected roots and `tmpdir()` (NFR2), so the change was additionally
exercised against the real filesystem:

1. **Real migration.** `packages/audio`'s gated live tests load Kokoro and Whisper for real. On this
   run they migrated that checkout's existing **457 MB** cache from
   `packages/audio/.claudevid/cache/models` to `~/Library/Caches/claudevid/models` and loaded both
   models from the new location. Afterwards `packages/audio/.claudevid` is **0 B** and the
   machine-wide root holds both `onnx-community/` (Kokoro) and `Xenova/` (Whisper). This is AC10
   against real weights, not a fixture.
2. **Fresh-directory narrated render — the change's actual premise.** After `npm install -g` of the
   repacked tarball, a spec with `narration` rendered from a brand-new empty directory:
   - completed in **2.2 s**, output a 58 KB MP4;
   - `ffprobe` confirms a real **AAC audio track, 2.79 s** — Kokoro genuinely synthesized, it was
     not silently skipped;
   - the directory contains **no `.claudevid/` at all** — zero model download.

   Before this change the same command in a new directory fetched ~330 MB.

## Notes and honest limits

- **FR5 (synthesis cache stays per-project) is verified by unchanged code and its 10 passing
  `cache.test.ts` tests, not end-to-end.** The fresh-directory render wrote no
  `.claudevid/cache/tts/` either. That is pre-existing CLI behaviour — whether `render` wires
  `getOrSynthesize` at all is outside this change, which only had to leave `cache.ts` alone, and
  did.
- **AC3's win32 branch verifies path arithmetic, not Windows behaviour.** The platform is injected;
  no win32 host was involved. Stated in design.md D6 rather than implied.
- **The concurrency hazard is documented, not fixed** (NFR4, design D5). Evidence:
  `@huggingface/transformers@3.8.1/src/utils/hub.js:319-328` — `FileCache.put` does `mkdir` then
  `createWriteStream` to the final path, no temp-then-rename, no lock. Probability rises with a
  shared root; severity and recovery are unchanged. Shipped as a README "Known issues" bullet with
  symptom, recovery, and two workarounds.
- **Other directories keep their own caches.** This machine still has 310 MB in
  `<repo>/.claudevid` and 310 MB in `.claude/skills/video-generator/.claudevid`. Migration only
  moves the cache of the project it runs in, and deliberately does not go hunting across the
  filesystem for directories to delete (Edge Case 8). Reclaiming them is the user's call.
- **`packages/audio` API rename is visible to tarball consumers.** `resolveModelFilePath`,
  `installModels` and `verifyInstalledModel` take `modelsRoot` where they took `projectRoot`.
  `packages/audio` is `private: true`, but `dist-package`'s `index.d.ts` re-exports these names, so
  anyone who installed the previous tarball and used them directly sees the change. Called out in
  design.md's API Changes.
