# Design: Machine-wide model cache — download Kokoro once per machine

**Change:** 012-machine-wide-model-cache
**Created:** 2026-09-12

## Technical Approach

The whole change turns on one observation: `cache-root.ts` is already the single place that decides
where cached things live, and every consumer already routes through it. So the work is not
"rewire the codebase" — it is "add a second resolver to the module that already owns this decision,
and move three call sites onto it."

`cache-root.ts` grows one exported function, `resolveModelsRoot()`. `resolveCacheRoot` and
`resolveCacheSubdir` are untouched, and keep serving the TTS synthesis cache. The three model
consumers (`tts.ts`, `align.ts`, `models.ts`) swap `resolveCacheSubdir("models", ...)` for
`resolveModelsRoot(...)`. That is the entire functional change; migration, the CLI path report, and
comment/doc corrections hang off it.

### Resolution precedence

```
resolveModelsRoot(opts?) →
  1. opts.env.CLAUDEVID_MODELS_DIR   (non-empty)  → used verbatim
  2. opts.env.XDG_CACHE_HOME         (non-empty)  → <XDG_CACHE_HOME>/claudevid/models
  3. platform default:
       darwin  → <home>/Library/Caches/claudevid/models
       win32   → <LOCALAPPDATA or <home>/AppData/Local>/claudevid/Cache/models
       default → <home>/.cache/claudevid/models
```

Pure `path.join` arithmetic over an injected `{ env, homedir, platform }` bag. No `mkdir`, no `stat`
— FR2, and the discipline `cache-root.ts`'s header comment already claims for itself.

**Why tier 1 appends nothing.** `$CLAUDEVID_MODELS_DIR` names the directory it means. Appending
`claudevid/models` to an explicit override would make `CLAUDEVID_MODELS_DIR=/mnt/models` silently
mean `/mnt/models/claudevid/models`, which is the kind of surprise an escape hatch exists to avoid.
Tier 2 *does* append, because `$XDG_CACHE_HOME` names a shared cache **parent** owned by the XDG
convention, not by this tool.

**Why empty-string counts as unset.** `export CLAUDEVID_MODELS_DIR=` in a shell profile, or a CI
system that materializes undefined variables as `""`, would otherwise resolve the root to `""` and
put 310 MB into the process's current directory — reintroducing the exact per-directory bug this
change removes, but harder to see. So the guard is `?.trim()` truthiness, not `in env`.

### Migration

A separate exported function, `migrateProjectModelsCache(opts)`, in a new `models-migration.ts`.
Not folded into the resolver, because the resolver is specified as pure (FR2) and a resolver with a
filesystem side effect is a trap for every future caller.

```
if machine-wide root exists        → return { migrated: false, reason: "destination-exists" }
if project-local models/ missing   → return { migrated: false, reason: "nothing-to-migrate" }
if project-local models/ is empty  → return { migrated: false, reason: "nothing-to-migrate" }
try   fs.rename(src, dest)
catch EXDEV → fs.cp(src, dest, {recursive:true}) then fs.rm(src, {recursive:true})
catch *     → return { migrated: false, reason: "failed", error }     // never throws
```

Called once, lazily, from the same place the model root is first needed for a *download* — i.e.
`installModels` and the two `env.cacheDir` singletons. It is idempotent and cheap after the first
run (one `stat` on a directory that exists → immediate `destination-exists`).

**Why "destination exists" means skip rather than merge.** A merge would have to decide what happens
when both sides hold a differently-sized `model.onnx`, and every answer to that is a guess about
which bytes the user wants. Skipping is the only behaviour that cannot corrupt a working cache. The
project-local copy is left alone in that case so nothing is destroyed on a path the user did not ask
for.

## Architecture

```
packages/audio/src/
  cache-root.ts          resolveCacheRoot / resolveCacheSubdir   (project cache — UNCHANGED)
                         resolveModelsRoot                       (machine-wide — NEW)
  models-migration.ts    migrateProjectModelsCache               (NEW)
        │
        ├── tts.ts      loadKokoro()      env.cacheDir = resolveModelsRoot() + sep
        ├── align.ts    loadAsrPipeline() env.cacheDir = resolveModelsRoot() + sep
        └── models.ts   resolveModelFilePath / installModels / verifyInstalledModel
                             │
packages/cli/src/commands/models.ts  ──┘  prints the resolved root (FR6)
```

Cache roots after this change:

| What | Where | Lifetime |
|------|-------|----------|
| Kokoro + Whisper weights | `<machine-wide models root>` | per machine, immutable |
| TTS synthesis entries | `<projectRoot>/.claudevid/cache/tts/` | per project, keyed to its text |

## File Changes Map

| File | Action | Description |
|------|--------|-------------|
| `packages/audio/src/cache-root.ts` | modify | Add `resolveModelsRoot` + `ModelsRootOptions`; rewrite the header comment that currently asserts "one cache root" as settled; keep `resolveCacheRoot`/`resolveCacheSubdir` byte-identical in behaviour |
| `packages/audio/src/models-migration.ts` | create | `migrateProjectModelsCache` — rename-else-copy, never throws |
| `packages/audio/src/models.ts` | modify | `resolveModelFilePath`'s second param becomes `modelsRoot?: string`; `installModels`/`verifyInstalledModel` opts take `modelsRoot` instead of `projectRoot`; `installModels` runs migration before writing; header comment updated |
| `packages/audio/src/tts.ts` | modify | `env.cacheDir` from `resolveModelsRoot()`; run migration first; drop the `resolveCacheSubdir` import; correct the D2 scope-boundary comment |
| `packages/audio/src/align.ts` | modify | Same three edits as `tts.ts` |
| `packages/audio/src/index.ts` | modify | Export `resolveModelsRoot` and `migrateProjectModelsCache` |
| `packages/cli/src/commands/models.ts` | modify | `ModelsInstallDeps` gains `resolveModelsRoot`; success message reports the resolved path (FR6) |
| `packages/audio/test/cache-root.test.ts` | modify | Add `resolveModelsRoot` describe block — every precedence tier, every platform default, empty-string, no-filesystem-access (AC1–AC5); existing assertions stay untouched (AC6) |
| `packages/audio/test/models-migration.test.ts` | create | AC10–AC12 against `tmpdir()` |
| `packages/audio/test/models.test.ts` | modify | Re-point `projectRoot` seam to `modelsRoot` (AC7, AC9) |
| `packages/cli/test/models.test.ts` | modify/create | AC13 — success message carries the injected root |
| `scripts/build-dist-package.mjs` | modify | README section on model location + `CLAUDEVID_MODELS_DIR` (FR9) |
| `.claude/skills/video-generator/SKILL.md` | modify | Line 33 gains the location and the override (FR9) |

## Data Model Changes

None. No persisted format changes — the same `model.onnx` bytes in the same on-disk layout
transformers.js already writes, at a different root.

## API Changes

`packages/audio`'s public surface (breaking for the three functions below; all call sites are
in-repo and updated by this change):

```ts
// NEW
export interface ModelsRootOptions {
  env?: NodeJS.ProcessEnv;   // default process.env
  homedir?: string;          // default os.homedir()
  platform?: NodeJS.Platform; // default process.platform
}
export function resolveModelsRoot(opts?: ModelsRootOptions): string;

export interface MigrationResult {
  migrated: boolean;
  reason: "migrated" | "destination-exists" | "nothing-to-migrate" | "failed";
  error?: Error;
}
export function migrateProjectModelsCache(opts?: {
  projectRoot?: string;
  modelsRoot?: string;
}): Promise<MigrationResult>;

// CHANGED — second param/opt renamed, because it no longer means a project root
export function resolveModelFilePath(model?: PinnedModel, modelsRoot?: string): string;
export function installModels(opts?: { fetchFn?; modelsRoot?: string; model? }): Promise<void>;
export function verifyInstalledModel(opts?: { modelsRoot?: string; model? }): Promise<boolean>;

// UNCHANGED
export function resolveCacheRoot(projectRoot?: string): string;
export function resolveCacheSubdir(name: string, projectRoot?: string): string;
```

`packages/audio` is `private: true` and consumed only through the bundled `claudevid` facade, so
this is not a published-API break — but `dist-package`'s `index.d.ts` does re-export these names, so
the rename is visible to anyone who installed the tarball. Called out here rather than discovered
later.

## Key Decisions

- **D1 — Two roots, not one parameterized root.** `resolveCacheSubdir("models")` could have taken a
  "machine-wide" flag. Two separate named functions instead, because the *lifetime* differs, and a
  boolean at the call site is exactly how a future edit puts the synthesis cache in the wrong place.
  This narrows 006's D2 ("one cache root") rather than discarding it: the principle was "one module
  decides every cache path," and that still holds — `cache-root.ts` is still the only module that
  decides.
- **D2 — Migration is a separate module, not a resolver side effect.** Keeps FR2's purity claim
  literally true and keeps the migration independently testable without a resolver in the way.
- **D3 — `modelsRoot`, not `projectRoot`, as the test seam on `models.ts`.** A rename, not just a
  re-point. Leaving the parameter called `projectRoot` while it means a machine-wide path is how the
  next reader reintroduces this bug.
- **D4 — Migration never throws (FR8).** Its failure mode is "the user pays for one download they
  could have avoided," which must never be escalated into "the render crashes." The result object
  carries the reason so a caller *could* report it; no current caller does, deliberately —
  a warning on every cold render would be noise.
- **D5 — Concurrency hazard documented, not fixed.** Evidence in spec Overview #2
  (`hub.js:319-328`). Fixing it means replacing transformers.js's `FileCache`; that is a change of
  its own, and pretending a lock is "small" is how this change's file count triples. `installModels`
  keeps its own temp-then-rename (AC9), which is the part this change actually controls.
- **D6 — Windows default is `%LOCALAPPDATA%\claudevid\Cache\models`.** Matches the proposal.
  Untested on a real win32 host — the platform is injected in tests, so AC3 verifies the *arithmetic*
  for win32, not the behaviour of a Windows filesystem. Stated plainly rather than implied.

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Writes outside the project directory for the first time; a sandbox with no writable `$HOME` breaks | medium | `$CLAUDEVID_MODELS_DIR` escape hatch (FR1), documented (FR9); resolution itself never touches the filesystem so the failure is a clear `EACCES` at download, not a mystery at import |
| Migration destroys a working cache | high if hit | Skips entirely when the destination exists (AC11); deletes the source only after the copy resolves (FR7); never throws (FR8, AC12) |
| Concurrent cold downloads corrupt the shared model | medium | Not fixed — documented (NFR4, Edge Case 6) with recovery "delete the model dir and re-run". Probability rises, severity and recovery unchanged |
| Four files' comments cite 006 D2/FR7 as settled; stale comments mislead the next reader | low | Comment updates are explicit in-scope work, with their own task (T6), not incidental |
| `projectRoot` → `modelsRoot` rename missed at a call site | low | `tsc` catches it — the parameter changes meaning, and every call site is in-repo; `pnpm -r run build` is an acceptance criterion (AC14) |

## Grounding sources

- `.specclaw/changes/006-tts-voiceover-captions/design.md:148-152` — D2 as written: *"`cache-root.ts`
  is the single root-resolution helper both `cache.ts` and `models.ts` call, so there is one cache
  root (`.claudevid/cache/`), not two."* This change narrows the scope of that decision for models
  while preserving its actual principle (one deciding module), which is why D1 above frames it as a
  narrowing rather than a reversal.
- `.specclaw/changes/006-tts-voiceover-captions/spec.md:61-63` — FR7: *"Cache and model directories
  resolve through one shared root-resolution helper ... so both agree on the project's cache root."*
  The clause being amended is "the project's".
- `GOALS.md:259-262` — *"Pin the models. ... No implicit network fetch during an ordinary render —
  gate it behind `claudevid models install`."* Reinforces FR6: if `models install` is the sanctioned
  way to pre-fetch, it has to say where it put things.
- `.claude/skills/video-generator/SKILL.md:33` — *"TTS model (~330 MB) on first use. Specs without
  narration need neither a model nor network."* States the size but not the location; FR9 fixes that.
- `.specclaw/learnings.md` **L1** — bare `pnpm` is broken in this environment; verification must use
  a working invocation. Carried into spec Notes and T9.
- `node_modules/.pnpm/@huggingface+transformers@3.8.1/.../src/utils/hub.js:319-328` —
  `FileCache.put`'s `mkdir` + `createWriteStream(filePath)` with no temp-then-rename. The evidence
  behind D5 and Edge Case 6.
