# Tasks: Machine-wide model cache — download Kokoro once per machine

**Change:** 012-machine-wide-model-cache
**Created:** 2026-09-12
**Total Tasks:** 9

## Summary

Nine tasks in four waves. Wave 1 builds the two new primitives (resolver, migration) with their
tests — everything else depends on them. Wave 2 fans out across the four independent consumers that
each just swap one call. Wave 3 is the CLI surface, which needs `models.ts`'s new signature from
wave 2. Wave 4 is docs and full verification.

Kept deliberately coarse (Rule 2): each consumer swap is 2–4 lines plus its comment, so T3 bundles
the two `env.cacheDir` call sites rather than splitting them into a task each. The comment
corrections travel with the file they belong to instead of being deferred to one bulk "fix comments"
task, except for the two files nobody else touches.

**Parallel-wave discipline** (`.specclaw/learnings.md` L3, and L2's commit race): `git.strategy` is
`branch-per-change`, so wave 2's tasks share one working tree. Each task stages and commits **only
its own declared files, by exact path** — never `git add -A`, `.`, or `-a`.

## Tasks

### Wave 1 — New primitives

- [x] `T1` — `resolveModelsRoot` in `cache-root.ts`, with tests
  - Files: `packages/audio/src/cache-root.ts`, `packages/audio/test/cache-root.test.ts`
  - Estimate: small
  - Kind: impl
  - Notes: FR1–FR3, AC1–AC6. Precedence `CLAUDEVID_MODELS_DIR` → `XDG_CACHE_HOME/claudevid/models`
    → platform default; tier 1 appends nothing, tier 2 appends `claudevid/models` (design D1 says
    why). Empty/whitespace env value counts as unset (AC4) — guard on `?.trim()` truthiness, not
    `in env`. Inject `{ env, homedir, platform }` (FR3) so AC3 asserts darwin/win32/linux without
    touching the real host; **NFR2 — no test may read `os.homedir()` or write the real cache**.
    Pure path arithmetic, zero filesystem calls (FR2, AC5). Leave `resolveCacheRoot` and
    `resolveCacheSubdir` behaviourally identical and their existing tests unmodified (AC6). Rewrite
    the file header comment: it currently states "one cache root" as a settled 006 D2 decision, and
    that is exactly what this change narrows.

- [x] `T2` — `migrateProjectModelsCache` in a new `models-migration.ts`, with tests
  - Files: `packages/audio/src/models-migration.ts`, `packages/audio/test/models-migration.test.ts`
  - Estimate: medium
  - Kind: migration
  - Notes: FR7–FR8, AC10–AC12. Order matters: destination-exists check **first** (AC11 — never
    merge, design D2/§Migration says why), then missing/empty source, then `fs.rename`, then `EXDEV`
    → `fs.cp` recursive + `fs.rm`. Delete the source only after the copy resolves (Edge Case 5).
    **Never throws** (FR8) — every failure returns `{ migrated: false, reason: "failed", error }`.
    Returns the `MigrationResult` shape in design.md's API Changes. Tests use `os.tmpdir()` roots
    only (NFR2); AC10 must also assert the sibling `cache/tts/` directory survives untouched.

### Wave 2 — Repoint the consumers

- [x] `T3` — Point `tts.ts` and `align.ts` at the machine-wide root
  - Files: `packages/audio/src/tts.ts`, `packages/audio/src/align.ts`
  - Estimate: small
  - Kind: refactor
  - Depends: T1, T2
  - Notes: FR4, AC8. In each lazy singleton (`loadKokoro`, `loadAsrPipeline`): await
    `migrateProjectModelsCache()` then set `env.cacheDir = resolveModelsRoot() + path.sep`. Drop the
    `resolveCacheSubdir` import from both. Both functions become `async` if they are not already —
    check the call sites. Correct the comments: `tts.ts`'s header (lines ~9-14) and `align.ts`'s
    (line ~11) both assert the download "lands in the project's own cache" and cite D2's "one cache
    root"; both are now false. Keep the separate, still-accurate scope-boundary paragraph in
    `tts.ts` about multi-file hub caches and `PINNED_MODEL.digest`. No unit test can reach these
    lines without downloading a model — AC8 is verified by reading the source, so leave
    `tts.test.ts`/`align.test.ts` alone.

- [x] `T4` — Repoint `models.ts` from `projectRoot` to `modelsRoot`
  - Files: `packages/audio/src/models.ts`, `packages/audio/test/models.test.ts`
  - Estimate: small
  - Kind: refactor
  - Depends: T1, T2
  - Notes: FR4, AC7, AC9. `resolveModelFilePath(model, modelsRoot?)` returns
    `path.join(modelsRoot ?? resolveModelsRoot(), model.fileName)`; `installModels` /
    `verifyInstalledModel` opts take `modelsRoot` in place of `projectRoot`. **Rename, don't just
    re-point** (design D3) — a param still called `projectRoot` holding a machine-wide path is how
    this bug comes back. `installModels` awaits `migrateProjectModelsCache()` before writing.
    **Preserve the temp-file + `fs.rename` write exactly** (AC9) — it is the one concurrency
    property this change controls. Update the module header, which cites FR7's shared project root.
    `models.test.ts` changes are mechanical: same cases, new seam name.

- [x] `T5` — Export the new functions
  - Files: `packages/audio/src/index.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T1, T2
  - Notes: Add `resolveModelsRoot` (+ `ModelsRootOptions`) and `migrateProjectModelsCache` (+
    `MigrationResult`) to the barrel, alongside the existing `resolveCacheRoot`/`resolveCacheSubdir`
    line.

### Wave 3 — CLI surface

- [x] `T6` — `claudevid models install` reports the resolved root
  - Files: `packages/cli/src/commands/models.ts`, `packages/cli/test/models.test.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T4, T5
  - Notes: FR6, AC13. `ModelsInstallDeps` gains `resolveModelsRoot: () => string`; the success
    message names the path (`models installed successfully → <root>`). Keep the file's existing
    "thin wrapper, not a reimplementation" shape — failure message and exit codes unchanged.
    AC13 asserts against an **injected** root, so the expected string is exact rather than a
    substring guess at the real path.

### Wave 4 — Docs and verification

- [x] `T7` — Document where models live and how to override it
  - Files: `scripts/build-dist-package.mjs`, `.claude/skills/video-generator/SKILL.md`
  - Estimate: small
  - Kind: docs
  - Depends: T6
  - Notes: FR9. The generated README's "Narration downloads a model on first use" bullet currently
    says the cache lands "under `.claudevid/` in your project" — now wrong. State the machine-wide
    default per OS, `CLAUDEVID_MODELS_DIR` / `XDG_CACHE_HOME`, and that `claudevid models install`
    prints the resolved path. `SKILL.md:33` says only "TTS model (~330 MB) on first use" — add the
    location in one clause, no more; that file is read by an agent on every invocation and is not
    the place for a full explainer.

- [x] `T8` — Record the concurrency limitation where a user will hit it
  - Files: `scripts/build-dist-package.mjs`
  - Estimate: small
  - Kind: docs
  - Depends: T7
  - Notes: NFR4, Edge Case 6, design D5. One "Known issues" bullet: two `claudevid` processes
    fetching the same cold model into the shared root can corrupt it (transformers.js writes
    straight to the final path, no lock); symptom is an ONNX load failure; recovery is delete the
    model directory and re-run; `CLAUDEVID_MODELS_DIR` isolates per-job in CI. Separate task from T7
    because it is a different claim — T7 says where things are, T8 admits what is broken — and
    because it is the bullet most likely to get quietly dropped.

- [x] `T9` — Full verification
  - Files: (none — verification only)
  - Estimate: small
  - Kind: test
  - Depends: T7, T8
  - Notes: AC14. `pnpm -r run test`, `pnpm -r run lint`, `pnpm -r run build`. **Bare `pnpm` is
    broken on this machine** (`.specclaw/learnings.md` L1) — run through `npx pnpm@10.33.2` or an
    equivalent `PATH` shim. A red verdict from bare `pnpm` is an environment artifact, not a test
    failure; do not "fix" source in response to it. Also re-run `pnpm package` and confirm the
    tarball still builds and stays ~237 kB (it must not re-absorb a model cache).

---

## Legend

- `[ ]` Pending
- `[~]` In Progress
- `[x]` Complete
- `[!]` Failed
