# Design: CLI, Claude Director Loop & Claude Code Skill

**Change:** 007-cli-claude-skill
**Created:** 2026-09-07

## Technical Approach

Two new workspace packages plumb the six shipped packages together, plus a `.claude/skills/`
folder that shells out to the built CLI rather than re-implementing anything:

```
prompt ──▶ packages/claude (generate.ts, chapters.ts) ──▶ VideoSpec JSON
                                                              │
                                            packages/core.parseSpec (validate)
                                                              │
                                        packages/cli render-pipeline.ts (FR9)
                     ┌────────────────────────────┼────────────────────────────┐
              compileTimeline                synthesize/align            probe/encode/mux
           (@claudevid/core)              (@claudevid/audio)      (@claudevid/encoder-ffmpeg,
                                                                    @claudevid/audio mux.ts)
                     └────────────────────────────┴────────────────────────────┘
                                       renderer-canvas.renderFrame
                                                    │
                                               <out>.mp4
```

`packages/cli` owns orchestration (argv parsing, the shared render pipeline, wiring). `packages/
claude` owns everything Anthropic-specific (the API client, the repair loop, chapters, the
generated director prompt/schema). Neither package touches the shipped packages' internals — every
call in the diagram above is an existing public export, verified in spec.md's Dependencies.

## Architecture

### `packages/cli` (`@claudevid/cli`, bin: `claudevid`)

```
src/
  cli.ts                 — entry point; imports layer-code/layer-captions for side effects
                            (NFR5), dispatches argv[2] to a command module
  args.ts                — shared flag-parsing helpers (--width, --out, etc.), ArgError
  config.ts              — loads claudevid.config.json, merges CLI flag overrides (FR7)
  render-pipeline.ts      — runRenderPipeline() (FR9), shared by preview/render/generate --render/batch
  commands/
    init.ts               (FR1)
    validate.ts            (FR2)
    preview.ts             (FR3)
    render.ts              (FR4)
    generate.ts            (FR5, thin: argv -> packages/claude's generateSpec + optional render)
    batch.ts               (FR6)
    models.ts              (FR13, wraps @claudevid/audio installModels)
    bench.ts               (FR14, wraps @claudevid/bench runBench)
test/
  <mirrors src/, one file per module>
```

### `packages/claude` (`@claudevid/claude`)

```
src/
  types.ts                — StyleContract, ChapterOutline, GenerateResult
  config-schema.ts         — Zod BrandKitConfig (FR7), inferred type
  anthropic-client.ts      — thin wrapper: createMessage(system, schema, messages) -> object,
                              seam for tests (NFR3); real impl uses @anthropic-ai/sdk
  generate.ts              — generateSpec() bounded repair loop (FR5)
  chapters.ts               — outline(), mergeChapters(), SceneIdCollisionError (FR12)
  prompts/
    build-director-prompt.ts — pure function: (catalogue, bundledLangs, bundledThemes, brand) -> string
    video-director.md        — COMMITTED, generated
  schemas/
    video-spec.schema.json   — COMMITTED, generated (FR10)
  examples/
    simple-title.json, code-demo.json, tutorial.json, vertical-short.json
scripts/
  generate-assets.ts        — regenerates prompts/video-director.md, schemas/video-spec.schema.json,
                              and syncs .claude/skills/video-generator/{schemas,examples}/
test/
  generate.test.ts, chapters.test.ts, generated-assets.test.ts (the drift check, AC7)
```

### `.claude/skills/video-generator/`

```
SKILL.md
schemas/video-spec.schema.json   — synced copy, byte-identical (AC7)
examples/*.json                 — synced copies
scripts/
  validate.ts   — execFileSync(node, [<repo>/packages/cli/dist/cli.js, "validate", ...argv])
  render.ts     — execFileSync(node, [<repo>/packages/cli/dist/cli.js, "render", ...argv])
```

No package.json, no build step, no duplicated logic — `SKILL.md` states the one-time `pnpm build`
prerequisite. This mirrors the constraint that drove FR11: the skill must read the schema/examples
with zero build step, but the *scripts* may assume the workspace has been built once, since they
invoke the already-built CLI rather than re-implementing validate/render themselves.

### `templates/` (repo root, `claudevid init` scaffolding source)

```
templates/
  claudevid.config.json   — default config init copies
  example-spec.json        — same content as packages/claude/examples/simple-title.json
                             (init copies this one, not the whole examples/ directory)
```

## File Changes Map

| File | Action | Description |
|------|--------|-------------|
| `packages/cli/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts` | Create | New workspace package, `bin: { claudevid: "./dist/cli.js" }` |
| `packages/cli/src/cli.ts` | Create | Entry, side-effect imports, dispatch |
| `packages/cli/src/args.ts` | Create | Shared flag parsing (NFR2) |
| `packages/cli/src/config.ts` | Create | Config load + merge (FR7) |
| `packages/cli/src/render-pipeline.ts` | Create | `runRenderPipeline` (FR9) |
| `packages/cli/src/commands/*.ts` | Create | One file per command (FR1–FR6, FR13, FR14) |
| `packages/cli/test/*.test.ts` | Create | Unit tests per command/module |
| `packages/claude/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts` | Create | New workspace package |
| `packages/claude/src/types.ts` | Create | Shared types |
| `packages/claude/src/config-schema.ts` | Create | `BrandKitConfig` Zod schema (FR7) |
| `packages/claude/src/anthropic-client.ts` | Create | API client + test seam |
| `packages/claude/src/generate.ts` | Create | Repair loop (FR5) |
| `packages/claude/src/chapters.ts` | Create | Outline/merge (FR12) |
| `packages/claude/src/prompts/build-director-prompt.ts` | Create | Prompt assembly (FR8) |
| `packages/claude/prompts/video-director.md` | Create (generated) | Committed |
| `packages/claude/schemas/video-spec.schema.json` | Create (generated) | Committed (FR10) |
| `packages/claude/examples/*.json` | Create | 4 worked examples |
| `packages/claude/scripts/generate-assets.ts` | Create | Regeneration + skill sync script |
| `packages/claude/test/*.test.ts` | Create | Repair loop, chapters, drift check (AC7) |
| `.claude/skills/video-generator/SKILL.md` | Create | Usage doc |
| `.claude/skills/video-generator/schemas/video-spec.schema.json` | Create (synced) | Committed copy |
| `.claude/skills/video-generator/examples/*.json` | Create (synced) | Committed copies |
| `.claude/skills/video-generator/scripts/validate.ts`, `render.ts` | Create | Exec wrappers |
| `templates/claudevid.config.json`, `templates/example-spec.json` | Create | `init` scaffolding source |
| `pnpm-workspace.yaml` | No change | `packages/*` glob already covers the two new packages |
| `package.json` (root) | No change | `pnpm -r run build/test/lint` already covers new packages |

## Data Model Changes

No changes to `@claudevid/core`'s `VideoSpec`/`Scene`/`Layer` types. New types, all local to the
two new packages:

```ts
// packages/claude/src/config-schema.ts
export const brandKitConfigSchema = z.object({
  model: z.string().optional(),
  repairAttempts: z.number().int().positive().optional(),
  voice: z.string().optional(),
  brand: z.object({
    palette: z.array(z.string()).optional(),
    fontFamily: z.string().optional(),
    logoPath: z.string().optional(),
  }).optional(),
});
export type BrandKitConfig = z.infer<typeof brandKitConfigSchema>;

// packages/claude/src/types.ts
export interface StyleContract {
  brand: BrandKitConfig["brand"];
  presetCatalogue: CatalogueEntry[];          // from @claudevid/motion exportCatalogue()
  priorChapters: { title: string; summary: string }[];
}
export interface ChapterOutline { title: string; summary: string; }
export interface GenerateResult { spec: VideoSpec; attempts: number; }

// packages/cli/src/render-pipeline.ts
export interface RenderPipelineOptions {
  profileName: "preview" | "final";
  outputPath: string;
  captions?: boolean;
  cpuEncode?: boolean;
  force?: boolean;
  scale?: number;                              // FR3's 1280/spec.width, absent = 1 (native)
}
```

## API Changes

New public exports only — no existing package's export surface changes.

- `@claudevid/claude`: `generateSpec(prompt, opts): Promise<GenerateResult>`,
  `outline(prompt, opts): Promise<ChapterOutline[]>`,
  `mergeChapters(specs: VideoSpec[]): VideoSpec`, `SceneIdCollisionError`,
  `buildDirectorPrompt(catalogue, bundledLangs, bundledThemes, brand): string`,
  `brandKitConfigSchema`, `BrandKitConfig` (type).
- `@claudevid/cli`: no library exports — a `bin` package only (`claudevid`). `runRenderPipeline`
  is exported from `render-pipeline.ts` for the package's own tests, not published as a public API.

## Key Decisions

- **D1 — Captions are a render-time insert, never a `generate` output** (spec.md's forced
  Decision). `runRenderPipeline`'s captions step (FR9) is the *only* place a `type: "captions"`
  layer is ever constructed from scratch in this codebase. This keeps `layer-captions`'s
  `words.min(1)` requirement satisfied by construction — there is no path where an invalid
  (empty-`words`) captions layer reaches `parseSpec` from `generate`'s output, because `generate`
  never emits one.
- **D2 — `runRenderPipeline` takes an already-`parseSpec`'d `VideoSpec`, not a file path.** Keeps
  it decoupled from argv/file I/O (NFR3's testability) — `preview.ts`/`render.ts`/`generate.ts`'s
  `--render` path/`batch.ts` each do their own file read + `parseSpec` + diagnostics-on-failure
  (FR2's exact error-reporting shape), then call the shared function. No behavior is duplicated;
  only the read-and-report wrapper is (intentionally — each caller's success/failure framing
  differs slightly: `generate --render`'s failure message differs from `render`'s).
- **D3 — Batch concurrency is real but bounded, not fire-and-forget.** `--concurrency` (default 1)
  runs a fixed-size worker pool over the job list (a simple `Promise.all` over `concurrency`
  workers each pulling from a shared index, no new dependency) — sequential-by-default matches
  the "overnight batch, don't melt the machine" framing in proposal.md; `--concurrency` is there
  for anyone who wants to trade that off.
- **D4 — The drift check (AC7) regenerates in-memory and compares, it never writes to disk during
  `pnpm test`.** `generate-assets.ts`'s core logic (`buildDirectorPrompt`, `generateJsonSchema`,
  the skill-sync copy) is factored so the test imports the same pure functions the script's `main`
  calls, rather than shelling out to the script and diffing the filesystem — keeps the test fast
  and avoids a test run ever mutating committed files.
- **D5 — `mergeChapters` never renames scene ids.** A collision is reported and thrown, not
  auto-fixed (spec.md FR12) — auto-renaming would silently invalidate any cross-chapter reference
  the model itself wrote into a scene's content, which is a worse failure than a loud merge error.
- **D6 — `claudevid bench` and `models install` are thin wrappers, not reimplementations.** Both
  underlying functions (`runBench`, `installModels`) already exist and are already tested in their
  own packages (005's bench harness, 006's AC10) — this change adds only argv plumbing and exit
  codes, per Rule 2 (Simplicity First).
- **D7 — No new CLI-parsing dependency.** Every command's `parseArgs` follows
  `tools/motion-preview/src/args.ts`'s exact shape (pure function, `ArgError`, injected
  `fs.existsSync`-style seams) — one more manual parser is cheap and keeps `packages/cli`'s
  dependency footprint identical to every other package's philosophy in this repo (NFR2).

## Risks & Mitigations

- **Anthropic API drift / rate limits during tests.** Mitigated by NFR3 — `anthropic-client.ts`'s
  `createMessage` is the single seam every test injects a fake for; the one real-API integration
  test is gated (mirrors 006 AC9 / 008's gated alignment test), not part of the default `pnpm -r
  run test`.
- **Render pipeline integration risk (proposal.md's stated top risk — first change where all six
  others run together).** Mitigated by D2 keeping `runRenderPipeline` a single, directly-testable
  function with injected `synthesize`/`align`/`probe` fixtures (AC3/AC4), rather than only
  exercisable through the full CLI/process boundary.
- **Schema/prompt drift going unnoticed.** Mitigated by AC7's test, which fails loudly the moment
  `@claudevid/core`, `@claudevid/motion`, or `@claudevid/layer-code`'s public surface changes
  without a regeneration — same mechanism as any other golden-file test in this repo.
- **`--captions` cost (forced alignment needs a real ASR model to be meaningful).** Out of scope
  to mitigate further here — 008 already gates its own real-alignment integration test; this
  change's tests exercise the *pipeline wiring* around `align()` via the injected fixture (AC4),
  not alignment quality.
