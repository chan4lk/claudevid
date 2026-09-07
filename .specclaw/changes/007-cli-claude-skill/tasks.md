# Tasks: CLI, Claude Director Loop & Claude Code Skill

**Change:** 007-cli-claude-skill
**Created:** 2026-09-07
**Total Tasks:** 21

## Summary

21 tasks across 6 waves. Wave 1 scaffolds both new packages and the worked examples/templates
everything else reads. Wave 2 builds `packages/claude`'s Anthropic-facing core (client seam,
prompt assembly, chapters) — three independent workstreams once Wave 1's types exist. Wave 3
generates and commits the schema/prompt/skill assets and their drift tests, plus the repair-loop
and chapter tests. Wave 4 builds the `packages/cli` commands that don't need the render pipeline
(`init`, `validate`, `models`, `bench`) in parallel. Wave 5 builds the shared render pipeline and
every command that depends on it. Wave 6 wires the CLI entry point and runs the full-workspace
regression.

## Tasks

### Wave 1 — Package scaffolding & shared examples

- [x] `T1` — Scaffold `packages/cli`
  - Files: `packages/cli/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`,
    `packages/cli/src/args.ts`, `packages/cli/src/config.ts`, `packages/cli/test/config.test.ts`
  - Estimate: medium
  - Kind: config
  - Notes: Per design.md's package layout. `package.json`: `bin: { claudevid: "./dist/cli.js" }`,
    deps on every workspace package listed in spec.md NFR4 plus `@napi-rs/canvas`. `args.ts`:
    shared flag-parsing helpers mirroring `tools/motion-preview/src/args.ts`'s exact shape (pure
    `parseArgs`-style functions, `ArgError`, no external parsing library — NFR2/design.md D7).
    `config.ts`: loads `./claudevid.config.json` if present, validates against
    `packages/claude`'s `brandKitConfigSchema` (stub the import for now if Wave 2 hasn't landed
    yet in a resumed build — otherwise import directly), merges explicit CLI flag overrides on
    top (FR7 — flags win).

- [x] `T2` — Scaffold `packages/claude`
  - Files: `packages/claude/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`,
    `packages/claude/src/types.ts`, `packages/claude/src/config-schema.ts`,
    `packages/claude/test/config-schema.test.ts`
  - Estimate: medium
  - Kind: config
  - Notes: Per design.md Data Model Changes. `config-schema.ts`: `brandKitConfigSchema` (Zod),
    `BrandKitConfig` (inferred type) — every field optional, `{}` must validate. `types.ts`:
    `StyleContract`, `ChapterOutline`, `GenerateResult` plain interfaces (no logic). Add
    `@anthropic-ai/sdk` and `zod` as dependencies.

- [x] `T3` — Worked examples and `init` templates
  - Files: `packages/claude/examples/simple-title.json`, `code-demo.json`, `tutorial.json`,
    `vertical-short.json`, `templates/claudevid.config.json`, `templates/example-spec.json`
  - Estimate: small
  - Kind: impl
  - Notes: Per spec.md FR1/AC1, AC2. Each example is a hand-authored, real `VideoSpec` that
    passes `@claudevid/core`'s `parseSpec` (verify by running `parseSpec` against each once
    written — no test file needed yet, AC2 covers this later). `code-demo.json` uses a `code`
    layer from `@claudevid/layer-code`; `vertical-short.json` uses a 9:16 aspect (e.g. 1080x1920).
    None of the four use a `captions` layer (design.md D1 — `generate` never produces one, so no
    worked example should model that as a hand-authored pattern). `templates/example-spec.json`
    is the same content as `simple-title.json` (design.md's `templates/` note) — copy, don't
    symlink. `templates/claudevid.config.json` is a minimal valid config (can be `{}` or a small
    documented starter — pick a small starter with one `brand.palette` entry as a readable
    example).

### Wave 2 — packages/claude core (independent workstreams, depend on T2)

- [x] `T4` — Anthropic client seam + `generate.ts` repair loop
  - Files: `packages/claude/src/anthropic-client.ts`, `packages/claude/src/generate.ts`,
    `packages/claude/test/generate.test.ts`
  - Estimate: large
  - Kind: impl
  - Depends: T2
  - Notes: Per spec.md FR5/Decisions, design.md D-nothing-new (NFR3's seam). `anthropic-client.ts`
    exports one function, e.g. `createStructuredMessage(opts: { system: string; schema: object;
    messages: Message[]; model: string }): Promise<unknown>` — real implementation calls
    `@anthropic-ai/sdk` with the schema as a tool/structured-output definition; the function
    itself is the injection seam (NFR3), no class needed. `generate.ts`'s `generateSpec(prompt,
    opts): Promise<GenerateResult>` builds the system prompt from `buildDirectorPrompt` (T6 — if
    T6 hasn't landed in this wave's ordering, stub with the schema import only and wire the real
    prompt in once T6 lands, since both are Wave 2), calls the client, runs `parseSpec` on the
    result, and on failure re-calls the client with the diagnostics appended to the message
    history, up to `opts.repairAttempts` (default 3) total attempts. Throws on final failure with
    only the last attempt's diagnostics (spec.md AC5) — do not accumulate all attempts' errors
    into the thrown message. Test file (AC5): fake client returns invalid-then-valid (asserts
    `attempts: 2`), and always-invalid (asserts thrown diagnostics equal last attempt's, not
    first's).

- [x] `T5` — `build-director-prompt.ts`
  - Files: `packages/claude/src/prompts/build-director-prompt.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T2
  - Notes: Per spec.md FR8. Pure function `buildDirectorPrompt(catalogue: CatalogueEntry[],
    bundledLangs: readonly string[], bundledThemes: readonly string[], brand:
    BrandKitConfig["brand"]): string` — no I/O, no imports of `@claudevid/motion`/
    `@claudevid/layer-code` beyond their exported types (the actual `exportCatalogue()`/
    `BUNDLED_LANGS`/`BUNDLED_THEMES` calls happen in T8's `generate-assets.ts`, which passes the
    live values in). Must explicitly instruct: never emit a `type: "captions"` layer (design.md
    D1); use only catalogue preset names for `animation.enter`/`animation.exit`; use only
    `bundledLangs`/`bundledThemes` values for a `code` layer's `lang`/`theme`; compose within the
    brand kit's palette/fontFamily when present rather than inventing colors/fonts.

- [x] `T6` — `chapters.ts`
  - Files: `packages/claude/src/chapters.ts`, `packages/claude/test/chapters.test.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T2
  - Notes: Per spec.md FR12/AC6, design.md D5. `outline(prompt, opts): Promise<ChapterOutline[]>`
    — one call through the same `anthropic-client.ts` seam as T4 (import it, don't reimplement),
    plain JSON array response, no structured-output schema needed (just `JSON.parse` + a minimal
    shape check, throw naming what's missing on a malformed response). `mergeChapters(specs:
    VideoSpec[]): VideoSpec` concatenates `scenes` arrays in order; before returning, scans all
    scene ids for duplicates and throws `SceneIdCollisionError` listing every colliding id — no
    partial merge on failure (AC6). Test file covers AC6's two cases directly against
    `mergeChapters` (no `outline`/API call needed for this half).

### Wave 3 — Generated assets, skill folder, remaining claude-package tests

- [x] `T7` — `generate-assets.ts` + committed generated files
  - Files: `packages/claude/scripts/generate-assets.ts`, `packages/claude/prompts/video-director.md`,
    `packages/claude/schemas/video-spec.schema.json`
  - Estimate: medium
  - Kind: impl
  - Depends: T5
  - Notes: Per spec.md FR8/FR10, design.md D4. Script calls `@claudevid/motion`'s
    `exportCatalogue()`, `@claudevid/layer-code`'s `BUNDLED_LANGS`/`BUNDLED_THEMES`, a loaded
    brand kit (or the default empty config), and T5's `buildDirectorPrompt` to write
    `prompts/video-director.md`; calls `@claudevid/core`'s `generateJsonSchema()` to write
    `schemas/video-spec.schema.json`. Factor the "assemble the prompt string" and "produce the
    schema object" steps as separately-importable functions from this script's own `main()` (not
    just inline in `main`) — T9's drift test imports these, per design.md D4, rather than
    shelling out to this script. Run the script once now to produce the two committed files.

- [x] `T8` — `.claude/skills/video-generator/` folder
  - Files: `.claude/skills/video-generator/SKILL.md`,
    `.claude/skills/video-generator/schemas/video-spec.schema.json`,
    `.claude/skills/video-generator/examples/*.json`,
    `.claude/skills/video-generator/scripts/validate.ts`,
    `.claude/skills/video-generator/scripts/render.ts`,
    (extend) `packages/claude/scripts/generate-assets.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T3, T7
  - Notes: Per spec.md FR11, design.md's skill-folder section. Extend `generate-assets.ts` (T7)
    to also copy `packages/claude/schemas/video-spec.schema.json` and `packages/claude/examples/
    *.json` into this folder's `schemas/`/`examples/` (byte-identical copies, not symlinks — a
    skill folder should be self-contained/zip-friendly). `scripts/validate.ts` and `render.ts`:
    each a short script whose entire body is `execFileSync("node", [path.join(__dirname,
    "../../../../packages/cli/dist/cli.js"), "<command>", ...process.argv.slice(2)], { stdio:
    "inherit" })` (or the equivalent for this repo's actual relative depth — verify the path from
    `.claude/skills/video-generator/scripts/` to `packages/cli/dist/cli.js`) then exit with the
    child's exit code. `SKILL.md`: what this skill does, that `pnpm build` must have been run
    once first, and points at `schemas/video-spec.schema.json` and `examples/` for the JSON
    Schema and worked patterns.

- [x] `T9` — Drift-check test for generated/synced assets
  - Files: `packages/claude/test/generated-assets.test.ts`
  - Estimate: small
  - Kind: test
  - Depends: T7, T8
  - Notes: Per spec.md AC7, design.md D4. Imports `generate-assets.ts`'s exported pure functions
    (not the CLI/script entry) to regenerate the prompt string and schema object in memory, reads
    the committed files from disk, and asserts equality (string equality for the prompt, deep-
    equality for the parsed schema JSON). Separately asserts the four skill-folder copies are
    byte-identical to their `packages/claude` sources. This test never writes to disk.

- [x] `T10` — `chapters.ts` outline test + example-spec validation test
  - Files: `packages/claude/test/chapters.test.ts` (extend T6's file — the `outline()` half),
    `packages/claude/test/examples.test.ts`
  - Estimate: small
  - Kind: test
  - Depends: T3, T6
  - Notes: `outline()` test uses a fake client (same seam as T4) returning a well-formed and a
    malformed chapter-list response. `examples.test.ts` runs `parseSpec` against every file in
    `packages/claude/examples/*.json` and asserts `ok: true` for each (AC2's example half —
    complements Wave 4's invalid-fixture half of AC2).

### Wave 4 — packages/cli commands independent of the render pipeline

- [x] `T11` — `claudevid init`
  - Files: `packages/cli/src/commands/init.ts`, `packages/cli/test/init.test.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T1, T3
  - Notes: Per spec.md FR1/AC1. Copies `templates/claudevid.config.json` to
    `./claudevid.config.json`, `templates/example-spec.json` to `./specs/example.json`, and
    writes `./.claudevid/.gitignore` containing `*`. Refuses (throws `ArgError`, no writes) if
    `./claudevid.config.json` already exists and `--force` is absent; overwrites all three when
    `--force` is set. Test injects a fake filesystem (mirrors `tools/motion-preview`'s
    `assertOutputWritable` DI pattern) — no real disk I/O in the test.

- [x] `T12` — `claudevid validate`
  - Files: `packages/cli/src/commands/validate.ts`, `packages/cli/test/validate.test.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T1
  - Notes: Per spec.md FR2/AC2. Reads the file, wraps `JSON.parse` in a try/catch that reports a
    single diagnostic at pointer `/` on a syntax error (never lets the raw `SyntaxError` escape),
    otherwise runs `parseSpec`. Success path prints scene count + total duration (sum of resolved
    scene durations; `"auto"` scenes are reported as `"auto"`, not computed — this command never
    synthesizes audio) and returns exit 0; failure path prints every diagnostic and returns exit
    1. Test covers both paths plus the malformed-JSON path, using fixtures (including one
    deliberately invalid fixture per AC2).

- [x] `T13` — `claudevid models install` + `claudevid bench`
  - Files: `packages/cli/src/commands/models.ts`, `packages/cli/src/commands/bench.ts`,
    `packages/cli/test/models.test.ts`, `packages/cli/test/bench.test.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T1
  - Notes: Per spec.md FR13/FR14/AC9, design.md D6. `models.ts` calls `@claudevid/audio`'s
    `installModels` (imported directly, not re-seamed — its own package already tests the
    underlying behavior per 006 AC10), prints a one-line success/failure message, sets
    `process.exitCode`. `bench.ts` calls `@claudevid/bench`'s `runBench(argv)` and forwards its
    exit behavior verbatim (add `@claudevid/bench` as a `packages/cli` dependency). Both tests
    inject a fake `installModels`/`runBench` (module-level function reference swap or a thin
    wrapper argument) to assert both success and rejection paths (AC9) without a real download or
    real bench run.

### Wave 5 — Shared render pipeline and its dependent commands

- [x] `T14` — `runRenderPipeline`
  - Files: `packages/cli/src/render-pipeline.ts`, `packages/cli/test/render-pipeline.test.ts`
  - Estimate: large
  - Kind: impl
  - Depends: T1
  - Notes: Per spec.md FR9/AC3/AC4, design.md D1/D2. Signature: `runRenderPipeline(spec:
    VideoSpec, opts: RenderPipelineOptions): Promise<void>`. Steps, in order: (1) if
    `opts.captions`, for each scene with non-empty `narration`, synthesize each block via
    `getOrSynthesize` (inject the underlying `synthesize` fn per its own signature), run `align()`
    against the synthesized audio + block text, and build a `captions` layer whose `words[].start/
    end` are block-relative-plus-cumulative-block-offset — hold this per-scene, absolute-time
    conversion happens after step (2) resolves each scene's `SceneWindow.startFrame` (compile
    first without captions layers inserted, read `sceneWindows`, add `startFrame / spec.fps` to
    every word's start/end, then insert the finished `captions` layer into a working copy of the
    scene and recompile — two `compileTimeline` calls total when captions are on, one when they're
    off; simpler than threading absolute offsets through before compilation exists, and correct
    since `compileTimeline` is pure/side-effect-free); (2) for `"auto"`-duration scenes,
    `computeAudioDurations` then `compileTimeline(spec, {audioDurations})`, else
    `compileTimeline(spec, {})`; (3) `probe()`, `createRenderer(spec.width, spec.height)` (or a
    caller-scaled size, honoring `opts.scale`), `createFrameBuffer`, `createTempRun`,
    `createEncodePipe({ profileName: opts.profileName, ... })`, render every frame via
    `renderer.renderFrame` + `pipe.write`/`pipe.finish()`; (4) if any scene has narration, gather
    every synthesized track, `buildAudioGraphArgv` + `muxOutput` into `opts.outputPath`; else move
    the silent video straight to `opts.outputPath`. Wrap steps 2-4 in `try/finally` disposing the
    renderer and cleaning up the temp run (mirrors `tools/bench/src/bench.ts`'s existing
    try/finally shape exactly). Test file (AC3/AC4): injected `synthesize`/`align`/`probe`/
    `createEncodePipe` fixtures (no real ffmpeg/model) — AC3 asserts the muxed duration call
    matches summed narration durations; AC4 asserts the compiled `Timeline`'s one `captions`
    layer's `words[0].start` equals `sceneWindow.startFrame / fps` plus the fixture's own leading
    offset.

- [x] `T15` — `claudevid preview`
  - Files: `packages/cli/src/commands/preview.ts`, `packages/cli/test/preview.test.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T12, T14
  - Notes: Per spec.md FR3. Reads + `parseSpec`s the file (reusing T12's read/report shape,
    design.md D2), calls `runRenderPipeline` with `profileName: "preview"` and `opts.scale =
    1280 / spec.width` when the spec is wider than 1280 (native size otherwise — never upscale).
    `--watch`: `fs.watch` on the spec path, 250ms debounce, re-runs the same call on change,
    logging each re-render; `--sheet <path>`: skip `runRenderPipeline` entirely, instead render N
    (default 6, `--frames`, max e.g. 24 mirroring `tools/motion-preview`'s own cap) evenly-spaced
    frames via `createRenderer`/`renderFrame` directly and composite them into one grid PNG via
    `@napi-rs/canvas`, written to `<path>`. Test covers argument validation and the non-watch,
    non-sheet render call (fixture-backed, no real render).

- [x] `T16` — `claudevid render`
  - Files: `packages/cli/src/commands/render.ts`, `packages/cli/test/render.test.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T12, T14
  - Notes: Per spec.md FR4/Edge Cases. Reads + `parseSpec`s the file, refuses to overwrite an
    existing `--out` unless `--force` (same no-clobber rule as `init`/`tools/motion-preview`),
    then calls `runRenderPipeline` with `profileName: "final"`, no scale override, `opts.captions`
    from `--captions`. Test covers the no-clobber guard and the fixture-backed pipeline call.

- [x] `T17` — `claudevid generate` (CLI command, wraps packages/claude's `generateSpec`)
  - Files: `packages/cli/src/commands/generate.ts`, `packages/cli/test/generate.test.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T4, T12, T14
  - Notes: Per spec.md FR5. Fails fast (before any network call) if `ANTHROPIC_API_KEY` is unset
    (Edge Cases). Calls `@claudevid/claude`'s `generateSpec(prompt, { model, repairAttempts,
    apiKey })`, writes the resulting spec to `--out` (default `specs/<slug>.json`, slug derived
    from the prompt — simple lowercase/hyphenate, truncate to a fixed length, no collision
    handling beyond what `--out` overriding already provides), re-runs `parseSpec` on the written
    file as a final check (spec.md FR5), and — if `--render` — calls `runRenderPipeline` against
    the result with `profileName: "final"`. Test injects a fake `generateSpec` (module-level
    swap) — no real Anthropic call.

- [x] `T18` — `claudevid batch`
  - Files: `packages/cli/src/commands/batch.ts`, `packages/cli/test/batch.test.ts`
  - Estimate: medium
  - Kind: impl
  - Depends: T17
  - Notes: Per spec.md FR6/AC8, design.md D3. Reads every `*.json` in `<dir>`, classifies each as
    a prompt-list entry (`{ prompt, out? }`) or a pre-built spec by attempting `parseSpec` first
    (a file that parses as a valid `VideoSpec` is treated as a ready spec — skip generation, go
    straight to render if `--render`; otherwise expect the `{ prompt }` shape and error naming
    which shape check failed if neither matches — Edge Cases). Runs a fixed-size worker pool
    (`--concurrency`, default 1) pulling from a shared job index (design.md D3 — no new
    dependency, plain `Promise.all` over N workers). Writes `<dir>/batch-manifest.json`
    incrementally (append/rewrite after each job completes) with `{ file, status, error?,
    outputPath? }` per job; process exit code is always 0 once the queue itself ran, regardless
    of individual job outcomes (AC8). Test: 3 fixture jobs, one deliberately malformed, asserts
    the manifest shape and the process exit code.

### Wave 6 — Entry point wiring and full regression

- [x] `T19` — `cli.ts` entry point
  - Files: `packages/cli/src/cli.ts`
  - Estimate: small
  - Kind: impl
  - Depends: T11, T12, T13, T15, T16, T17, T18
  - Notes: Per spec.md NFR5. Unconditionally imports `@claudevid/layer-code` and
    `@claudevid/layer-captions` before dispatching (their registration side effects must run
    before any `parseSpec`/`compileTimeline`/`renderFrame` call, regardless of which command runs)
    — then a plain `switch` on `process.argv[2]` to each command module's exported run function,
    unknown-command and no-command help text, non-zero exit on an unhandled rejection from any
    command (mirrors `tools/motion-preview/src/cli.ts`'s `main().catch(...)` shape).

- [x] `T20` — `@claudevid/claude` package build verification
  - Files: none (verification only)
  - Estimate: small
  - Kind: test
  - Depends: T9, T10
  - Notes: `pnpm --filter @claudevid/claude run build && pnpm --filter @claudevid/claude run test
    && pnpm --filter @claudevid/claude run lint` pass in isolation before Wave 6's full-workspace
    pass, to localize any failure to this package specifically.

- [x] `T21` — Full-workspace regression
  - Files: none (verification only)
  - Estimate: small
  - Kind: test
  - Depends: T19, T20
  - Notes: Per spec.md AC10. `pnpm -r run build`, `pnpm -r run test`, `pnpm -r run lint` from a
    clean state; confirm 001–006/008's existing suites are unaffected (no shared-package files
    were touched by this change, so this is a regression guard, not expected to surface new
    failures). Also manually smoke-run `claudevid init && claudevid validate specs/example.json`
    in a scratch directory as the cheapest real (non-mocked) end-to-end check available without a
    live Anthropic key or a real FFmpeg-heavy render.

---

## Legend

- `[ ]` Pending
- `[~]` In Progress
- `[x]` Complete
- `[!]` Failed
