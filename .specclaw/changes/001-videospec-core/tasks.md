# Tasks: VideoSpec Schema, Timeline Compiler & Core Contract

**Change:** 001-videospec-core
**Created:** 2026-09-06
**Total Tasks:** 13

## Summary

13 tasks across 4 waves. Wave 1 scaffolds the monorepo. Wave 2 builds the schema layer
(schema/layers/types/diagnostics) — these are interdependent and land together. Wave 3 builds
the pieces that consume the schema (resolve, easing, timeline, json-schema) in parallel since
none of them depend on each other, only on Wave 2. Wave 4 is the golden/integration test pass
and package-level wiring.

## Tasks

### Wave 1 — Monorepo scaffolding

- [ ] `T1` — pnpm workspace + root config
  - Files: `pnpm-workspace.yaml`, `tsconfig.base.json`, root `package.json`, `.gitignore` (append)
  - Estimate: small
  - Kind: config
  - Depends: none
  - Notes: root `package.json` scripts should just fan out via `pnpm -r run <script>` — no
    build orchestrator (turbo/nx) needed for a 1-package workspace.

- [ ] `T2` — `packages/core` package scaffold
  - Files: `packages/core/package.json`, `packages/core/tsup.config.ts`,
    `packages/core/vitest.config.ts`
  - Estimate: small
  - Kind: config
  - Depends: T1
  - Notes: deps `zod`, `zod-to-json-schema`; devDeps `typescript`, `tsup`, `vitest`. No other
    runtime deps — NFR1 (zero I/O) is partly enforced by what's in this file.

### Wave 2 — Schema layer

- [ ] `T3` — `schema.ts` + `types.ts`: VideoSpec, Scene
  - Files: `packages/core/src/schema.ts`, `packages/core/src/types.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T2
  - Notes: `version` literal `1`; `width`/`height`/`fps`/`background`/`meta`/`audio` per
    spec.md FR1; `sceneSchema` per FR2, `duration: z.union([z.number().min(0), z.literal("auto")])`;
    scene-id uniqueness via `superRefine`. `layers` field forward-references `layers.ts`'s
    `layerUnion()` via `z.lazy` (written in T4) — stub it against `z.any()` if sequencing
    requires, then wire for real once T4 lands (same PR wave, not a follow-up task).

- [ ] `T4` — `layers.ts`: layer union, registry, `registerLayer()`, nesting cap
  - Files: `packages/core/src/layers.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T2
  - Notes: `text`/`rect`/`image`/`group` per spec.md FR3/FR4; shared base shape (`x`/`y`/
    `start`/`duration`/`animation`) factored into one Zod base merged into each variant, not
    duplicated 4 times; `animation.enter`/`exit` as `z.string().optional()` (Key Decision 2 —
    not a fixed enum); 2-level nesting cap via `superRefine` producing a diagnosable Zod issue
    (not a thrown error).

- [ ] `T5` — `diagnostics.ts`: `parseSpec`, `Diagnostic`
  - Files: `packages/core/src/diagnostics.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T3, T4
  - Notes: Zod issue `path: (string|number)[]` → JSON pointer string; a small lookup table
    for suggestion text keyed on Zod issue `code` (`too_big`/`too_small`/`invalid_type`/
    `invalid_literal`) covers the common cases per spec.md FR5 ("best-effort, not exhaustive").

### Wave 3 — Consumers of the schema (parallel)

- [ ] `T6` — `easing.ts`: easing catalogue
  - Files: `packages/core/src/easing.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T2
  - Notes: pure numeric functions only, no dependency on schema.ts/layers.ts at all — can
    build alongside Wave 2, listed here only because Wave 3 is otherwise "consumes the schema."

- [ ] `T7` — `resolve.ts`: coordinate/style resolution
  - Files: `packages/core/src/resolve.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T3, T4
  - Notes: `resolveAxis` per design.md; percentage parsing via `parseFloat` + `%` suffix check,
    not a regex (simpler, same correctness for this input shape).

- [ ] `T8` — `timeline.ts`: `compileTimeline`, `Timeline`, `activeAt`
  - Files: `packages/core/src/timeline.ts`
  - Estimate: large
  - Kind: impl
  - Depends: T3, T4, T7
  - Notes: `framesFor` via `Math.round` (Key Decision 5); integer-only frame-cursor
    accumulation (NFR4); `MissingAudioDurationError` named export thrown per FR7; `activeAt`
    binary-searches `sceneWindows`. This is the task with the most acceptance criteria riding
    on it (AC4–AC8) — write the golden tests (T11) against this file first if useful for TDD,
    but the task itself is the implementation.

- [ ] `T9` — `json-schema.ts`: `generateJsonSchema()`
  - Files: `packages/core/src/json-schema.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T3, T4
  - Notes: thin wrapper over `zod-to-json-schema(videoSpecSchema)`. Keep it a one-liner plus
    export — no hand-authored schema fields (FR10).

### Wave 4 — Integration, exports, golden tests

- [ ] `T10` — `index.ts`: public exports
  - Files: `packages/core/src/index.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T3, T4, T5, T6, T7, T8, T9
  - Notes: export surface exactly as listed in design.md's API Changes section — no
    internal-only symbols (the registry Map, `resolveAxis`, `framesFor`) leaked.

- [ ] `T11` — Golden timeline tests
  - Files: `packages/core/test/timeline.test.ts`
  - Estimate: medium
  - Kind: test
  - Depends: T8
  - Notes: covers AC4 (fractional durations, contiguous windows), AC5 (1-hour/86,400-frame
    drift proof), AC6/AC7 (`duration: "auto"` throw vs resolve), AC8 (`activeAt` subset
    window), plus edge cases from spec.md (zero-length scene, non-dividing fps).

- [ ] `T12` — Schema/layers/diagnostics/registry tests
  - Files: `packages/core/test/schema.test.ts`, `packages/core/test/layers.test.ts`,
    `packages/core/test/diagnostics.test.ts`
  - Estimate: medium
  - Kind: test
  - Depends: T5
  - Notes: covers AC1–AC3, AC9 (registerLayer with a simulated `caption` type), duplicate
    scene-id rejection, nesting-cap diagnostic path correctness.

- [ ] `T13` — Resolve/easing/json-schema tests + package build verification
  - Files: `packages/core/test/resolve.test.ts`, `packages/core/test/easing.test.ts`,
    `packages/core/test/json-schema.test.ts`
  - Estimate: small
  - Kind: test
  - Depends: T6, T7, T9, T10
  - Notes: covers AC10 (JSON Schema round-trip against a real validator, e.g. `ajv`, added as
    a devDep for this test only) and AC11 (`pnpm --filter @claudevid/core build && test`
    green from a clean checkout — run both as the final step of this task).

---

## Legend

- `[ ]` Pending
- `[~]` In Progress
- `[x]` Complete
- `[!]` Failed
