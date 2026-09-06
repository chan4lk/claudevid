# Proposal: VideoSpec Schema, Timeline Compiler & Core Contract

**Created:** 2026-09-06
**Status:** 🟡 Draft

**Depends on:** nothing. This is the foundation every other change imports.

## Problem

The repository is empty. `docs/Qwen_markdown_20260906_vsjxybyq8.md` describes a Claude-first
video generator whose central bet is a clean split:

```
Claude = director / writer / scene planner
Library = renderer / animator / encoder
```

That split only works if there is a **machine-checkable contract** between the two halves.
Right now there isn't one, and every downstream component would have to invent its own idea
of what a scene is, when a layer is on screen, and what frame 12,041 should look like.

Three concrete failures follow from having no core:

1. **Claude's mistakes surface at the wrong time.** Without validation, a malformed spec
   becomes a `TypeError` at frame 12,000 of a 54,000-frame render — 20 minutes of wasted
   wall clock for an error that should have been caught in 50ms with a JSON pointer.
2. **Timing drifts.** The doc's sample code accumulates scene start times as floats and
   derives `time = frame / fps`. At 30fps over 1800 seconds that is 54,000 float additions;
   scene boundaries land mid-frame, layers flicker on and off by one frame, and audio sync
   (change 006) has nothing authoritative to align against.
3. **Nothing is parallelizable.** Change 005 wants to render scene chunks concurrently across
   worker threads. That requires a *serializable, immutable* description of "what is on screen
   during frames 900–1080" that a worker can be handed with no shared state. A mutable
   draw loop over a spec cannot provide that.

## Proposed Solution

Build `@claudevid/core` — pure TypeScript, zero native dependencies, zero I/O. It owns the
data model and the arithmetic, and nothing else.

**1. VideoSpec v1 schema (Zod as the single source of truth).**
`schema.ts` defines the spec with Zod; `types.ts` infers TypeScript types from it, so the
runtime validator and the compile-time types can never disagree. The JSON Schema handed to
Claude for structured output is *generated* from the same Zod definition (`zod-to-json-schema`),
never hand-maintained — a hand-written schema drifting from the validator is how a director
prompt starts producing output the library rejects.

**2. Layer union with a registry seam.**
Layers are a discriminated union on `type`. Core ships `text`, `rect`, `image` and `group`.
Changes 004 (`code`) and 006 (`captions`) register additional layer schemas through a
`registerLayer()` hook rather than by editing core, so adding a layer type is additive and
does not force a core version bump.

**3. Timeline compiler — the real deliverable.**
`compileTimeline(spec) -> Timeline` turns a nested, relative, human/Claude-authored spec into
a flat, absolute, immutable structure:

- Every duration is converted to an **integer frame count** at compile time. Scene boundaries
  are snapped to frame indices once, so there is no float accumulation anywhere in the render
  loop and no off-by-one flicker.
- Each layer gets an absolute `[startFrame, endFrame)` active interval, resolved coordinates
  (`"center"` → a number), resolved inherited styles, and a stable `layerKey` for the raster
  cache in change 002 and shared-element transitions in change 003.
- The result is a plain serializable object: a worker thread in change 005 can be handed
  `timeline` plus a frame range and needs nothing else.
- `timeline.frameCount`, `timeline.sceneWindows`, and `timeline.activeAt(frame)` are the only
  timing authority in the system. Nobody else does timing arithmetic.

**4. Easing library.**
`easing.ts` — the standard cubic/quad/expo/back set, a general `cubicBezier(x1,y1,x2,y2)`
(CSS-compatible), and `steps()`. Pure numeric functions, exhaustively unit-tested. Change 003
builds its spring and stagger machinery on top of these.

**5. Diagnostics.**
`parseSpec()` never throws a raw Zod error. It returns `{ ok: true, spec }` or
`{ ok: false, diagnostics }` where each diagnostic carries a **JSON pointer**
(`/scenes/3/layers/1/fontSize`), a human sentence, and — where determinable — a suggested
repair. Change 007's Claude repair loop feeds these back to the model verbatim; a bad message
here becomes an infinite retry loop there.

**6. Golden tests for timing.** A suite that asserts exact frame windows for awkward inputs:
fractional durations, zero-length scenes, fps values that don't divide evenly, 30-minute
timelines, single-frame layers. These are the tests that stop a subtle timing regression from
silently desyncing every video the library ever renders.

## Scope

### In Scope

- `packages/core/src/schema.ts` — Zod VideoSpec v1: `version`, `width`, `height`, `fps`,
  `background`, `meta`, `audio`, `scenes[]`
- `packages/core/src/types.ts` — inferred types, exported public surface
- `packages/core/src/layers.ts` — `text` / `rect` / `image` / `group` schemas + `registerLayer()`
- `packages/core/src/timeline.ts` — `compileTimeline`, `Timeline`, `activeAt`, frame snapping
- `packages/core/src/resolve.ts` — coordinate + style resolution (`"center"`, percentages,
  inherited scene background, safe-area anchors)
- `packages/core/src/easing.ts` — easing catalogue + `cubicBezier` + `steps`
- `packages/core/src/diagnostics.ts` — JSON-pointer diagnostics, repair suggestions
- `packages/core/src/json-schema.ts` — generated JSON Schema export for Claude structured output
- Monorepo scaffolding: pnpm workspace, tsconfig base, tsup/vitest config, `packages/*` layout
  per the doc's recommended folder structure
- Unit + golden tests for schema acceptance/rejection and timeline arithmetic

### Out of Scope

- Any drawing, canvas, or pixel output — change 002
- Animation evaluation, presets, transitions — change 003 (core owns *easing functions only*)
- Code-layer schema and Shiki — change 004
- FFmpeg, encoding, workers — change 005
- TTS, captions layer, `duration: "auto"` resolution — change 006 (see Open Questions)
- CLI, Claude prompts, Claude Code skill — change 007
- Spec v2 / migration tooling

## Impact

- **Files affected:** ~18 new (plus monorepo root config)
- **Complexity:** medium
- **Risk:** low — pure functions, no I/O, no native deps. The risk is *design* risk (getting
  the contract wrong is expensive to unwind later), not implementation risk.

## Open Questions

- **`duration: "auto"`.** Change 006 wants scene duration derived from measured voiceover
  length. That is the single most valuable feature for long-form video, but it means the
  timeline cannot be compiled without audio having been synthesized first. Do we (a) put
  `"auto"` in v1 and make `compileTimeline` take an optional `AudioDurations` map, (b) defer
  it to v1.1, or (c) make it a two-pass compile? **Recommendation: (a)** — the map is optional
  and defaults to empty, so core stays I/O-free and 006 does not force a schema break.
- **Coordinate units.** v1 supports `number | "center"`. Should it also accept `"50%"`,
  `"left+40"`, or named safe-area anchors? Percentages make Claude's output resolution-agnostic
  (important for the `--vertical` short-form flag in 007) but widen the parser surface.
- **How much should Claude be allowed to express?** The doc says "do not invent unsupported
  layer types". A tight schema makes Claude reliable; a loose one makes the library expressive.
  Where the line sits affects change 003 most (named presets vs raw keyframes).
- **Versioning policy.** `version: 1` is a literal today. What is the rule for adding a field
  (minor, no bump) vs changing a meaning (bump + migration)? Worth deciding before external
  specs exist, not after.
- **Group/nesting depth.** `group` enables stagger over children in 003 and shared-element
  transitions. Unbounded nesting complicates the raster cache in 002. Cap at 2 levels?

---

**To proceed:** Review this proposal and approve to begin planning.
