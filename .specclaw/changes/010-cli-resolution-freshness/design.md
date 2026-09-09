# Design: CLI resolution always prefers the monorepo build over a stale global install

**Change:** 010-cli-resolution-freshness
**Created:** 2026-09-09

## Technical Approach

Extract the resolution logic currently duplicated in `render.mts` and `validate.mts`'s own
`resolveCli()` functions into one new module, split into a pure decision function and a thin
ambient-gathering wrapper:

```ts
// resolve-cli.mts

export interface CliCandidates {
  monorepoDistPath: string | null;   // the path if it exists, else null
  localDepResolve: (() => string) | null; // present iff a local `claudevid` dependency resolves
  globalOnPath: boolean;             // true iff `claudevid --version` succeeds on PATH
}

export interface CliTarget {
  command: string;
  prefixArgs: string[];
}

/** Pure: no fs, no process, no PATH lookup. Unit-testable with plain data. */
export function pickCli(candidates: CliCandidates): CliTarget {
  if (candidates.monorepoDistPath) {
    return { command: "node", prefixArgs: [candidates.monorepoDistPath] };
  }
  if (candidates.localDepResolve) {
    return { command: "node", prefixArgs: [candidates.localDepResolve()] };
  }
  if (candidates.globalOnPath) {
    return { command: "claudevid", prefixArgs: [] };
  }
  throw new Error(
    "Could not locate the claudevid CLI. Install it in this project (`npm install claudevid`), " +
      "install it globally (`npm install -g claudevid`), or run this script from inside the " +
      "claudevid monorepo after `pnpm build`.",
  );
}

/** Thin ambient wrapper: gathers real candidates, then delegates to pickCli(). */
export function resolveCli(here: string): CliTarget {
  const monorepoDistPath = /* path.resolve(here, "../../../../packages/cli/dist/cli.js"), or null if !existsSync */;
  const localDepResolve = /* () => createRequire(...).resolve("claudevid/cli"), or null if it throws */;
  const globalOnPath = /* spawnSync("claudevid", ["--version"]).error == null */;
  return pickCli({ monorepoDistPath, localDepResolve, globalOnPath });
}
```

`render.mts` and `validate.mts` shrink to: compute `here`, call `resolveCli(here)`, `spawnSync` the
result with the forwarded argv — identical to today's tail end of each script, just sourced from
one shared module instead of two copies.

The priority reordering itself is the whole fix: today's `resolveCli()` checks the monorepo path
*last*, purely as a fallback for a non-monorepo caller with neither a local dependency nor a global
install. Moving that check first — and making it unconditional whenever the path exists — needs no
new signal, comparison, or flag, because there is nothing being compared: presence of the monorepo
build is itself the decision.

## Architecture

No architectural change to the render/validate pipeline itself — this is confined to the two
skill wrapper scripts' own CLI-location logic, which sits entirely outside `packages/`. The new
module is deliberately *not* added to the pnpm workspace (`pnpm-workspace.yaml` lists only
`packages/*` and `tools/*`) and gets no `package.json` of its own, preserving the skill folder's
existing "droppable into any host project, Node-only, no install step" property (`SKILL.md`:
"a Python or Go repo gets the skill folder alone, with no `package.json` or `node_modules` of its
own").

## File Changes Map

| File | Action | Description |
|------|--------|-------------|
| `.claude/skills/video-generator/scripts/resolve-cli.mts` | Create | Shared resolver: `pickCli()` (pure) + `resolveCli()` (ambient wrapper), replacing both scripts' inline `resolveCli()`. |
| `.claude/skills/video-generator/scripts/resolve-cli.test.mts` | Create | Unit tests for `pickCli()` via Node's built-in `node:test`/`node:assert` — no filesystem, no process spawning. |
| `.claude/skills/video-generator/scripts/render.mts` | Modify | Replace inline `resolveCli()` with `import { resolveCli } from "./resolve-cli.mts"`; call site otherwise unchanged. |
| `.claude/skills/video-generator/scripts/validate.mts` | Modify | Same replacement as `render.mts`. |
| `.claude/skills/video-generator/SKILL.md` | Modify | Update the "Prerequisite" section's numbered resolution-order list to state the monorepo-first rule (see Grounding sources below — this doc currently documents the *old* order as authoritative). |

## Data Model Changes

None — this change has no schema, spec, or persisted-data surface.

## API Changes

None — `render.mts`/`validate.mts`'s own CLI surface (forwarding argv to `render`/`validate`) is
unchanged; only which underlying `claudevid` build handles that forwarded call changes, and only
when a monorepo checkout is present.

## Key Decisions

- **Unconditional monorepo-first, not a freshness comparison.** The original (pre-split) proposal
  planned to embed a build timestamp or commit hash and compare it against whichever build resolved
  first. Party review found that design under-specified in three separate ways (which flag, which
  format, what happens when an old build predates the flag entirely) and structurally incomplete
  (it only compared against the *global* install, leaving a stale local dependency unguarded). This
  design has none of those problems because it makes no comparison: whenever a monorepo checkout is
  present, it is used, full stop.
- **Pure/ambient split for testability.** Party review specifically flagged that a "fixture spec"
  cannot express a global-vs-monorepo mismatch, since the condition depends on `PATH` and disk
  state, not spec content. Splitting `pickCli()` (pure, takes already-resolved candidates) from
  `resolveCli()` (the ambient gathering step) means the priority logic itself — the actual thing
  this change fixes — is tested with plain data, with no environment dependency at all.
- **`node --test`, not a new test framework.** `.claude/skills/video-generator/` has no
  `package.json` and is not part of the pnpm workspace; adding one (or a `vitest.config.ts`) to gain
  a test runner would compromise the "drop this folder into any host project" property `SKILL.md`
  documents. Node's built-in test runner needs no dependency and no config file, and the project
  already requires Node >=22.
- **No opt-out flag in this change.** The proposal's Open Questions ask whether a deliberate
  "use the global install even though a monorepo checkout is present" use case exists (e.g. testing
  the published package's exact behavior from within the monorepo). No such use case surfaced during
  planning; if one emerges later, an env var (e.g. `CLAUDEVID_FORCE_GLOBAL=1`) is the natural
  addition, but is not built speculatively here.

## Grounding sources

- `.claude/skills/video-generator/SKILL.md` — "They locate it in one of three ways, in this
  order: 1. Installed as a dependency... 2. Installed globally... 3. Inside the claudevid
  monorepo: `packages/cli/dist/cli.js`, which exists only after `pnpm build` at the repo root."
  This is the doc that needs updating alongside the code change — it currently states the
  monorepo path as a last resort, which will no longer be accurate once this change ships.
- `packages/cli/src/cli.ts` — confirms the CLI has no existing `--version`/`--build-info` flag
  handling today (any unrecognized `process.argv[2]` falls through to printing `USAGE` and exit
  code 1); this is additional confirmation that the simpler, flag-free design in this change
  avoids inventing a CLI surface the codebase doesn't already have a place for.
- `pnpm-workspace.yaml` — `packages: ["packages/*", "tools/*"]` confirms `.claude/skills/` is
  outside the workspace, supporting the decision not to add a workspace package/test framework
  there.

## Risks & Mitigations

- **Risk:** someone relies today on a global install being used even when a monorepo checkout
  happens to sit alongside it (e.g. deliberately validating the published package's behavior from
  within the monorepo). **Mitigation:** no such use case surfaced in review or planning; flagged as
  an open question in the proposal. If it turns out to matter, an explicit opt-out env var is a
  small follow-up, not a redesign.
- **Risk:** a partially-built or stale-but-present `packages/cli/dist/cli.js` (e.g. an interrupted
  `pnpm build`) now gets used unconditionally instead of falling back to a working global install.
  **Mitigation:** this is no worse than today's behavior for a caller with *no* global/local
  install at all (today's fallback case already just uses whatever's at that path); this change
  does not add a new failure mode, it changes which existing failure mode a caller with multiple
  candidates can hit.
