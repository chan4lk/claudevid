# Spec: CLI resolution always prefers the monorepo build over a stale global install

**Change:** 010-cli-resolution-freshness
**Created:** 2026-09-09
**Status:** 🟡 Draft

## Overview

`.claude/skills/video-generator/scripts/render.mts` and `validate.mts` each carry their own copy
of `resolveCli()`, which picks which `claudevid` CLI build to shell out to. Today's order — (a) a
`claudevid` dependency in the caller's own `node_modules`, (b) a globally-installed `claudevid` on
`PATH`, (c) `packages/cli/dist/cli.js` inside the monorepo, checked last as a pure fallback — means
that whenever a global install (or a local dependency) is present *alongside* a monorepo checkout,
the monorepo's own build is never consulted, no matter how much newer or more correct it is. This
silently defeated change 009's already-merged text-centering fix: a global install one day older
than the fix stayed on `PATH`, so every render through the skill kept reproducing the exact bug 009
had already fixed, with no error or warning anywhere in the render output.

This change extracts the duplicated resolution logic into one shared, unit-testable module and
reorders it so that a monorepo checkout present relative to the calling script is used
unconditionally, ahead of both other layouts. A caller with no monorepo checkout alongside it (the
normal case for the published package) sees no behavior change at all.

## Requirements

### Functional Requirements

1. A new module, `.claude/skills/video-generator/scripts/resolve-cli.mts`, exports the CLI
   resolution logic as a pure function over an explicit set of candidates (whether the monorepo
   dist path exists, whether a local `claudevid` dependency resolves, whether a global `claudevid`
   is on `PATH`) plus a thin wrapper that gathers those candidates from the real environment
   (`fs.existsSync`, `createRequire(...).resolve`, `spawnSync`).
2. The pure resolution function's priority order is: **(1) the monorepo dist path, if it exists,
   unconditionally** — (2) a local `claudevid` dependency in the caller's `node_modules` — (3) a
   globally-installed `claudevid` on `PATH`. If none of the three is available, the function
   reports that failure the same way `resolveCli()` does today (a thrown/returned error naming all
   three options).
3. `render.mts` and `validate.mts` both import and call the shared resolver instead of each
   maintaining their own copy of the resolution logic.
4. The resolver's monorepo-dist check uses the same relative path each script already computes
   today (`path.resolve(here, "../../../../packages/cli/dist/cli.js")`) — no new build-time signal,
   embedded timestamp, commit hash, or CLI flag is introduced anywhere in this change.
5. A caller with **no** monorepo checkout present at that relative path sees local-dependency-then-
   global-install resolution behave exactly as it does today — this change alters only the case
   where a monorepo checkout is present alongside a candidate from the other two layouts.

### Non-Functional Requirements

1. **Testability:** the resolution priority logic must be exercisable via unit tests with no real
   `PATH` lookup, no `spawnSync`, and no filesystem beyond what a test explicitly sets up — i.e. the
   pure decision function takes already-resolved booleans/paths as input, not environment state.
2. **No new dependencies:** the fix must not add a package.json, a test runner, or any new
   dependency to `.claude/skills/video-generator/` — the skill folder must remain droppable into a
   non-Node host project with no `package.json`/`node_modules` of its own (an existing, load-bearing
   property documented in `SKILL.md`). Tests for the new module run via Node's built-in test runner
   (`node --test`, available on the project's already-required Node >=22), not a project-level test
   framework.
3. **Behavior parity for the non-monorepo case:** every existing example spec, and any consumer
   relying on today's local-dependency-then-global fallback order (the published-package use case),
   must resolve identically to before this change.

## Acceptance Criteria

1. Given a caller whose script directory has a monorepo checkout alongside it (i.e.
   `packages/cli/dist/cli.js` exists at the fixed relative path) **and** a `claudevid` dependency
   resolves in `node_modules` **and** a global `claudevid` is on `PATH`, the resolver selects the
   monorepo dist path.
2. Given the same caller but with **no** monorepo dist present, the resolver falls back to
   today's order: local dependency first, then global install — unchanged from current behavior.
3. Given a caller with no monorepo dist, no local dependency, and no global install, the resolver
   reports the same three-option failure message as today's `resolveCli()`.
4. `render.mts` and `validate.mts` no longer each define their own `resolveCli()` — both call the
   shared `resolve-cli.mts` module.
5. The pure decision function (priority-ordering logic) has unit test coverage exercising all three
   branches in Acceptance Criteria 1-3, runnable via `node --test` with no filesystem or process
   spawning in the test itself (candidates passed in as plain data).
6. No new `package.json`, lockfile entry, or dependency is added under
   `.claude/skills/video-generator/`.

## Edge Cases

- **Monorepo dist path exists but is not actually executable / is a stale or partial build** (e.g.
  `pnpm build` was interrupted). Out of scope for this change to detect — resolution only checks
  *existence* of the file at the expected path, matching today's behavior for the monorepo-fallback
  case; a broken build at that path was already indistinguishable from a working one before this
  change.
- **A local `claudevid` dependency (`node_modules`) exists in addition to a monorepo checkout.**
  Per Functional Requirement 2, the monorepo dist wins regardless — this is the scenario Acceptance
  Criterion 1 exercises.
- **Neither script's `here` computation changes** — this change touches only which candidate wins
  once gathered, not how any individual candidate is located.

## Dependencies

- None beyond what already exists: Node >=22 (already required by the skill), the monorepo's own
  `packages/cli` build output.

## Notes

- This spec was split out of an earlier, broader proposal
  (`010-cli-staleness-and-tts-truncation`, since renamed/narrowed to
  `010-cli-resolution-freshness`) that also covered a Kokoro TTS narration-truncation fix. That fix
  is tracked separately in `011-tts-narration-length-guard`; this change is CLI resolution only.
- The original proposal's design (embedding a build-time freshness signal and comparing it at
  resolution time) was replaced, after party review, with the simpler unconditional
  monorepo-first ordering described here — see `proposal.md`'s revision note and
  `party-report.md` (from the pre-split, bundled proposal) for the review that motivated the
  change.
