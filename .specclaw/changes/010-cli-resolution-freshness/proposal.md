# Proposal: CLI resolution always prefers the monorepo build over a stale global install

**Created:** 2026-09-09
**Status:** 🟡 Draft

**Revision note:** this proposal originally bundled a CLI-resolution fix with a separate TTS
narration-truncation fix, and went through this project's party review panel as one artifact
(standard tier, 3 seats, 2 rounds — see `party-report.md` for that round's 16 findings). The panel
raised, among other things, that the two bugs are independent and should not share one proposal
(party-po), and that the originally-proposed freshness-signal design was more expensive and more
underspecified than a much simpler alternative the proposal hadn't considered (party-po, with
party-architect confirming the simpler alternative still needs to be stated correctly). This
revision acts on both: the TTS fix now lives in a separate proposal
(`011-tts-narration-length-guard`), and this proposal adopts the simpler resolution-order fix
instead of build-freshness-signal machinery.

## Problem

_What problem are we solving? Why does it matter?_

`.claude/skills/video-generator/scripts/{render,validate}.mts` each resolve the `claudevid` CLI via
their own copy of `resolveCli()`, in this order: (a) a `claudevid` dependency in the caller's
`node_modules`, (b) a globally-installed `claudevid` on `PATH`, (c) `packages/cli/dist/cli.js`
inside the monorepo. Layout (c) is checked *last*, purely as a fallback for a non-monorepo caller
that has neither (a) nor (b) — so whenever a global install (or a local dependency) exists
alongside a monorepo checkout, the monorepo's own build is never consulted at all, no matter how
much newer or more correct it is.

This is not hypothetical: change 009 (`009-text-layer-centering`) fixed a real text-alignment bug —
`packages/renderer-canvas/src/index.ts` now offsets a text layer's paint position by
`alignOffsetX(align, bitmap.width)`, and `packages/cli/dist/cli.js` (built 2026-09-08) carries the
fix. A global install from 2026-09-07 (one day older, pre-fix) was present on `PATH`, so every
render driven through the skill kept silently reproducing the exact bug 009 had already fixed —
`x: "center"` + `align: "center"` text rendered with its *left* edge on the center line, cut off
past the right edge of the frame — with zero error, warning, or log line anywhere in the render
output. This was only caught by manually diffing the global npm package's bundled
`dist/chunk-*.js` against the monorepo source line-by-line, after a rendered video was already
reviewed and found visibly broken.

## Proposed Solution

_What are we building? High-level approach._

Change the resolution *order* itself, rather than adding a freshness-comparison layer on top of the
existing order:

- **When a monorepo checkout is present relative to the calling script** — i.e.
  `packages/cli/dist/cli.js` exists at the fixed relative path each script already computes — it is
  resolved and used **unconditionally**, ahead of both the local-dependency and global-install
  layouts. Being inside (or alongside, via the skill's fixed relative path) a claudevid monorepo
  checkout is itself the signal that the caller has, or is working against, a specific build of the
  code; a `node_modules` dependency or a global install can only ever be a different, and
  potentially older, build of the same tool.
- Local-dependency and global-install resolution remain exactly as they are today, as the fallback
  for a caller with **no** monorepo checkout alongside it (the normal case for the published
  package, e.g. the skill dropped into an unrelated host project) — this proposal changes nothing
  about that path.
- This removes the need for any new build-time signal, embedded timestamp/commit hash, or
  `--version`/`--build-info` flag: there is no freshness *comparison* to make, because the monorepo
  build is simply always the one used when it exists. Both the "which flag/format" and "how to
  compare timestamps vs. commit hashes" contract questions raised in review are moot under this
  design, not merely deferred.
- **Resolver duplication.** `resolveCli()` is implemented twice today (once in `render.mts`, once in
  `validate.mts`), and review flagged that adding new logic to both copies risks them diverging.
  This proposal extracts the shared resolution logic — including the reordered monorepo-first
  check — into one module,
  `.claude/skills/video-generator/scripts/resolve-cli.mts`, imported by both `render.mts` and
  `validate.mts`. Its exported function takes the candidate paths as parameters (the caller's
  `here` directory, `process.env.PATH` lookup, the computed monorepo-relative path) rather than
  reading them internally, so it can be unit-tested without spawning a real binary or depending on
  the ambient shell environment — this addresses review's testability finding directly: a test can
  assert the monorepo path is chosen whenever it exists, regardless of whether a global `claudevid`
  is also present, entirely in-process.

## Scope

### In Scope
- `.claude/skills/video-generator/scripts/resolve-cli.mts` (new): the shared, unit-testable
  resolver, taking candidate locations as parameters and returning which one to use, with the
  monorepo-checkout path checked first whenever it exists.
- `.claude/skills/video-generator/scripts/render.mts` and `validate.mts`: both updated to import
  and call the shared resolver instead of each carrying its own `resolveCli()`.
- Unit tests for the resolver: monorepo-present-alongside-global picks the monorepo path; no
  monorepo present falls back to today's local-dependency-then-global order unchanged;
  monorepo-dist-not-yet-built (e.g. before `pnpm build`) falls back correctly.
- A short doc comment on the resolver stating the ordering rule and why (the rationale paragraph
  above), so a future change to this ordering is a deliberate, documented decision rather than a
  rediscovery.

### Out of Scope
- The TTS narration-truncation fix — split out to `011-tts-narration-length-guard`.
- Any build-time freshness signal, embedded timestamp/commit hash, or new CLI flag — the reordering
  design needs none of this machinery, which is the point of adopting it over the original
  proposal's approach.
- Any change to resolution behavior for a caller with **no** monorepo checkout present (the
  published-package consumer) — that path is unchanged.
- Any change to `align`/text-centering behavior itself — that is 009's scope, already implemented;
  this proposal only ensures a caller alongside the monorepo actually reaches that fix.

## Impact

- **Files affected:** 3-4 — new `resolve-cli.mts`, edits to `render.mts` and `validate.mts`, plus a
  new test file.
- **Complexity:** small — this is a resolution-order change plus an extraction, not new
  infrastructure.
- **Risk:** low. The only behavior change is which build gets used when both a monorepo checkout
  and a global/local install are present — for anyone with just a global/local install (no
  monorepo alongside), resolution is byte-for-byte unchanged. The risk this proposal actually
  introduces is the reverse of today's: someone who *specifically wants* a global install used even
  though a monorepo checkout happens to be present alongside it (e.g. deliberately testing the
  published package's exact behavior from within the monorepo) would now get the monorepo build
  instead — see Open Questions.

## Open Questions

- Is there a real use case for deliberately using a global/local install *despite* a monorepo
  checkout being present (e.g. testing the published package's actual behavior side-by-side with
  the dev build)? If so, this proposal may need an explicit opt-out (an env var or CLI flag) rather
  than making the monorepo-first order unconditional. Absent a stated use case, this proposal treats
  that scenario as rare enough not to warrant one.
- Should `resolve-cli.mts` also memoize or cache its result within a single process run, or is a
  fresh resolution on every `render`/`validate` invocation (today's behavior) fine to keep as-is?
  No evidence either way; kept as-is (no caching) unless a performance concern surfaces.

## Dependency Bypass

## Item Split

## Resumes Split

---

**To proceed:** Review this proposal and approve to begin planning.
