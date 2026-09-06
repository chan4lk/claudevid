# Spec: VideoSpec Schema, Timeline Compiler & Core Contract

**Change:** 001-videospec-core
**Created:** 2026-09-06
**Status:** 🟡 Draft

## Overview

`@claudevid/core` is a pure TypeScript, zero-I/O, zero-native-dependency package that owns
the single machine-checkable contract between Claude (director) and the rest of the library
(renderer/animator/encoder): the `VideoSpec` schema, its diagnostics, and the timeline
compiler that turns a relative, human-authored spec into an absolute, integer-frame,
serializable `Timeline`. Every other change (002–007) depends on this package and must not
duplicate its timing arithmetic or coordinate resolution.

## Requirements

### Functional Requirements

- **FR1 — VideoSpec v1 schema.** `schema.ts` defines a Zod schema for `version` (literal `1`),
  `width`/`height`/`fps` (numbers, defaulted to 1920/1080/30), `background` (optional CSS color
  string), `meta` (optional `{ title?, description? }`), `audio` (optional
  `{ track?: string, volume?: number }` — a background-music reference only; narration/TTS is
  change 006's concern), and `scenes` (array, min 1).
- **FR2 — Scene schema.** Each scene has `id` (string, unique within the spec), `duration`
  (`number >= 0` **or** the literal `"auto"`), optional `background` (inherited by layers that
  don't set their own), and `layers` (array, may be empty).
- **FR3 — Layer union with registry seam.** `layers.ts` ships `text`, `rect`, `image`, `group`
  as a discriminated union on `type`. Every layer shares a base shape: optional `x`/`y`
  (`number | "center" | "<number>%"`), optional `start`/`duration` (seconds, relative to the
  scene's own start — defaults to the full scene window when omitted), and an `animation`
  extension point (`{ enter?: string, exit?: string, duration?: number, delay?: number,
  easing?: string }` — the `enter`/`exit` values are opaque strings, **not** a fixed enum;
  change 003 owns the live preset registry and validates against it, so core never bakes in a
  closed preset list that a future preset addition would force a version bump to change).
  `text` also carries `maxWidth?`/`lineHeight?`/`align?` ("left"|"center"|"right") — discovered
  as a real gap while building change 002's word-wrap painter, added here rather than in 002
  because word-wrap bounds are spec content Claude authors, not a renderer-only concern.
  `registerLayer(type, zodSchema)` lets 004 (`code`) and 006 (`captions`) add layer types
  without editing core; the discriminated union is rebuilt lazily on registration.
- **FR4 — `group` layer & nesting cap.** `group` has `children: Layer[]` (recursive via
  `z.lazy`) for stagger (003) and shared-element transitions. Nesting is capped at 2 levels
  (`group` containing `group` containing leaf layers, no deeper) via a `superRefine` walk;
  parseSpec reports a diagnostic naming the offending path, not a raw Zod recursion error.
- **FR5 — `parseSpec`.** Never throws a raw Zod error. Returns `{ ok: true, spec }` or
  `{ ok: false, diagnostics: Diagnostic[] }`, where `Diagnostic = { path: string (JSON
  pointer, e.g. `/scenes/3/layers/1/fontSize`), message: string, suggestion?: string }`.
  Suggestions are populated for a known set of common issues (out-of-range numeric fields,
  wrong literal, missing required field) — best-effort, not exhaustive for v1.
- **FR6 — `compileTimeline(spec, opts?)`.** Pure function, `opts?: { audioDurations?:
  Record<sceneId, seconds> }`. Converts every scene duration to an integer frame count via
  `Math.round(seconds * fps)` and accumulates frame offsets as integers only — never
  re-derives a boundary from a sum of floats. Returns a `Timeline`:
  - `frameCount: number` — total frames across all scenes.
  - `sceneWindows: { sceneId: string, startFrame: number, endFrame: number }[]`.
  - `layers: { layerKey: string, sceneId: string, type: string, startFrame: number,
    endFrame: number, x: number | "center", y: number | "center", ...resolvedStyle }[]` —
    flattened across all scenes, absolute frame windows, coordinates resolved to numbers
    where percentage/`"center"` was given (`resolve.ts`), inherited scene background applied.
  - `activeAt(frame: number): TimelineLayer[]` — layers active at a given global frame,
    via binary search over `sceneWindows` then a filter over that scene's layers. This method
    and the two fields above are the **only** timing authority; no other package re-derives
    scene boundaries from `duration` fields.
  - `layerKey` is stable and deterministic (derived from scene id + layer path, not random)
    for change 002's raster cache and change 003's shared-element transitions.
- **FR7 — `duration: "auto"` resolution.** If a scene's `duration` is `"auto"`,
  `compileTimeline` requires `opts.audioDurations[scene.id]` to be present; if it is missing,
  `compileTimeline` throws `MissingAudioDurationError` naming the scene id. There is **no**
  estimate/fallback mode in this change — an absent map entry always errors, it never
  silently produces a guessed duration. (Change 006 is responsible for populating the map
  before calling `compileTimeline`.)
- **FR8 — Coordinate & style resolution.** `resolve.ts` resolves `"center"` to
  `dimension / 2` and `"<number>%"` to `(percent / 100) * dimension`, against `spec.width`/
  `spec.height` for top-level layers. Resolution happens once, at compile time — the render
  loop never re-parses a coordinate string.
- **FR9 — Easing library.** `easing.ts` exports the standard `linear`/`easeIn*`/`easeOut*`/
  `easeInOut*` cubic/quad/expo/back functions, a CSS-compatible `cubicBezier(x1, y1, x2, y2)`,
  and `steps(n, direction)`. All are pure numeric functions of a single `t: number` (or return
  a function of `t`), independently unit-testable without any spec/timeline context.
- **FR10 — JSON Schema export.** `json-schema.ts` generates a JSON Schema from the same Zod
  `videoSpecSchema` (via `zod-to-json-schema`) for Claude structured-output use in change 007.
  Never hand-maintained.
- **FR11 — Monorepo scaffolding.** pnpm workspace, shared root `tsconfig.base.json`, `tsup`
  build config and `vitest` test config for `packages/core`, following the folder layout in
  `docs/Qwen_markdown_20260906_vsjxybyq8.md`.

### Non-Functional Requirements

- **NFR1 — Zero I/O, zero native deps.** `@claudevid/core` must not import `fs`, `net`,
  `child_process`, canvas, or FFmpeg bindings. Enforced by a dependency-boundary test
  (`package.json` deps list) and by code review.
- **NFR2 — Determinism.** `compileTimeline` given the same `spec` and `opts` must produce a
  byte-for-byte identical `Timeline` every time (no `Date.now()`, no `Math.random()`,
  no object-identity-dependent ordering).
- **NFR3 — Type/validator parity.** All exported TypeScript types are `z.infer<...>` from the
  Zod schemas in `schema.ts`/`layers.ts` — never a hand-written parallel interface.
- **NFR4 — No float accumulation.** Scene frame offsets are computed by accumulating integer
  `Math.round(seconds * fps)` values; nothing in `timeline.ts` sums fractional seconds across
  more than one scene at a time.

## Acceptance Criteria

- **AC1:** `parseSpec` accepts a minimal valid spec (1 scene, 1 text layer) and returns `{ ok: true }`.
- **AC2:** `parseSpec` rejects a spec with an out-of-range `fontSize` and returns a diagnostic whose
  `path` is a correct JSON pointer to the offending field.
- **AC3:** `parseSpec` rejects a `group` nested 3 levels deep with a diagnostic naming the path,
  not a raw stack-overflow or Zod internal error.
- **AC4:** `compileTimeline` on a spec with scenes of duration `[2.5, 3.333, 1.0]` at `fps: 30`
  produces `sceneWindows` whose frame counts are each `Math.round(duration * 30)` and whose
  `startFrame`/`endFrame` are contiguous with no gap or overlap.
- **AC5:** `compileTimeline` on a spec with 3600 one-second scenes at `fps: 24` (a 1-hour timeline)
  produces a `frameCount` exactly equal to the sum of the per-scene rounded frame counts —
  proving no drift from repeated float summation.
- **AC6:** `compileTimeline` on a scene with `duration: "auto"` and no matching `audioDurations` entry
  throws `MissingAudioDurationError` naming the scene's `id`.
- **AC7:** `compileTimeline` on a scene with `duration: "auto"` and a matching `audioDurations` entry
  produces a frame window sized from that entry, not from any default.
- **AC8:** `activeAt(frame)` returns exactly the layers whose resolved `[startFrame, endFrame)`
  contains `frame`, for a spec where a layer's `start`/`duration` is a strict subset of its
  scene's window.
- **AC9:** `registerLayer("caption", captionLayerSchema)` (simulating change 006) allows `parseSpec`
  to accept a spec containing a `caption`-type layer, without any edit to `layers.ts`.
- **AC10:** The JSON Schema emitted by `json-schema.ts` validates the same minimal spec from AC1 when
  checked with a standard JSON Schema validator (round-trip proof against the Zod schema).
- **AC11:** `pnpm --filter @claudevid/core build` and `pnpm --filter @claudevid/core test` both
  succeed from a clean checkout.

## Edge Cases

- Zero-length scene (`duration: 0`) — must compile to a frame window of length 0
  (`startFrame === endFrame`) without throwing, and `activeAt` must never return its layers.
- `fps` values that don't evenly divide 1 second (e.g. `fps: 23.976`) — rounding must still
  produce monotonically non-decreasing frame offsets across scenes.
- A layer `start`/`duration` that extends past its scene's own boundary — clamp to the scene
  window and report nothing (v1 does not diagnose this at parse time; it's a silent clamp,
  documented as a known v1 limitation in Notes).
- A spec with `scenes: []` — rejected by `min(1)` at the schema level, not a `timeline.ts`
  edge case.
- Two scenes sharing the same `id` — rejected by a `superRefine` uniqueness check in
  `schema.ts`, with a diagnostic pointing at the second occurrence.
- 30-minute timeline (the GOALS.md-specified golden-test scale) at 30fps (54,000 frames) —
  must compile without perceptible slowdown and with exact frame accounting (AC5 covers the
  1-hour case, which subsumes this).

## Dependencies

- **Runtime:** `zod`, `zod-to-json-schema`.
- **Dev/build:** `typescript`, `tsup`, `vitest`, pnpm workspace tooling.
- **Depends on:** nothing (this is the foundation change).
- **Depended on by:** 002, 003, 004, 005, 006, 007 (all).

## Notes

- Adopts proposal recommendation (a) for `duration: "auto"`: optional `AudioDurations` map,
  defaults to empty, core stays I/O-free. See FR7.
- Adopts percentage-string coordinates (`"50%"`) for x/y in v1, per the proposal's own lean
  toward resolution-agnostic output (serves 007's `--vertical` flag). Named safe-area anchors
  are **not** included in v1 — no consumer needs them yet (YAGNI); can be added additively
  later since coordinates are already a discriminated-ish union of `number | "center" | string`.
- `animation.enter`/`animation.exit` are typed as plain `string`, not a Zod enum, specifically
  because GOALS.md's panel review of change 003 flags a fixed preset enum in core as a
  one-way door that would force a version bump every time 003's registry gains a preset.
  003 is responsible for validating the string against its live registry at render/build time.
- Layer nesting cap of 2 levels is a v1 scope decision from the proposal's open questions,
  chosen to bound the raster-cache complexity in change 002. Can be relaxed later (additive).
- Known v1 limitation (see Edge Cases): a layer's `start`/`duration` extending past its scene
  boundary is silently clamped rather than diagnosed. Revisit if this causes confusion once
  006 exercises per-layer timing more heavily.
