# Tasks: CLI resolution always prefers the monorepo build over a stale global install

**Change:** 010-cli-resolution-freshness
**Created:** 2026-09-09
**Total Tasks:** 4

## Summary

Small, two-wave change: build and test the shared resolver first (it has no dependents yet, so it
can be fully verified in isolation), then wire both skill scripts to it and update the one doc that
currently states the old resolution order as fact.

## Tasks

### Wave 1 — Shared resolver

- [x] `T1` — Create `resolve-cli.mts` with `pickCli()` (pure) and `resolveCli()` (ambient wrapper)
  - Files: `.claude/skills/video-generator/scripts/resolve-cli.mts` (new)
  - Estimate: small
  - Kind: impl
  - Notes: `pickCli(candidates)` takes `{ monorepoDistPath: string | null, localDepResolve: (() => string) | null, globalOnPath: boolean }` and returns `{ command, prefixArgs }` per design.md's priority order (monorepo dist, if present, unconditionally beats both other layouts). `resolveCli(here)` gathers real candidates (`fs.existsSync` on the fixed relative monorepo path already used today, `createRequire(...).resolve("claudevid/cli")` in a try/catch, `spawnSync("claudevid", ["--version"])`) and calls `pickCli()`. Preserve today's exact error message text for the all-three-missing case (spec.md AC3).

### Wave 2 — Tests, call sites, and docs

- [ ] `T2` — Unit tests for `pickCli()`
  - Files: `.claude/skills/video-generator/scripts/resolve-cli.test.mts` (new)
  - Estimate: small
  - Kind: test
  - Depends: T1
  - Notes: Use Node's built-in `node:test` + `node:assert` (no new dependency, no package.json). Cover spec.md's Acceptance Criteria 1-3: (a) monorepo path present + local dep present + global present → monorepo wins; (b) monorepo path absent + local dep present + global present → local dep wins (today's behavior preserved); (c) monorepo absent + local dep absent + global present → global wins; (d) all three absent → throws the three-option message. Run via `node --test scripts/resolve-cli.test.mts` from `.claude/skills/video-generator/`.

- [ ] `T3` — Point `render.mts` and `validate.mts` at the shared resolver
  - Files: `.claude/skills/video-generator/scripts/render.mts`, `.claude/skills/video-generator/scripts/validate.mts`
  - Estimate: small
  - Kind: refactor
  - Depends: T1
  - Notes: Delete each script's own inline `resolveCli()` function; import `resolveCli` from `./resolve-cli.mts` instead. The rest of each script (computing `here`, calling `resolveCli(here)`, `spawnSync`-ing the result with forwarded argv, propagating the exit code) is unchanged — this is a like-for-like swap of the resolution function's source, not a behavior change to the scripts' own structure.

- [ ] `T4` — Update `SKILL.md`'s resolution-order documentation
  - Files: `.claude/skills/video-generator/SKILL.md`
  - Estimate: small
  - Kind: docs
  - Depends: T1
  - Notes: The "Prerequisite" section's numbered list currently states the monorepo path is checked third, as a fallback. Rewrite it to state the actual order this change implements: the monorepo path wins unconditionally when present (i.e. when running from inside, or alongside, a claudevid monorepo checkout), and the local-dependency-then-global order applies only when no monorepo checkout is present. Keep the "if none is present" failure-message sentence accurate to T1's preserved error text.

---

## Legend

- `[ ]` Pending
- `[~]` In Progress
- `[x]` Complete
- `[!]` Failed

**Task format:**
```
- [ ] `T<n>` — <title>
  - Files: <files to create/modify>
  - Estimate: small | medium | large
  - Kind: docs | test | config | refactor | impl | migration   (optional; hints the build subagent's role, tools, and model)
  - Depends: <task ids> (if any)
  - Notes: <additional context>
```
