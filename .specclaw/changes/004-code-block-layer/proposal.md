# Proposal: Animated Code Block Layer (Shiki, Line-Cached)

**Created:** 2026-09-06
**Status:** 🟡 Draft

**Depends on:** 001-videospec-core (layer registry), 002-canvas-render-engine (raster cache,
text measurement), 003-motion-system (tracks, stagger).

## Problem

Code is the reason this library exists. The requirement doc lists the target output as "tech
explainer videos, code walkthrough videos, tutorial videos" — every one of those is mostly a
camera pointed at source code. It is simultaneously the most expensive thing on screen and the
thing most likely to be wrong.

The doc's guidance is one paragraph:

> For syntax highlighting, use shiki or prismjs. Shiki is high quality but can be heavy.
> Pre-render code blocks to an offscreen canvas or image cache.
> `const codeCache = new Map<string, RenderedCodeBlock>();`

That is the right instinct and an unbuildable spec, because the interesting case breaks it.
**A typewriter animation changes the code block's content on every single frame.** A cache
keyed on the block invalidates 30 times a second, so the naive `Map<string, RenderedCodeBlock>`
has a 0% hit rate during exactly the animation people most want. Shiki re-tokenizing a 40-line
TypeScript file per frame is tens of milliseconds — the entire per-frame budget from change 002,
spent on one layer.

There are also correctness problems no cache solves:

- **Long code does not fit.** A 60-line file at a readable font size does not fit in 1080p.
  Without scroll, focus, or truncation, Claude will confidently emit code that renders as an
  unreadable wall or silently overflows the frame.
- **Highlighting is not the same as legibility.** A viewer needs to know *where to look*. Line
  highlight, dimming, and diff colouring are what make a code scene teach something; syntax
  colours alone do not.

## Proposed Solution

Build `@claudevid/layer-code` — a `code` layer registered into core's union, with tokenization
and layout hoisted entirely out of the frame loop.

**1. Tokenize once, at compile time.**
Shiki runs during timeline compilation, not during rendering. Use `createHighlighterCore` with
**only** the languages and themes the spec actually references, loaded lazily — this is what
keeps Shiki's weight from becoming a cold-start tax on every render. Output is a plain
serializable IR:

```ts
type TokenizedCode = { lines: { tokens: { text, color, fontStyle }[] }[] }
```

Serializable matters: change 005 ships timelines to worker threads, and a live Shiki
highlighter instance cannot cross that boundary.

**2. Layout once.** The IR is measured into positioned glyph runs. Monospace fonts take a fast
path (advance width × character count) rather than per-token `measureText`, which is roughly an
order of magnitude cheaper and exact for the fonts we bundle in change 002.

**3. Cache per LINE, not per block — the key design decision.**
A fully-revealed line is a stable bitmap. A typewriter animation only mutates the *one* line
currently being typed. So per frame the renderer blits N cached line bitmaps and draws exactly
one partial line. The cost of a typing animation becomes independent of file length, and the
cache hit rate during animation goes from 0% to (N-1)/N.

The window chrome — rounded background, border, title bar, traffic lights, drop shadow — is
pre-rendered once as a separate bitmap, keeping change 002's rule that shadows and blurs are
never per-frame operations.

**4. Animations that actually teach**, all expressed as change 003 tracks so they compose with
easing, stagger and transitions:

- **typewriter** — per character, per token, or per line, with a blinking caret
- **line reveal** — lines cascade in via `stagger`; the single best way to walk through code
- **focus** — highlight lines *n*–*m*, dim the rest; animate the focus band moving down a file
  as narration progresses (this is the walkthrough primitive)
- **diff** — added/removed line backgrounds, animated in; before/after morphing
- **scroll** — long files pan vertically with easing, so a 200-line file is usable
- **annotate** — callout arrows/labels anchored to a line number

**5. Legibility guardrails.** Declared max lines with a fade-out gradient, auto font-size fit to
a target width, tab expansion, soft wrap with continuation indent. A code layer that cannot fit
its content emits a **diagnostic** naming the line count and the suggested fix, rather than
rendering an overflowing block — Claude will generate over-long snippets, and this is what turns
that into a caught error instead of a bad video.

## Scope

### In Scope

- `packages/layer-code/src/schema.ts` — `code` layer Zod schema, registered into core
- `packages/layer-code/src/highlight.ts` — Shiki core, lazy lang/theme loading, IR emission
- `packages/layer-code/src/layout.ts` — monospace fast-path measurement, wrapping, fit-to-width
- `packages/layer-code/src/render.ts` — per-line raster cache, chrome pre-render, composition
- `packages/layer-code/src/animations.ts` — typewriter, line reveal, focus/dim, diff, scroll, caret
- `packages/layer-code/src/annotate.ts` — line-anchored callouts
- `packages/layer-code/src/diagnostics.ts` — overflow / unsupported-language / theme warnings
- Bundled theme set (github-dark, github-light, and one high-contrast option) verified for
  contrast at video bitrates
- Tests: IR golden files per language, line-cache hit-rate assertion during typewriter, overflow
  diagnostics

### Out of Scope

- Prism fallback — Shiki only
- Terminal / ANSI output replay (a genuinely useful sibling layer; deserves its own change)
- Live code execution or REPL capture
- Editor chrome beyond a title bar (tabs, sidebars, minimap)
- Semantic/LSP-aware highlighting

## Impact

- **Files affected:** ~16 new
- **Complexity:** medium-large
- **Risk:** medium — the tokenization and layout are well-trodden; the risk concentrates in the
  per-line cache interacting correctly with change 002's LRU eviction and change 005's
  per-worker caches.

## Open Questions

- **Shiki's weight.** Themes and grammars are large JSON. Do we (a) bundle a fixed set at build
  time for instant cold start, (b) load from `shiki`'s package on demand, or (c) precompile the
  used subset into the render artifact? Cold start matters for the `preview` loop in 007 and for
  batch jobs that spawn many processes.
- **Diff input format.** Unified diff string, or a `{ before, after }` pair we diff ourselves?
  A unified diff is what a model or a git command naturally produces; a pair is easier for Claude
  to emit correctly. Possibly both.
- **Does the ANSI/terminal layer belong here?** Terminal output is arguably as common as source
  code in tech videos (`npm install`, test output, `git log`). Same rendering machinery, different
  tokenizer. Fold in, or ship as change 008?
- **Font metrics for ligatures.** JetBrains Mono has programming ligatures (`=>`, `!==`). The
  monospace advance-width fast path is wrong for ligated runs. Disable ligatures, or detect and
  fall back to `measureText` for affected tokens?
- **Focus/dim colour derivation.** Dimming a Shiki theme means desaturating token colours. Do
  we compute that (OKLCH lightness shift, reusing change 003's colour work) or require themes to
  ship an explicit dim variant?

---

**To proceed:** Review this proposal and approve to begin planning.
