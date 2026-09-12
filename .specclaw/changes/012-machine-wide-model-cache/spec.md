# Spec: Machine-wide model cache — download Kokoro once per machine

**Change:** 012-machine-wide-model-cache
**Created:** 2026-09-12
**Status:** 🟡 Draft

## Overview

Pinned model weights currently live under `<projectRoot>/.claudevid/cache/models`, so every
directory `claudevid` runs in pays its own 310 MB Kokoro download. This change splits the single
cache root established by change 006 (design.md D2, spec.md FR7) into two roots with different
lifetimes:

- **Model weights** — immutable, identical for every project on the machine → a new **machine-wide**
  root, resolved by `$CLAUDEVID_MODELS_DIR` → `$XDG_CACHE_HOME/claudevid/models` → OS cache dir.
- **TTS synthesis cache** — keyed to one project's narration text → stays at
  `<projectRoot>/.claudevid/cache/tts/`, unchanged.

006's D2 unified `cache.ts` and `models.ts` onto one root, which was correct; this change keeps that
discipline (one helper module decides every path, pure path arithmetic, no filesystem access in the
resolver) while correcting the *scope* of the model half from per-project to per-machine.

### Open questions resolved during planning

The proposal left five open questions. Answers, with the evidence they rest on:

1. **Move the ASR model too, or only Kokoro?** — **Move both.** `align.ts:84` sets the same
   `env.cacheDir` line as `tts.ts:42` and has the identical per-project re-download problem. The
   root's meaning is "pinned model weights", not "Kokoro". Splitting them across two roots would be
   arbitrary.
2. **Is transformers.js's hub client safe under concurrent download into one `cacheDir`?** — **No,
   and this change does not fix it.** Verified against the installed library:
   `@huggingface/transformers@3.8.1/src/utils/hub.js:319-328` — `FileCache.put` does
   `mkdir` then `fs.createWriteStream(filePath)` straight to the **final** path, with no
   temp-then-rename and no lock. Two processes fetching the same cold model can interleave writes,
   and a third can read a partial file. This hazard **already exists** per-project (two concurrent
   renders in one project); a machine-wide root raises its *probability* (any two projects on the
   machine) without changing its *severity* or its recovery (delete the model dir, re-fetch).
   Building a lock or a temp-dir wrapper means replacing transformers.js's `FileCache`, which is
   disproportionate here (Rule 2) — so it is documented as a known limitation (NFR4, Edge Case 6)
   with a follow-up, not silently assumed away. `models.ts`'s own `installModels` keeps its existing
   write-to-temp-then-rename, which stays correct under concurrency (AC9).
3. **Migration or clean cut?** — **Migrate, and delete the source.** Re-downloading 310 MB a user
   already has is the exact cost this change exists to remove. Leaving the old copy behind leaves
   310 MB of orphaned bytes the user never asked for and would have to find by hand.
4. **Anything depending on the model being inside the project directory?** — None known in this
   repo (nothing reads `cache/models` except the three consumers being repointed). Sandboxed CI with
   no writable `$HOME` is the plausible breaker, which is precisely what `$CLAUDEVID_MODELS_DIR`
   exists for (FR1, FR7).
5. **Should `verifyInstalledModel` fail louder on a machine-wide file?** — **No signature change.**
   `ModelDigestMismatchError` already fails closed and names the model id and both digests. The real
   gap was *discoverability of the location*, which FR6 closes by having `claudevid models install`
   print the resolved root. Widening an exported error's constructor for this would be scope creep.

## Requirements

### Functional Requirements

- **FR1** — `packages/audio/src/cache-root.ts` exports a new `resolveModelsRoot()` that resolves the
  machine-wide model root by this precedence, first match wins:
  1. `$CLAUDEVID_MODELS_DIR`, when set and non-empty — used verbatim, no `claudevid/models`
     suffix appended (an explicit override names the directory it means);
  2. `$XDG_CACHE_HOME/claudevid/models`, when `XDG_CACHE_HOME` is set and non-empty;
  3. OS default — `~/Library/Caches/claudevid/models` (darwin),
     `%LOCALAPPDATA%\claudevid\Cache\models` (win32), `~/.cache/claudevid/models` (all others).
- **FR2** — `resolveModelsRoot` performs **pure path resolution only**: no `mkdir`, no `stat`, no
  filesystem access of any kind, matching the discipline `cache-root.ts` already states in its
  header comment. Callers create directories they need.
- **FR3** — `resolveModelsRoot` accepts an injected environment and home directory as an optional
  test seam (defaulting to `process.env` / `os.homedir()`), so every precedence branch and every
  platform default is unit-testable without mutating the real process environment or touching the
  real user cache — the same injection pattern `cache-root.ts` already uses for `projectRoot`.
- **FR4** — All three model consumers resolve through `resolveModelsRoot()`:
  `tts.ts`'s `env.cacheDir` (Kokoro), `align.ts`'s `env.cacheDir` (Whisper ASR), and `models.ts`'s
  `resolveModelFilePath` (and therefore `installModels` / `verifyInstalledModel`).
- **FR5** — The TTS synthesis cache is untouched: `cache.ts` continues to resolve
  `<projectRoot>/.claudevid/cache/tts/<hash>.json` via `resolveCacheSubdir("tts", projectRoot)`, and
  `resolveCacheRoot` / `resolveCacheSubdir` keep their current signatures and behaviour.
- **FR6** — `claudevid models install` prints the resolved machine-wide root it installed into, so
  "where did my 310 MB go" is answerable without reading source. The path is reported on success;
  the existing failure message and exit codes are unchanged.
- **FR7** — A one-time migration moves a populated project-local `<projectRoot>/.claudevid/cache/models/`
  into the machine-wide root when, and only when, the machine-wide root does not already exist. It
  attempts `fs.rename` first and falls back to recursive copy-then-delete when rename fails with
  `EXDEV` (different filesystem). The source directory is removed on success.
- **FR8** — Migration is **best-effort and never fatal**: any failure leaves the project-local
  directory intact, does not throw into the caller, and falls through to the normal
  download-on-demand path. A user with an unwritable `$HOME` gets a slow first render, not a crash.
- **FR9** — Documentation states where models live and how to override it: the generated package
  README (`scripts/build-dist-package.mjs`) and
  `.claude/skills/video-generator/SKILL.md:33`, which today says only "TTS model (~330 MB) on first
  use" with no location.

### Non-Functional Requirements

- **NFR1** — No new runtime dependency. Resolution uses `node:path` and `node:os` only.
- **NFR2** — No test writes to, reads from, or deletes the real user cache directory. Tests inject
  a fake env/home or a `tmpdir()` path — asserting against `os.homedir()` in a test is a defect,
  not a shortcut.
- **NFR3** — `packages/audio`'s dependency rules from 006 NFR1 are unchanged; this change adds no
  cross-package dependency.
- **NFR4** — Concurrent cold downloads of the same model into a shared root remain unsafe (see
  Overview #2 and Edge Case 6). This change does not regress the hazard and does not fix it; it is
  recorded as a known limitation with a stated recovery.

## Acceptance Criteria

Each criterion must pass for the change to be considered complete.

- **AC1** — With `CLAUDEVID_MODELS_DIR=/tmp/explicit-models` injected, `resolveModelsRoot` returns
  exactly `/tmp/explicit-models` — no `claudevid` or `models` segment appended.
- **AC2** — With `CLAUDEVID_MODELS_DIR` unset and `XDG_CACHE_HOME=/tmp/xdg` injected,
  `resolveModelsRoot` returns `/tmp/xdg/claudevid/models`.
- **AC3** — With both env vars unset, `resolveModelsRoot` returns the OS default for each of
  `darwin` (`<home>/Library/Caches/claudevid/models`), `win32`
  (`<LOCALAPPDATA>\claudevid\Cache\models`) and `linux` (`<home>/.cache/claudevid/models`), each
  asserted against an injected platform + home, never the real ones.
- **AC4** — An empty-string `CLAUDEVID_MODELS_DIR` (or `XDG_CACHE_HOME`) is treated as unset and
  falls through to the next precedence tier — an exported `CLAUDEVID_MODELS_DIR=` in a shell does
  not resolve the model root to the current directory.
- **AC5** — `resolveModelsRoot` makes no filesystem calls: verified by asserting it returns a path
  under a directory that does not exist, without creating it or throwing.
- **AC6** — `resolveCacheRoot("/p")` and `resolveCacheSubdir("tts", "/p")` return exactly what they
  returned before this change — the existing `cache-root.test.ts` assertions pass unmodified.
- **AC7** — `resolveModelFilePath(model, modelsRoot)` resolves under the machine-wide root, and
  `installModels` + `verifyInstalledModel` round-trip a fixture model through an injected
  `tmpdir()` root: install writes it, verify returns `true`, a corrupted byte makes verify throw
  `ModelDigestMismatchError`. (The existing `models.test.ts` cases, re-pointed at the new seam.)
- **AC8** — `tts.ts` and `align.ts` set `env.cacheDir` from `resolveModelsRoot()`, and neither
  imports `resolveCacheSubdir` any more. Verified by reading the source — both are inside lazy
  singletons that a unit test cannot invoke without downloading a model.
- **AC9** — `installModels` still writes via a uniquely-named temp file and `fs.rename`, never
  directly to the final path (the concurrency property called out in the proposal, preserved under
  a now-shared root).
- **AC10** — Given a populated `<projectRoot>/.claudevid/cache/models/` and a **non-existent**
  machine-wide root, migration moves every file across, the machine-wide root contains them, and
  the project-local `models/` directory is gone. The sibling `cache/tts/` directory is untouched.
- **AC11** — Given a machine-wide root that **already exists**, migration is a no-op: it does not
  copy, does not merge, and does not delete the project-local directory.
- **AC12** — Migration failure is contained: with a migration whose move step throws, the caller
  completes normally, the project-local directory still holds its files, and nothing propagates.
- **AC13** — `runModelsInstall` returns a success message containing the resolved models root, using
  an injected root so the assertion is exact rather than a substring guess at the real path.
- **AC14** — `pnpm -r run test`, `pnpm -r run lint` and `pnpm -r run build` all pass. (Invoked via a
  working pnpm — see Notes.)

## Edge Cases

1. **`CLAUDEVID_MODELS_DIR` set to a relative path** — used as given, resolved against `process.cwd()`
   by `path.join` semantics downstream. Documented, not rejected: an override means what it says.
2. **`XDG_CACHE_HOME` set to a relative path** — same treatment. XDG spec says such a value should be
   ignored, but honouring it is the less surprising behaviour for a single-user CLI and costs no code.
3. **Empty-string env var** — treated as unset (AC4). This is the trap that would otherwise silently
   move a 310 MB cache into whatever directory the user happened to be standing in.
4. **`$HOME` unwritable or unset (sandboxed CI, containers)** — `os.homedir()` still returns a path;
   the write fails at download time with the underlying `EACCES`/`EROFS`, not at resolution time.
   `CLAUDEVID_MODELS_DIR` is the escape hatch, named in the docs (FR9).
5. **Migration across filesystems** — `fs.rename` throws `EXDEV`; falls back to recursive copy then
   delete (FR7). A copy interrupted midway leaves the source intact because the delete only runs
   after the copy resolves.
6. **Two processes downloading the same cold model concurrently** — unsafe, unchanged by this change.
   `transformers.js` `FileCache.put` streams to the final path with no lock
   (`hub.js:319-328`). Symptom: a truncated `.onnx` and an ONNX load failure. Recovery: delete the
   model directory and re-run. Recorded in NFR4 and the docs; a lock or temp-dir wrapper is a
   follow-up, not this change.
7. **Project-local `models/` exists but is empty** — treated as nothing to migrate; no directory is
   created at the destination and no delete happens.
8. **A stale project-local `models/` after migration** — cannot occur for the migrated project (the
   source is deleted), but *other* projects on the machine keep their own copies. Reclaiming those
   is the user's call; this change does not go hunting across the filesystem for directories to
   delete, and says so.

## Dependencies

- Change 006 (`006-tts-voiceover-captions`) — owns `cache-root.ts`, `tts.ts`, `models.ts`, and the
  D2/FR7 "one cache root" decision this change narrows. Complete.
- Change 008 (`008-forced-alignment-captions-audio-graph`) — owns `align.ts` and its `env.cacheDir`
  line. Complete.
- Change 007 (`007-cli-claude-skill`) — owns `packages/cli/src/commands/models.ts`. Complete.
- No blocking dependency on any in-flight change.

## Notes

- **`pnpm` on this machine is broken** — the global shim points into a store path that no longer
  exists, so bare `pnpm` fails. This is already recorded as learning **L1** in
  `.specclaw/learnings.md` ("specclaw-build finalize's test/lint/build commands invoke the bare
  'pnpm' binary"). Verification for AC14 must run through a working invocation (`npx pnpm@10.33.2`
  or an equivalent shim on `PATH`); a red finalize verdict from bare `pnpm` is an environment
  artifact, not a test failure. Fixing `config.yaml`'s commands is L1's action item, not this
  change's scope.
- **Comment debt is in scope.** `cache-root.ts`, `tts.ts`, `align.ts` and `models.ts` each currently
  assert "one cache root" / "the project's own cache" as settled fact, citing 006 D2 and FR7 by
  name. Those comments become wrong the moment models move, and this repo's comments carry design
  rationale rather than restating code — so updating them is part of the change, not tidy-up.
- **Follow-ups this change deliberately does not take:** cross-process download locking (Edge Case
  6); the still-placeholder all-zeros `PINNED_MODEL.digest`; fp32 → q8 quantization; a
  `claudevid models uninstall` / eviction command; reclaiming orphaned project-local caches on
  other projects.
