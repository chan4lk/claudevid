# Design: Motion System v1 — Free-Channel Animation, Presets, Stagger, Cut/Cross-Fade Transitions

**Change:** 003-motion-system
**Created:** 2026-09-07

## Technical Approach

```
compileTimeline(spec)                      [core, extended: FR12 scene overlap]
        │
        ▼
    Timeline  ──────────────────────────────────┐
        │                                       │
        ▼                                       │
compileMotion(spec, timeline)  [motion]          │
  ├─ for each active-animation layer:            │
  │    resolve preset name → Track[]             │
  │    apply stagger (clone + delay offset)       │
  │    bake any spring easing (needs spec.fps)    │
  │    clamp-check vs layer active interval        │
  └─ → { compiled: Map<layerKey, Track[]>,        │
          diagnostics: Diagnostic[] }             │
        │                                        │
        ▼                                        │
  if diagnostics.length: caller stops (fail-closed, FR9) — never reaches render
        │
        ▼
createResolver(compiled)  [motion] → { resolve(layerKey, frame): PropertyBag | undefined }
        │
        ▼
renderer.renderFrame(timeline, frame, target, { motion: resolver })   [renderer-canvas, extended: FR15/FR16]
  ├─ transitionAt = timeline.transitionAt?.(frame)     [core, new: FR12]
  │    present  → two-pass paint: outgoing scene at alpha 1, incoming scene on top at alpha t
  │    absent   → single-pass paint (existing behavior)
  ├─ per active layer: bag = motion?.resolve(layer.layerKey, frame)
  │    ctx.save(); if bag: translate-to-center, rotate, scale, translate-back, globalAlpha
  │    <existing drawImage call, unchanged>
  │    ctx.restore()
  └─ hold-frame fast path skipped if any active layer has a resolver hit this frame [FR16]
```

Three packages change, one is new:

- **`@claudevid/motion`** (new) — everything above `compileMotion`. Zero rendering, zero
  canvas dependency, 100% numeric test suite (NFR1).
- **`@claudevid/core`** (extended, small) — two new optional schema fields
  (`Scene.transition`, `Animation.stagger`), one new shared type (`PropertyBag`), one
  `compileTimeline` arithmetic change (scene-overlap shifting) plus a new `Timeline.
  transitionAt(frame)` method. `Timeline.activeAt` itself is unchanged — existing callers see
  no behavior difference outside a transition window.
- **`@claudevid/renderer-canvas`** (extended, small) — `renderFrame` gains an optional
  `opts.motion` resolver parameter and consults `timeline.transitionAt`; the per-layer paint
  call gains a transform bracket; the hold-frame key check gains one condition.

## Grounding sources

- `packages/core/src/layers.ts:5-11` — `Animation` is already a bare-string `{enter?, exit?,
  duration?, delay?, easing?}`; no `AnimationPreset` enum exists in code today. Used in
  spec.md's Problem section to close the party-ba BLOCK (unsourced quote) and the
  party-architect BLOCK (dual preset resolvers) — there is only one resolver because there
  was previously none.
- `packages/renderer-canvas/src/index.ts` (grep for `animation`/`Animation`: zero matches) —
  confirms the renderer never reads the field, so "retire the renderer branches" has nothing
  to retire.
- `packages/core/src/timeline.ts:71` (`"Overflow past the scene window is a documented v1
  limitation: clamp, don't diagnose"`) — precedent followed by FR4's spring-overflow clamp,
  but explicitly **not** followed by FR9's timing-clamp diagnostic (that one levels up to
  fail-closed per the party-security finding; the precedent is about *rendering* overflow, not
  about *authoring* a track longer than its window).
- `packages/core/src/diagnostics.ts` (`ParseResult = {ok:true,...} | {ok:false,
  diagnostics}`) — the disposition FR9's `compileMotion` diagnostics reuses. This is the
  concrete resolution to the party-ba/party-security "diagnostic: advisory or blocking?"
  finding: it is exactly as blocking as `parseSpec` already is, no new precedent invented.
- `.specclaw/changes/002-canvas-render-engine/spec.md:180-184` (FR11 Notes: *"Change 003
  (motion) will need to either bypass hold-frame detection for animated layers or extend the
  dirty-check to include evaluated track values"*) — FR16 takes the first, simpler option
  002's own spec explicitly named as acceptable.
- `.specclaw/changes/002-canvas-render-engine/spec.md:157-160` (Dependencies: *"003 (motion —
  paints via the same painters, evaluates tracks before calling `renderFrame`)"*) — confirms
  002's own design anticipated motion sitting above `renderFrame`, not replacing it; FR15's
  additive-parameter approach matches this rather than inventing a parallel render path.
- `packages/renderer-canvas/src/text.ts:77` (`paintTextLayer` returns a `Canvas` sized to the
  text's own measured `totalWidth`/`totalHeight`) and `draw-shapes.ts:13`/`draw-image.ts:49-50`
  (rect/image bitmaps sized to `layer.width`/`layer.height`) — every painter's returned bitmap
  already carries its own natural size, which is what FR14's "layer's own rendered-bitmap
  center" transform origin uses; no new width/height plumbing is needed.
- `GOALS.md`'s "003 — Motion System" section (this repo's own pre-existing distilled backlog
  from the party review) — directly shaped FR11 (group x/y stated as purely organisational,
  the option it explicitly offered), FR6 (preset immutability/versioning convention), FR12
  (transitions as a closed, persisted-field set), and the "Deferred channels" notes in spec.md
  (keep the channel-table entries so deferred families aren't rediscovered from zero). Its
  caution about baking to seconds rather than frames is addressed directly in Key Decision D1
  below rather than silently followed or silently ignored.

## Architecture

```
packages/motion/
  package.json                # deps: @claudevid/core (workspace)
  tsup.config.ts
  vitest.config.ts
  src/
    properties.ts             # Channel union (6 free channels), cost-class table (free only, v1)
    track.ts                  # Track type, evaluate(tracks, frame, trackStartFrame): PropertyBag
    easing.ts                 # resolveEasing(name) → core's fns; spring(); bakeSpring(spec, fps)
    presets.ts                # registry: name → (params) => Track[]; exportCatalogue()
    stagger.ts                # stagger(), deterministic FNV-1a ordering for "random"
    compile.ts                # compileMotion(spec, timeline) — the named baker/compiler (FR8)
    resolver.ts                # createResolver(compiled) → { resolve(layerKey, frame) }
    index.ts                  # public exports
  test/
    track.test.ts              # evaluate() golden values, purity (AC2), same-property invariant
    easing.test.ts              # resolveEasing delegates to core; spring bake goldens (AC3/AC4)
    presets.test.ts             # each shipped preset's resolved tracks at t=0/t=end (AC1)
    stagger.test.ts              # determinism of "random" ordering (AC5)
    compile.test.ts               # timing-clamp diagnostic (AC6), preset-not-found diagnostic
    catalogue.test.ts              # exportCatalogue() structural shape (AC10)

tools/motion-preview/
  package.json                 # deps: @claudevid/core, @claudevid/renderer-canvas, @claudevid/motion
  src/cli.ts                   # --scene, --out (required), --frames/N (max 24), --force
  # Not part of `pnpm -r run test` — manually run dev tool (AC11 covers its own CLI-argument
  # tests only: no-clobber and N-cap, which are pure argument-parsing checks, no rendering).

packages/core/src/
  layers.ts                    # + Animation.stagger? field
  schema.ts                    # + Scene.transition? field + zod validation
  types.ts                     # + Scene.transition type, + export PropertyBag
  timeline.ts                  # compileTimeline: scene-overlap start-frame shift (FR12)
                                # + Timeline.transitionAt(frame) method
  property-bag.ts              # new: PropertyBag type only (no logic)

packages/renderer-canvas/src/
  index.ts                     # renderFrame: + opts.motion resolver param, transform bracket,
                                #              transitionAt two-pass paint, hold-frame bypass
```

### `Track` and `evaluate` (`track.ts`)

```ts
export type Channel = "opacity" | "x" | "y" | "scaleX" | "scaleY" | "rotation";

export interface Track {
  property: Channel;
  from: number;
  to: number;
  duration: number;        // seconds; required
  delay?: number;          // seconds; default 0
  easing?: EasingRef;      // default "linear"
}

export type EasingRef = string | SpringSpec;  // "linear" | "ease-out-cubic" | ... | spring(...)

// frame/trackStartFrame are both in the Timeline's absolute-frame space; fps is not an
// argument here because duration/delay were already converted to frames once, by
// compileMotion, at the moment tracks were resolved for a layer (see compile.ts) — evaluate
// itself never sees seconds or fps, only frame counts. This keeps evaluate a pure lookup.
export function evaluate(
  tracks: ResolvedTrack[],   // Track with duration/delay pre-converted to frame counts
  frame: number,
  trackStartFrame: number
): PropertyBag
```

`ResolvedTrack` (compile-time internal, not exported from the package's public surface) is
`Track` with `duration`/`delay` replaced by `durationFrames`/`delayFrames`, and — when `easing`
was a `SpringSpec` — `bakedFrames: number[]` attached and `durationFrames` set to
`bakedFrames.length`. `evaluate` branches once per track: if `bakedFrames` is present, index
into it (clamped to last); otherwise compute `t = clamp((frame - trackStartFrame -
delayFrames) / durationFrames, 0, 1)`, apply `resolveEasing(easing)(t)`, lerp `from → to`.

Same-property-twice invariant: enforced by a small dev-time assertion inside
`presets.ts`'s own registration helper (throws if a preset function returns two tracks with
the same `property`) plus a unit test that walks the whole shipped registry — not a
`Track`-level runtime check, since `Track[]` is only ever produced by first-party preset code
in v1, never spec-authored.

### Easing (`easing.ts`)

```ts
export function resolveEasing(name: string): EasingFn {
  // "linear" | "ease-in-quad" | ... | "ease-in-out-back" | "cubic-bezier(x1,y1,x2,y2)" | "steps(n,jump)"
  // → looked up from / parsed into @claudevid/core's exported functions. No duplication.
}

export interface SpringSpec { stiffness: number; damping: number; mass: number; velocity?: number }

export function bakeSpring(spec: SpringSpec, fps: number): number[] {
  // Rejects (throws a typed error compile.ts turns into a Diagnostic) if stiffness/damping/
  // mass are out of the FR4 ranges. Otherwise semi-implicit Euler-integrates the spring at
  // 1/fps timestep, appending eased-progress samples (0 = start, 1 = target) until settled
  // (|1 - value| < 0.001 and |velocity| < 0.001 for 3 consecutive samples) or `fps * 5`
  // samples are produced, whichever comes first. Returns { frames: number[]; settled:
  // boolean } internally; compile.ts turns settled: false into FR9's diagnostic.
}
```

### Presets (`presets.ts`)

```ts
type PresetFn = (params?: Record<string, number>) => Track[];
const registry = new Map<string, PresetFn>();

function definePreset(name: string, fn: PresetFn) { /* dev-time same-property check, then set */ }

definePreset("fade", () => [
  { property: "opacity", from: 0, to: 1, duration: 0.4, easing: "ease-out-cubic" },
]);
definePreset("fade-up", (p = {}) => [
  { property: "opacity", from: 0, to: 1, duration: p.duration ?? 0.4, easing: "ease-out-cubic" },
  { property: "y", from: p.distance ?? 48, to: 0, duration: p.duration ?? 0.4, easing: "ease-out-cubic" },
]);
// fade-down, slide-{left,right,up,down}, scale-fade, pop follow the same parameterised shape.

export function resolvePreset(name: string, params?: Record<string, number>): Track[] | undefined {
  return registry.get(name)?.(params);
}
export function exportCatalogue(): { name: string; channels: Channel[] }[] {
  return [...registry.entries()].map(([name, fn]) => ({
    name,
    channels: [...new Set(fn().map((t) => t.property))],
  }));
}
```

Presets currently accept no author-facing params from the spec (`animation.enter` is a bare
name string, per FR13/no schema change) — the `params` argument exists so `stagger`'s per-child
clone can override `delay`, and so a later change can wire spec-level param overrides without
reshaping this function's signature. Calling `resolvePreset(name)` with no params uses each
preset's own defaults.

### Stagger (`stagger.ts`)

```ts
export interface StaggerSpec { each: number; from?: "first" | "center" | "last" | "random" }

function fnv1a(s: string): number { /* standard 32-bit FNV-1a, pure */ }

export function orderIndices(childKeys: string[], from: StaggerSpec["from"] = "first"): number[] {
  // returns, for each position i in childKeys, its 0-based rank in stagger order
  const n = childKeys.length;
  if (from === "first") return childKeys.map((_, i) => i);
  if (from === "last") return childKeys.map((_, i) => n - 1 - i);
  if (from === "center") { /* distance-from-middle rank, ties broken by original index */ }
  // "random": stable-sort original indices by fnv1a(childKeys[i]), rank = position in that sort
}
```

`compile.ts` calls `orderIndices` once per staggered group, then for each child clones the
group's resolved preset tracks with `delay: (t.delay ?? 0) + each * orderIndices[i]`.

### `compileMotion` (`compile.ts`)

```ts
export function compileMotion(spec: VideoSpec, timeline: Timeline)
  : { compiled: Map<string, ResolvedTrack[]>; diagnostics: Diagnostic[] }
{
  const diagnostics: Diagnostic[] = [];
  const compiled = new Map<string, ResolvedTrack[]>();

  for (const tl of timeline.layers) {                 // tl: TimelineLayer (has layerKey, layer, start/endFrame)
    const anim = tl.layer.animation;
    if (!anim?.enter && !anim?.exit) continue;
    // group + stagger: resolve once, clone per child (children are separate `tl` entries
    // already, thanks to core's flattenLayers — see FR11); group's OWN tl entry is skipped,
    // matching 002's existing "group has no painter" behavior.
    ...
    const frameCount = tl.endFrame - tl.startFrame;
    const resolved = tracksFor(anim, spec.fps, /* stagger index if any */)
      .map(track => toResolvedTrack(track, spec.fps));  // seconds → frames, bakes springs
    for (const rt of resolved) {
      if (!rt.settled) diagnostics.push({ path: `/${tl.layerKey}/animation`, message: "spring did not settle within the 5s bake cap", suggestion: "lower stiffness or raise damping" });
      if (rt.delayFrames + rt.durationFrames > frameCount) diagnostics.push({ path: `/${tl.layerKey}/animation`, message: `animation (${rt.delayFrames + rt.durationFrames}f) exceeds the layer's active interval (${frameCount}f)`, suggestion: "shorten the animation or lengthen the layer" });
    }
    compiled.set(tl.layerKey, resolved);
  }
  return { compiled, diagnostics };
}
```

`resolver.ts` wraps the returned `compiled` map in the tiny interface `renderFrame` consumes:
`{ resolve(layerKey, frame) { const tracks = compiled.get(layerKey); return tracks &&
evaluate(tracks, frame, tl.startFrame); } }` (the resolver closes over each layer's own
`startFrame` at construction, since `Timeline` already has it).

### Core changes (`@claudevid/core`)

`property-bag.ts` (new file, no logic):

```ts
export interface PropertyBag {
  opacity?: number; x?: number; y?: number;
  scaleX?: number; scaleY?: number; rotation?: number;
}
```

`layers.ts` — `Animation` gains one field:

```ts
export interface Animation {
  enter?: string; exit?: string; duration?: number; delay?: number; easing?: string;
  stagger?: { each: number; from?: "first" | "center" | "last" | "random" };
}
```
(zod: `stagger: z.object({ each: z.number().positive(), from: z.enum([...]).optional() }).optional()`)

`types.ts`/`schema.ts` — `Scene` gains one field:

```ts
export interface Scene {
  id: string; duration: number | "auto"; background?: string; layers: Layer[];
  transition?: { kind: "cut" | "cross-fade"; duration?: number };
}
```

`timeline.ts` — `compileTimeline`'s scene loop changes from a pure running cursor to one that
looks one scene ahead for `transition`:

```ts
spec.scenes.forEach((scene, i) => {
  const seconds = resolveSceneDurationSeconds(scene, opts.audioDurations);
  const sceneFrames = framesFor(seconds, spec.fps);
  const requestedOverlap = scene.transition?.kind === "cross-fade"
    ? framesFor(scene.transition.duration ?? 0, spec.fps) : 0;
  const prevFrames = i > 0 ? (sceneWindows[i-1].endFrame - sceneWindows[i-1].startFrame) : 0;
  const overlapFrames = Math.min(requestedOverlap, Math.max(0, prevFrames - 1), Math.max(0, sceneFrames - 1));
  if (requestedOverlap > overlapFrames) diagnostics-worthy /* recorded via a new optional
    onOverlapClamped callback or surfaced by a thin compileMotion-side check — see Key
    Decision D3 for why this stays out of compileTimeline's own return type */;
  const startFrame = frameCursor - overlapFrames;
  const endFrame = startFrame + sceneFrames;
  sceneWindows.push({ sceneId: scene.id, startFrame, endFrame, transitionInFrames: overlapFrames });
  ...
  frameCursor = endFrame;
});
```

`SceneWindow` gains `transitionInFrames: number` (default `0`). `Timeline` gains:

```ts
transitionAt(frame: number): { outgoing: TimelineLayer[]; incoming: TimelineLayer[]; t: number } | null {
  const incomingWindow = binarySearchSceneWindow(sceneWindows, frame);
  if (!incomingWindow || incomingWindow.transitionInFrames === 0) return null;
  const overlapStart = incomingWindow.startFrame;
  const overlapEnd = incomingWindow.startFrame + incomingWindow.transitionInFrames;
  if (frame < overlapStart || frame >= overlapEnd) return null;
  const prevWindow = sceneWindows[sceneWindows.indexOf(incomingWindow) - 1]!;
  const t = (frame - overlapStart) / incomingWindow.transitionInFrames;
  return {
    outgoing: layers.filter(l => l.sceneId === prevWindow.sceneId && frame >= l.startFrame && frame < l.endFrame + incomingWindow.transitionInFrames),
    incoming: layers.filter(l => l.sceneId === incomingWindow.sceneId && frame >= l.startFrame && frame < l.endFrame),
    t,
  };
}
```

`activeAt(frame)` is **unchanged** — during an overlap window it still resolves to whichever
scene's window contains `frame` (the incoming scene, since windows now start earlier), which
is exactly the behavior existing 001/002 tests already assert and is fine for any caller that
doesn't care about transitions. `transitionAt` is the new, additive, opt-in entry point.

### Renderer changes (`@claudevid/renderer-canvas`)

`index.ts`'s `renderFrame`:

```ts
async renderFrame(timeline, frame, target, frameOpts = {}) {
  const transition = timeline.transitionAt?.(frame);
  const active = transition ? [...transition.outgoing, ...transition.incoming] : timeline.activeAt(frame);

  const anyMotion = active.some(l => frameOpts.motion?.resolve(l.layerKey, frame) !== undefined);
  const keySignature = active.map(l => l.layerKey).sort().join(",");
  if (!transition && !anyMotion && keySignature === previousLayerKeys && previousOutput) {
    /* existing hold-frame path, unchanged */
  }

  if (transition) {
    await paintFrame(transition.outgoing, scale, frameOpts.motion, frame);        // alpha 1
    ctx.save(); ctx.globalAlpha = transition.t;
    await paintFrame(transition.incoming, scale, frameOpts.motion, frame, /*paintBackground*/ true);
    ctx.restore();
  } else {
    await paintFrame(active, scale, frameOpts.motion, frame);
  }
  ...
}
```

`paintFrame`'s per-layer draw call gains the transform bracket:

```ts
const bag = motion?.resolve(layer.layerKey, frame);
ctx.save();
if (bag) {
  ctx.globalAlpha = bag.opacity ?? 1;
  const cx = layer.x + bitmap.width / 2, cy = layer.y + bitmap.height / 2;
  ctx.translate(cx + (bag.x ?? 0), cy + (bag.y ?? 0));
  ctx.rotate(((bag.rotation ?? 0) * Math.PI) / 180);
  ctx.scale(bag.scaleX ?? 1, bag.scaleY ?? 1);
  ctx.translate(-bitmap.width / 2, -bitmap.height / 2);
  ctx.drawImage(bitmap, 0, 0);
} else {
  ctx.drawImage(bitmap, layer.x, layer.y);   // existing call, untouched when no bag
}
ctx.restore();
```

(`image` layers, painted via `paintImageLayer(ctx, ...)` directly rather than a cached
bitmap, get the same bracket around their existing draw call using `layer.width`/`layer.height`
as the box.)

## File Changes Map

| File | Action | Description |
|------|--------|--------------|
| `packages/motion/package.json` | create | deps: `@claudevid/core` (workspace) |
| `packages/motion/tsup.config.ts` | create | ESM build |
| `packages/motion/vitest.config.ts` | create | test runner |
| `packages/motion/tsconfig.json` | create | extends root base |
| `packages/motion/src/properties.ts` | create | `Channel` union, free-only cost table |
| `packages/motion/src/track.ts` | create | `Track`, `ResolvedTrack`, `evaluate` |
| `packages/motion/src/easing.ts` | create | `resolveEasing`, `spring`, `bakeSpring` |
| `packages/motion/src/presets.ts` | create | registry, 9 shipped presets, `exportCatalogue` |
| `packages/motion/src/stagger.ts` | create | `orderIndices`, FNV-1a hash |
| `packages/motion/src/compile.ts` | create | `compileMotion` |
| `packages/motion/src/resolver.ts` | create | `createResolver` |
| `packages/motion/src/index.ts` | create | public exports |
| `packages/motion/test/*.test.ts` | create | 6 test files per Architecture |
| `tools/motion-preview/package.json` | create | deps: core, renderer-canvas, motion |
| `tools/motion-preview/src/cli.ts` | create | contact-sheet dumper CLI |
| `packages/core/src/property-bag.ts` | create | `PropertyBag` type, no logic |
| `packages/core/src/layers.ts` | modify | `Animation.stagger?` field + zod |
| `packages/core/src/schema.ts` | modify | `Scene.transition?` zod validation |
| `packages/core/src/types.ts` | modify | `Scene.transition?` type, re-export `PropertyBag` |
| `packages/core/src/timeline.ts` | modify | scene-overlap start-frame shift, `transitionAt` |
| `packages/core/src/index.ts` | modify | export `PropertyBag`, no other new exports |
| `packages/core/test/timeline.test.ts` | modify | + overlap/transitionAt tests (AC7) |
| `packages/renderer-canvas/src/index.ts` | modify | `opts.motion`, transition two-pass, hold-frame bypass |
| `packages/renderer-canvas/test/render.test.ts` | modify | + AC8/AC9 tests |

## Data Model Changes

New types: `Track`, `ResolvedTrack`, `Channel`, `SpringSpec`, `StaggerSpec` (all
`@claudevid/motion`, internal-ish but exported for testability); `PropertyBag` (new,
`@claudevid/core`, shared). Extended types: `Animation` (+`stagger?`), `Scene`
(+`transition?`), `SceneWindow` (+`transitionInFrames`), `Timeline` (+`transitionAt`),
`RenderFrameOptions`-equivalent (renderer-canvas's `frameOpts`, +`motion?`).

## API Changes

New public exports from `@claudevid/motion`: `evaluate`, `compileMotion`, `createResolver`,
`resolveEasing`, `spring`, `bakeSpring`, `resolvePreset`, `exportCatalogue`,
`orderIndices` (test-facing), plus the `Track`/`Channel`/`SpringSpec`/`StaggerSpec` types.

`@claudevid/core` additions: `PropertyBag` type export; `Timeline.transitionAt` method.
No existing export's signature changes.

`@claudevid/renderer-canvas`: `renderFrame`'s options parameter gains an optional `motion`
field. No existing export's signature changes otherwise.

## Key Decisions

1. **D1 — Frame-indexed evaluation and frame-baked springs, not seconds-based.**
   `GOALS.md` flagged a general risk: baking to a frame count "needs an fps `evaluate` doesn't
   carry," and separately suggested baking to *seconds* "so a 720p preview doesn't lie about
   final timing." Both concerns assume a timeline can be evaluated at more than one
   fps/sample-rate for the "same" render. That doesn't happen in this codebase:
   `compileTimeline` fixes `frameCount`/`sceneWindows`/every `TimelineLayer`'s frame range
   once, from `spec.fps`, and is the sole timing authority (`timeline.ts`'s own doc comment).
   `renderer-canvas`'s resolution scaling (`RenderFrameOptions.scale`) is spatial only — it
   never re-samples time. So there is exactly one fps per `Timeline`, always, and baking
   springs to frames at `compileMotion` time (which already receives both `spec` and
   `timeline`) is consistent with — not a new coupling on top of — the architecture 001/002
   already committed to. `evaluate` itself takes frame integers, matching `Timeline.
   activeAt(frame)`'s own signature, rather than introducing a second, seconds-based notion of
   "when" alongside `Timeline`'s frame-based one.
2. **D2 — Cut to free channels only; no invalidating-channel diagnostics in v1.** The
   party-security BLOCK ("cost diagnostics fail open by default") has no good answer that
   preserves the original proposal's full scope in one change: naming a disposition and an
   owning layer (as party-architect/party-ba also asked) still leaves the actual *threshold*
   (what counts as "a long window") as a number someone has to pick without real render-cost
   data from this renderer. Rather than pick an arbitrary number, this change ships nothing
   that needs the diagnostic yet. That is a scope cut, not a deferred bug — recorded loudly in
   spec.md's Notes so it isn't mistaken for an oversight.
3. **D3 — Transition-overlap clamp diagnostics surface through `compileMotion`, not
   `compileTimeline`'s return type.** `compileTimeline`'s signature (`Timeline`, no
   diagnostics channel) is a 001 public API already depended on by existing tests; adding a
   diagnostics return there is the "core needs to know about motion" layering 002/GOALS.md
   both said to avoid. Instead, `compileMotion` (which already receives `timeline` and returns
   `diagnostics`) re-derives the same clamp check by comparing each `sceneWindows[i].
   transitionInFrames` against the scene's own `scene.transition?.duration` (both readable
   from its two existing arguments) and reports it there. `compileTimeline` itself still
   silently clamps (matching its own established "clamp, don't diagnose" precedent for
   rendering-time overflow) — the *diagnostic* about that clamp having happened lives in the
   package whose whole job is diagnostics about animation.
4. **D4 — Rotation/scale origin is always the layer's own rendered-bitmap center; no
   per-layer override in v1.** Every shipped preset only ever needs a fixed origin (`pop`/
   `scale-fade` scale around center; none of the nine presets rotate). Adding an `originX`/
   `originY` override now, with no preset or FR needing one, is exactly the speculative-option
   YAGNI this repo's guardrails warn against — revisit when a preset actually needs it.
5. **D5 — `cross-fade` is a two-pass paint inside `renderer-canvas`, not a buffer-compositing
   library in `motion`.** `motion` stays canvas-free (NFR1); the alternative (motion returning
   two rendered buffers for the caller to blend) would require motion to either own a canvas
   itself or hand back raw pixel buffers, both of which break "it draws nothing." Painting the
   outgoing scene opaque, then the incoming scene on top at `globalAlpha = t`, achieves a
   correct cross-dissolve using only mechanisms `renderer-canvas` already has (`ctx.
   globalAlpha`, `ctx.drawImage`) — no new compositing math anywhere.
6. **D6 — `Timeline.activeAt` is unchanged; `transitionAt` is new and additive.** Reshaping
   `activeAt` to sometimes return two scenes' worth of layers would change existing 001/002
   test assertions and any future caller that doesn't know about transitions. Keeping it
   untouched and adding a second, opt-in method is a strictly additive change to a sealed,
   verify-PASSed package (NFR3).
7. **D6.5 — `binarySearchSceneWindow` needed a real algorithm change, found during
   implementation.** The design-time assumption that scene windows stay disjoint (only
   `startFrame` shifts backward, `endFrame` untouched) means the outgoing scene's own window
   and the incoming scene's window genuinely overlap in frame-range space during a transition
   — the old "does `[start,end)` contain `frame`" bisection can return either window there,
   since both contain it. Fixed by searching for "the rightmost window whose `startFrame <=
   frame`" instead (still correct via plain bisection, since `startFrame` stays strictly
   increasing even with overlap — provable from the `min`-guard in `compileTimeline`). This is
   provably identical to the old result whenever windows are disjoint (every pre-existing
   caller), so it is a pure bugfix for the new overlapping case, not a behavior change for
   001/002. Caught by AC7's own `transitionAt` test, not by inspection — recorded here per
   this repo's own precedent (002 design.md's Key Decision 7) for design-time guesses
   superseded once actually implemented.

## Risks & Mitigations

- **Risk: the `timeline.ts` scene-overlap arithmetic is the one real change to an
  already-verified, merged package (001).** *Mitigation:* scoped to exactly one loop (the
  scene-window construction in `compileTimeline`) plus one new method (`transitionAt`);
  `activeAt` and every other exported function is untouched (D6). AC7 is a regression test
  added directly to `packages/core/test/timeline.test.ts` so the change is verified in the
  same suite 001's existing tests live in, not a new, easy-to-skip location.
- **Risk: hold-frame bypass (FR16) silently regresses 002's perf numbers for scenes with
  ongoing animation** (every frame of an animated layer now repaints, no cache). *Mitigation:*
  this is the correct, unavoidable cost of correctness — an animated layer's pixels genuinely
  differ every frame, so 002's raster-cache (bitmap-level) still applies and only the
  *hold-frame* (whole-frame) shortcut is skipped for those frames; static layers sharing the
  same frame keep the existing hold-frame path. No perf regression test threshold changes
  since 002's AC7 fixture has no animated layers.
- **Risk: nine shipped presets is a small catalogue for change 007's director prompt to work
  with.** *Mitigation:* explicitly intentional (D2's sibling cut, party-po's own
  recommendation) — the registry's parameterised-template shape (FR6) means growing it later
  is adding a `definePreset` call, not a design change.
- **Risk: `bakeSpring`'s semi-implicit-Euler settle detection could flag a technically-settled
  spring as unsettled near the `fps * 5` cap boundary for extreme but valid parameter
  combinations.** *Mitigation:* the settle thresholds (`0.001`, 3 consecutive frames) and the
  cap (5s) are generous relative to any of the nine shipped presets' needs (none use springs
  yet — springs are available as an `easing` option for a future preset/consumer); AC4 tests
  the diagnostic path directly with a deliberately-pathological spec so the boundary behavior
  is pinned by a test rather than left to production discovery.
