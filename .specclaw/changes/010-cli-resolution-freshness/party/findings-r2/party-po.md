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
