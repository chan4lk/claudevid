# Proposal: Machine-wide model cache — download Kokoro once per machine

**Created:** 2026-09-09
**Status:** 🟡 Draft

## Problem

The Kokoro TTS model is re-downloaded from Hugging Face for every directory a user runs
`claudevid` in.

`packages/audio/src/cache-root.ts:11` resolves the cache root as
`<projectRoot>/.claudevid/cache`, where `projectRoot` defaults to `process.cwd()`.
`packages/audio/src/tts.ts:42` then points `@huggingface/transformers`'s hub client at that
path (`env.cacheDir = resolveCacheSubdir("models") + path.sep`), and
`packages/audio/src/align.ts:84` does the same for the ASR model used by forced alignment.

Measured in this repo right now: `.claudevid/cache/models` is **310 MB**, essentially all of it
`onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model.onnx` (fp32). `.claudevid/` is gitignored
(`.gitignore:25`), so nothing about that download travels with a checkout. Two directories on
this machine already carry a `.claudevid/` (`repos/claudevid`, `repos/trade-compliance-workbench`).

Consequences:

- **Repeat cost per project.** A second project on the same machine pays another 310 MB download
  and another 310 MB of disk, for byte-identical weights. Ten projects, 3 GB.
- **Slow, surprising first render.** The first `claudevid render` in a new directory blocks on a
  multi-hundred-MB fetch with no obvious cause — the user did not ask to install anything.
- **`claudevid models install` is directory-scoped.** It writes to `process.cwd()`, so "I already
  installed the models" is only true for the directory the user happened to be standing in.
- **Offline/air-gapped use is fragile.** A machine with the model already fetched still fails in a
  fresh directory.
- **CWD, not project root.** `projectRoot` defaults to `process.cwd()`, so even within one project
  the cache location depends on which subdirectory the command was run from.

This is a direct consequence of change 006's design decision D2 ("one cache root", `spec.md` FR7),
which correctly unified `cache.ts` and `models.ts` onto a single root — but chose a *project*
root. That was the right call for the TTS **synthesis** cache (per-project, keyed to that
project's narration text) and the wrong one for **immutable pinned model weights**, which are
identical for every project on the machine.

## Proposed Solution

Split the single cache root into two roots with different lifetimes, and move model weights to the
machine-wide one.

1. **New machine-wide model root**, resolved by precedence in `cache-root.ts`:
   1. `$CLAUDEVID_MODELS_DIR` if set (explicit override, for CI and air-gapped installs);
   2. `$XDG_CACHE_HOME/claudevid/models` if `XDG_CACHE_HOME` is set;
   3. platform default — `~/Library/Caches/claudevid/models` (macOS),
      `~/.cache/claudevid/models` (Linux), `%LOCALAPPDATA%\claudevid\Cache\models` (Windows).

   Pure path resolution, no filesystem access — same discipline `cache-root.ts` already holds.

2. **Keep the per-project root for the TTS synthesis cache.** `cache.ts` continues to write
   `<projectRoot>/.claudevid/cache/tts/` unchanged. Only `models/` relocates.

3. **Point all three model consumers at the new root:** `tts.ts:42` (`env.cacheDir`),
   `align.ts:84` (`env.cacheDir`), and `models.ts`'s `resolveModelFilePath` /
   `installModels` / `verifyInstalledModel`.

4. **Concurrency safety.** A machine-wide directory can now be written by two `claudevid`
   processes at once. `installModels` already does write-to-temp-then-rename with a pid+timestamp
   temp name (`models.ts`), which stays correct under concurrency; the change must not regress it,
   and the transformers.js hub client's own concurrent-write behaviour needs to be checked rather
   than assumed (see Open Questions).

5. **One-time migration of an existing project-local cache.** On finding
   `<projectRoot>/.claudevid/cache/models/` populated while the machine-wide root is empty, move it
   rather than re-download. Rename where same-filesystem, copy-then-delete otherwise.

6. **Make the location visible.** `claudevid models install` prints the resolved path it installed
   to, so "where did my 310 MB go" is answerable without reading source.

## Scope

### In Scope

- New machine-wide model-root resolver in `packages/audio/src/cache-root.ts`, with the
  env-var → XDG → platform-default precedence above.
- Repointing `tts.ts`, `align.ts`, and `models.ts` at that root.
- One-time migration of a populated project-local `models/` directory to the machine-wide root.
- `claudevid models install` reporting its resolved install path.
- Unit tests for the resolver (each precedence branch, each platform default) and for the
  migration, using injected roots/env rather than touching the real user cache — the existing
  `projectRoot` test-seam pattern in `cache-root.test.ts` extends to this.
- Updating change 006's FR7/D2 narrative and the in-file comments in `cache-root.ts`, `tts.ts`,
  `align.ts`, and `models.ts` that currently assert "one cache root" as a settled decision.
- Documentation: README / `.claude/skills/video-generator/SKILL.md` note on where models live and
  how to override.

### Out of Scope

- Moving the **TTS synthesis cache** (`cache/tts/`) — it stays per-project by design.
- Changing which model is pinned, its dtype, or its size (fp32 → q8 quantization is a separate,
  larger question worth its own proposal).
- Filling in the placeholder `PINNED_MODEL.digest`, which is still all-zeros
  (`models.ts` — the existing TODO). Real digest verification of Kokoro's multi-file download is
  the pre-existing scope boundary documented at the top of `tts.ts` and is not reopened here.
- A cross-machine or team-shared model cache (network share, S3).
- A `claudevid models uninstall` / cache-eviction command.
- Cross-process locking beyond what atomic rename already provides, unless Open Question 2 shows
  it is needed.

## Impact

- **Files affected:** ~8 (estimated) — `cache-root.ts`, `tts.ts`, `align.ts`, `models.ts`,
  `commands/models.ts`, `cache-root.test.ts`, `models.test.ts`, plus docs.
- **Complexity:** small
- **Risk:** medium — the change writes outside the project directory for the first time, and it
  overturns a decision (006 D2 "one cache root") that four source files currently cite by name.
  Mitigated by: pure path resolution, an explicit env override, and migration rather than
  re-download.

## Open Questions

1. **Should the ASR/alignment model move too, or only Kokoro?** The literal ask is Kokoro, but
   `align.ts:84` shares the same `env.cacheDir` line and the same per-project re-download problem.
   Moving only one leaves models split across two roots for no principled reason. Recommendation:
   move both — the root is "pinned model weights", not "Kokoro".
2. **Is `@huggingface/transformers`'s hub client safe against two processes downloading the same
   model into one `cacheDir` concurrently?** Needs verification against the library, not assumption.
   If not, a lockfile or download-to-temp-dir-then-rename wrapper enters scope.
3. **Migration or clean cut?** Moving an existing 310 MB project cache is a nice-to-have; leaving it
   orphaned and re-downloading once is simpler. Should the migration also *delete* the old
   directory, or leave it for the user?
4. **Does anything depend on the model being inside the project directory?** Sandboxed CI runners
   with no writable `$HOME`, or a container with only the workspace mounted, would break — hence
   the `CLAUDEVID_MODELS_DIR` escape hatch. Are there known such environments in use?
5. **Should `verifyInstalledModel` failing on a machine-wide file be a louder failure?** A corrupted
   shared file now breaks every project on the machine at once, not just one.

---

**To proceed:** Review this proposal and approve to begin planning.
