### [BLOCK] party-architect — Freshness signal is only consulted at one of the three named resolution steps, leaving step (a) unguarded by the proposal's own arrow
**Quotes:** > Each of the three resolvable CLI layouts (local dependency, global install, monorepo dist) gets a
>   cheap, comparable freshness signal
**Quotes:** > and it picks the *global* install over that local monorepo build,
>   compare the two builds' freshness signals.
**Quotes:** > `.claude/skills/video-generator/scripts/{render,validate}.mts` resolve the `claudevid` CLI in this
> order: (a) a `claudevid` dependency in the caller's `node_modules`, (b) a globally-installed
> `claudevid` on `PATH`, (c) `packages/cli/dist/cli.js` inside the monorepo
**Problem:** The artifact states step (a) — a `claudevid` dependency in the caller's `node_modules` — wins over both (b) and (c), and that all three layouts get a freshness signal. But the comparison it specifies fires only when the *global* install is picked over the monorepo build. A stale `node_modules` copy, which by the artifact's own ordering beats the global install and the monorepo dist, produces exactly the reported failure mode with no warning. Either the signal on layout (a) is dead weight the build step still has to emit, or the comparison rule is under-scoped; as written the two bullets contradict each other about how many layouts participate.
**Fix:** State the comparison as "the resolved build vs. the monorepo build, whenever the monorepo build exists", covering (a) and (b) uniformly — or drop the freshness signal from layout (a) and say why it is exempt.
**Status:** upheld

### [BLOCK] party-architect — Two scripts named as separate copies of `resolveCli()`, and the proposal declines to say whether they converge in this commit
**Quotes:** > `.claude/skills/video-generator/scripts/{render,validate}.mts` resolve the `claudevid` CLI in this
> order: (a) a `claudevid` dependency in the caller's `node_modules`, (b) a globally-installed
> `claudevid` on `PATH`, (c) `packages/cli/dist/cli.js` inside the monorepo (see each script's own
> `resolveCli()`).
**Quotes:** > `.claude/skills/video-generator/scripts/render.mts` and `validate.mts` (or their shared
>   `resolveCli()` logic, wherever it ends up factored)
**Problem:** "each script's own `resolveCli()`" says the resolution logic is already duplicated twice. The change adds freshness comparison, embedded-signal parsing, and a warning format to that logic. "wherever it ends up factored" defers the decision to the implementer, so the likely outcome is the new comparison logic duplicated a third and fourth time across the two scripts, diverging on the first tuning change to the warning threshold or format. This is a placement decision the proposal is positioned to make and does not.
**Fix:** Commit in the artifact to either extracting a single shared resolver module (naming its location) before adding the check, or to duplicating deliberately with a stated reason the two scripts cannot share.
**Status:** upheld

### [BLOCK] party-architect — The freshness signal's producer and consumer are separate build-time and runtime contracts, neither specified
**Quotes:** > the simplest viable option is each build embedding its own
>   build timestamp (or the monorepo's current git commit hash, when running `pnpm build` inside a
>   git checkout) into `dist/cli.js` at build time, readable via `claudevid --version` or a new
>   `--build-info` flag.
**Quotes:** > Is a build timestamp or a git commit hash the more useful freshness signal for `--build-info` —
**Quotes:** > If the monorepo build is newer, print a clear stderr
>   warning naming both build identifiers and which one was actually used, before proceeding
**Problem:** Three separate contracts are left for the implementer to guess. (1) Which flag carries the signal — `--version` or a new `--build-info` — is stated as a disjunction, and the two have different output grammars and different back-compat consequences for anything already parsing `--version`. (2) The signal's format is an open question, and the choice is not cosmetic: "if the monorepo build is newer" is a total order over timestamps but is *undefined* over commit hashes without git history, so the comparison algorithm changes shape depending on which is picked. (3) The consumer must read the signal out of a build the resolver may not be able to execute the same way — the artifact says "readable via" a flag, i.e. by spawning the resolved binary, but never says what happens when the resolved build predates the flag's existence and exits nonzero or prints nothing. Every global install currently on any machine is in exactly that state, which is the population this check exists to catch.
**Fix:** Fix one flag, one format, and specify the comparison including the missing-signal case (an older build that does not know the flag) as an explicit branch with a defined warning.
**Status:** upheld

### [BLOCK] party-architect — Auto-chunking is placed at the wrong seam relative to the durations record the proposal itself names
**Quotes:** > as a stronger option, auto-split an over-length block
>     into sentence-aligned sub-blocks before calling `synthesize()`, the same shape as the manual
>     workaround already in use
**Quotes:** > because a
> scene's `"auto"` duration is computed directly from the (silently truncated) synthesized audio's own
> length
**Quotes:** > (each block is already synthesized and measured independently per
> `render-pipeline.ts`'s `synthesizeNarration`/`computeAudioDurationsRecord`)
**Problem:** The artifact says blocks are synthesized *and measured* independently, and that `computeAudioDurationsRecord` is a separate function from `synthesizeNarration`. Splitting one authored block into N sub-blocks inside `synthesizeNarration` changes the cardinality of the thing the durations record is keyed on. The proposal names `computeAudioDurationsRecord` as an existing consumer and then does not list it as a co-change: it must either re-merge N sub-durations back to one authored block index, or every downstream consumer of that record (timeline, `"auto"` duration, any subtitle or caption index) must learn about sub-blocks. The manual workaround is not "the same shape" — there the author edits the `narration` array, so block count in the spec and block count at synthesis agree; auto-chunking makes them disagree.
**Fix:** Name `computeAudioDurationsRecord` and every consumer of the block index as co-changes and state whether sub-block durations are summed back to the authored index, or move the split to spec-normalization time so the array the rest of the pipeline sees is the split one.
**Status:** upheld

### [WARN] party-architect — Estimator placement is left open, and the two options give the `validate` command different dependency graphs
**Quotes:** > Does the length estimator belong in `packages/core` (schema-adjacent, usable by any consumer
> validating a spec without loading Kokoro) or `packages/audio` (co-located with the thing it's
> protecting, but requires pulling in an audio-package dependency just to validate a spec)?
**Quotes:** > Add a length estimator in `packages/audio` (or `packages/core`, alongside the other
>   narration-block validation)
**Quotes:** > `packages/cli`'s `validate` command: surface that estimator's warnings per scene/block.
**Problem:** The artifact states that one of the two options makes `validate` depend on the audio package, and elsewhere states there is "other narration-block validation" already living in `packages/core`. That is the existing mechanism for this class of check; putting a second narration-block validator in a different package splits narration validation across two packages, and the artifact does not say the existing core validation cannot host it. Left open, two implementers produce two different dependency graphs for `validate`, one of which pulls an audio package into a schema-only path.
**Fix:** Resolve the placement in the artifact, defaulting to the package the artifact already says hosts "the other narration-block validation", unless a stated reason rules it out.
**Status:** upheld

### [WARN] party-architect — Both test fixtures as described require a non-deterministic seam the proposal does not provide
**Quotes:** > Test coverage: a fixture spec with a global-vs-monorepo version mismatch (CLI resolution), and a
>   fixture narration block long enough to risk truncation (TTS length guard).
**Quotes:** > readable via `claudevid --version` or a new
>   `--build-info` flag.
**Quotes:** > `packages/audio/src/tts.ts`'s `synthesize()` calls `kokoro-js`'s `KokoroTTS.generate()`
**Problem:** A "fixture spec" cannot express a global-vs-monorepo mismatch: the condition depends on a global install on `PATH` and a `dist/cli.js` on disk, neither of which is spec content. Testing it deterministically requires the resolver to accept injected candidate paths and injected build signals rather than reading `PATH` and spawning a binary, and the proposal specifies the resolver in terms of the ambient environment only. Likewise the render-time guard sits in `synthesizeNarration`, which the artifact says calls into Kokoro; without a stub seam for `synthesize()`, the render-time warning and any auto-chunk behaviour can only be exercised by loading a real TTS model. Both tests get skipped in CI, which is the same silent-no-signal failure this proposal exists to remove.
**Fix:** Specify the resolver as a pure function over an injected candidate list and injected build signals with a thin ambient wrapper, and specify an injectable `synthesize` in `synthesizeNarration`, so both guards are unit-testable without `PATH`, network, or a model.
**Status:** upheld

### [NOTE] party-architect — Warning output channel is specified for one guard and unspecified for the other three call sites
**Quotes:** > print a clear stderr
>   warning naming both build identifiers and which one was actually used, before proceeding
**Quotes:** > warn (not fail) on any narration block that
>     risks truncation, naming the scene id and block index, so an author sees it before rendering.
**Quotes:** > at minimum, surface the same warning at render
>     time (covers specs that skip `validate`)
**Problem:** The CLI-freshness warning is pinned to stderr; the two TTS warnings are not pinned to any channel, and `validate` is a command whose output other tooling (including `validate.mts`) may parse. Whether a truncation warning goes to stdout alongside validation results, to stderr, or into a structured result object is a shared-contract decision between the command and its script caller. No correctness consequence if both land on stderr, but the artifact does not say so.
**Fix:** State the channel and, for `validate`, whether the warning participates in the command's exit code or machine-readable output.
**Status:** upheld

### [WARN] party-architect — Rebuttal: party-po's "skip global from inside the monorepo" variant does not close the resolution hole, because layout (a) still outranks the monorepo build
**Quotes:** > when `packages/cli/dist/cli.js` exists relative to the script, always resolve to it and skip the global-install step entirely, no freshness signal, no comparison, no flag.
**Quotes:** > `.claude/skills/video-generator/scripts/{render,validate}.mts` resolve the `claudevid` CLI in this
> order: (a) a `claudevid` dependency in the caller's `node_modules`, (b) a globally-installed
> `claudevid` on `PATH`, (c) `packages/cli/dist/cli.js` inside the monorepo
**Problem:** I take no position on the relative cost of the two designs — that is party-po's arrow. But their variant is offered as capturing "the same value", and structurally it does not: by the artifact's own stated ordering, step (a) — a `claudevid` dependency in the caller's `node_modules` — is resolved *before* the global install, so suppressing only step (b) when a monorepo dist is present leaves a stale layout-(a) copy silently winning over the fresher monorepo build. Whichever design the panel takes, the ordering question raised in my first finding has to be answered; the cheaper variant does not make it moot, it just changes which unguarded layout remains.
**Fix:** If the panel adopts the skip-global variant, state its rule over all three layouts — e.g. "when the monorepo dist exists relative to the script, it wins over both (a) and (b)" — not over the global install alone.
**Status:** upheld
