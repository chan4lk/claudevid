# Party Report: 010-cli-staleness-and-tts-truncation

**Reviewed:** 2026-09-09
**Tier:** standard (classifier) — Multiple subsystems change (cli, skills, audio/core, validate, render-pipeline) but all edits are additive warnings and optional auto-chunking; a new build-time step to embed freshness signals is straightforward metadata compilation, not a structural release-machinery change.
**Panel:** party-po(sonnet), party-architect(opus), party-ba(sonnet)
**Verdict:** CHANGES_REQUESTED

## Summary

16 findings: 4 BLOCK, 9 WARN, 3 NOTE upheld — 0 withdrawn

## Findings

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

### [WARN] party-ba — Acceptance criteria are never stated in falsifiable terms
**Quotes:** > Test coverage: a fixture spec with a global-vs-monorepo version mismatch (CLI resolution), and a fixture narration block long enough to risk truncation (TTS length guard).
**Problem:** This is the closest thing to an acceptance criterion in the whole document, and it describes a fixture's *setup* ("a version mismatch", "long enough to risk truncation"), not an observable pass/fail condition. Nowhere does the proposal state what output a reviewer should check for and reject if absent — e.g. "the warning text contains both build identifiers," or "validate exits 0 but prints one warning line per over-threshold block." As written, a fixture that exists but whose assertions are weak, or a warning that fires but with unhelpful text, would still satisfy this line. The proposal's own central claim — "so a contributor sees the mismatch" / "so an author sees it before rendering" — has no criterion that could fail it.
**Fix:** State the observable check per fixture (exact stderr content or exit behavior expected), not just the fixture's input shape.
**Status:** upheld

### [WARN] party-ba — Both fixes assume the warning is read, which the proposal's own incident report undercuts
**Quotes:** > print a clear stderr warning naming both build identifiers and which one was actually used, before proceeding — so a contributor sees the mismatch on every affected run instead of never.
> `validate.mts`'s underlying `validate` CLI command: warn (not fail) on any narration block that risks truncation, naming the scene id and block index, so an author sees it before rendering.
**Problem:** Both fixes' entire value depends on a human (or the agent driving the skill) reading stderr output and acting on it. The proposal never establishes that this happens — and its own bug-009 narrative is evidence against it: that render already produced full output, and the bug was still only caught by manually diffing bundled `dist/chunk-*.js` files line-by-line after the fact, not by anyone reading anything the tool printed. The caller here is `.claude/skills/video-generator/scripts/{render,validate}.mts`, invoked by an agent skill — the proposal never says whether that invocation path surfaces child-process stderr to whatever is driving it, or whether an agent parses/acts on warning text versus treating a zero exit code as success. "Warn loudly" only fixes "silently wrong" if the warning's audience reliably sees and understands it; that behavior is asserted, not shown.
**Fix:** Either show (in the proposal or scope) how the warning reaches and is acted on by the actual caller (human terminal vs. agent-driven skill invocation), or narrow the claimed benefit to "detectable via output inspection" rather than "a contributor sees the mismatch."
**Status:** upheld

### [NOTE] party-ba — Word-count threshold for the TTS risk is asserted without derivation
**Quotes:** > in practice, a single narration block somewhere in the range of 100-150 English words can silently exceed it.
**Problem:** This range is the number that will calibrate the length-estimator heuristic named later in scope, but the proposal gives no source for it (no test run, no phoneme-count sample, no reference to the 150-300-word blocks that were actually observed clipping). It reads as a rough guess bridging from the hard token cap (509, cited from code) to a word-count claim, with the arithmetic between the two left implicit. The actually-observed incident (150-300 words) is well evidenced by first-hand description; the lower bound used to scope the warning threshold (100-150) is not.
**Fix:** Either cite how 100-150 was derived (a words-per-token ratio measurement, or a specific test block that clipped at that length), or state the range as a placeholder to be calibrated rather than a given fact.
**Status:** upheld

### [WARN] party-po — Do-nothing recurrence rate is never quantified
**Quotes:**
> This is not hypothetical: change 009 (`009-text-layer-centering`) already fixed exactly this repo's
> text-alignment bug
>
> This was hit directly authoring a real spec: several
> 150-300-word narration blocks produced audible mid-sentence clipping, found only by listening to
> the rendered output and cross-checking `ffprobe`-reported scene durations against expected word
> counts

**Problem:** Both bugs are motivated by exactly one anecdotal occurrence each. The proposal never states how often a contributor's global install actually diverges from the monorepo in practice, nor how often narration blocks in typical specs exceed the ~100-150 word danger zone. Shipping build-time signal plumbing, a new CLI flag, and an estimator wired into two commands is a multi-file, medium-complexity change; if the failure mode is rare (e.g., "happened twice in the project's history so far"), the do-nothing cost — an occasional caught-by-eye bug, as both were — may be cheaper than the proposed machinery.
**Fix:** State or estimate the recurrence rate (e.g., "N of the last M specs had narration blocks over 100 words" or "global installs are refreshed on cadence X") to justify the scope against the do-nothing baseline.
**Status:** upheld

### [WARN] party-po — Cheaper CLI-resolution variant (skip the global install entirely when local exists) is not considered
**Quotes:**
> When `resolveCli()` in `render.mts`/`validate.mts` is running **from inside the claudevid
> monorepo** (i.e. `packages/cli/dist/cli.js` exists relative to the script, regardless of which
> layout ultimately gets used) and it picks the *global* install over that local monorepo build,
> compare the two builds' freshness signals. If the monorepo build is newer, print a clear stderr
> warning naming both build identifiers and which one was actually used, before proceeding

**Problem:** The proposed default requires new build-time infrastructure (embedding a timestamp or commit hash into every build layout) plus new comparison logic plus a new `--build-info` surface, solely to decide whether to print a warning. A strictly cheaper variant that captures the same value — never silently run a stale global build when a local monorepo checkout is present — is: when `packages/cli/dist/cli.js` exists relative to the script, always resolve to it and skip the global-install step entirely, no freshness signal, no comparison, no flag. The Open Questions section considers a *related* alternative ("prefer the fresher build automatically... trading a surprising override for a different surprise") but that still requires the comparison machinery; it never names the even-simpler "just don't consult global from inside the monorepo" option, which needs zero new build-time infrastructure. Round-1 architect findings (dead-weight signal on layout (a), unresolved flag/format contract) show the freshness-signal path is more expensive and more underspecified than a plain re-read of the proposal alone suggested, which only reinforces this cost gap rather than closing it.
**Fix:** Evaluate "always prefer local monorepo dist over global when both are candidates" against the proposed freshness-signal-and-warn default before committing to the latter's cost.
**Status:** upheld

### [WARN] party-po — Documentation-only variant for the TTS guard is not weighed against building an estimator
**Quotes:**
> The workaround — manually splitting long blocks into
> ~70-word, sentence-aligned chunks in the `narration` array, each synthesized as an independent call
> — works
>
> Document the practical per-block length guidance (word-count ballpark, and why it's phoneme-token
> count and not raw word count that actually limits it) in `SKILL.md` and/or the `NarrationBlock`
> type's own doc comment, so this stops being tribal knowledge rediscovered by ear.

**Problem:** The proposal's own text establishes that a known, working manual workaround exists and that the estimator's job is only to warn (not enforce or fix). Documentation alone — captured as one line item in Scope — would give an author the same information the estimator would surface, at effectively zero implementation/maintenance cost, versus building and wiring a length estimator into two separate commands (`validate.mts`, `render-pipeline.ts`). The proposal lists documentation as an *addition* to the estimator rather than evaluating it as the standalone cheap variant. party-ba's round-1 finding that both fixes' value depends on a warning actually being read, and is unproven, cuts the same direction: if a printed warning's audience is not established, the estimator's incremental value over documentation alone is even less justified, not more.
**Fix:** State why documentation alone is judged insufficient (e.g., authors don't read `SKILL.md` before hitting the bug) rather than bundling the estimator as the default without that comparison.
**Status:** upheld

### [WARN] party-po — The stderr staleness warning has no stated bound and fires on every run indefinitely
**Quotes:**
> print a clear stderr
> warning naming both build identifiers and which one was actually used, before proceeding — so a
> contributor sees the mismatch on every affected run instead of never.

**Problem:** Because "Fully automated global-install sync... is out of scope," a contributor whose global install stays stale (e.g., they don't know how to fix it, or fixing it requires steps outside this change) pays this warning's attention cost on every single `render`/`validate` invocation, indefinitely, with no stated dedup, suppression, or session-level rate limit. The proposal states the fix is "additive" and low-risk but never bounds this specific recurring interruption cost.
**Fix:** State a bound (e.g., warn once per shell session, or point to a one-line fix command in the warning itself) so the recurring cost is capped rather than open-ended.
**Status:** upheld

### [NOTE] party-po — Two independent bugs are bundled into one proposal with no named cut line
**Quotes:**
> Two independent guards, one per bug, both in the "fail loud instead of failing silent" family

**Problem:** The proposal itself states the two fixes are independent, yet Scope, Impact, and Open Questions treat them as a single unit to plan, review, and land together. Nothing in the CLI-freshness fix depends on the TTS-length fix or vice versa; either could ship (and start returning value) without waiting on the other, and the smaller of the two (TTS docs/estimator, touching `packages/audio`/`packages/cli` validate) could land well ahead of the CLI build-signal plumbing, which requires new build-time infrastructure. Round-1 architect findings that the CLI-freshness change alone carries three unresolved contract decisions (flag choice, signal format, missing-signal branch) and a resolver-duplication risk sharpen this: the TTS guard is the cleaner, lower-risk half to ship first, and the proposal still never names that ordering.
**Fix:** Name the cut line explicitly — e.g., ship the TTS guard first as the smaller, dependency-free change, and let the CLI freshness check follow once the build-timestamp/commit-hash question is settled.
**Status:** upheld

## Dissent

No withdrawals.
