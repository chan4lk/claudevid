# Design: VideoSpec Schema, Timeline Compiler & Core Contract

**Change:** 001-videospec-core
**Created:** 2026-09-06

## Technical Approach

`@claudevid/core` is a pure-function package: parse → compile → (handed off to 002+).
Everything is a plain, serializable data transform with no side effects, so it can be
unit-tested exhaustively and handed across a worker-thread boundary (change 005) with no
special-casing.

Pipeline:

```
raw JSON (from Claude or a file)
   │  parseSpec()
   ▼
{ ok, spec } | { ok: false, diagnostics }
   │  compileTimeline(spec, { audioDurations? })
   ▼
Timeline  (frameCount, sceneWindows, layers[], activeAt(frame))
```

Zod is the single source of truth (`schema.ts`, `layers.ts`); every exported type in
`types.ts` is `z.infer<typeof ...>`. The JSON Schema handed to Claude (`json-schema.ts`) is
generated from the same Zod definitions, so the validator and the structured-output schema
can never diverge.

## Architecture

```
packages/core/
  src/
    schema.ts        # videoSpecSchema, sceneSchema (top-level, imports layers.ts)
    layers.ts         # layer union, registerLayer(), layer registry
    types.ts           # z.infer re-exports — the public type surface
    resolve.ts          # coordinate/style resolution helpers
    timeline.ts          # compileTimeline, Timeline, activeAt
    easing.ts             # cubic/quad/expo/back, cubicBezier, steps
    diagnostics.ts         # parseSpec, Diagnostic, Zod-issue → JSON-pointer + suggestion
    json-schema.ts          # generateJsonSchema()
    index.ts                 # public exports
  test/
    schema.test.ts
    layers.test.ts
    timeline.test.ts          # golden frame-window tests
    resolve.test.ts
    easing.test.ts
    diagnostics.test.ts
    json-schema.test.ts
  package.json
  tsup.config.ts
  vitest.config.ts
```

Monorepo root:

```
claudevid/
  packages/core/           (this change)
  pnpm-workspace.yaml
  tsconfig.base.json
  package.json              # root: workspace scripts (build/test/lint across packages)
  .gitignore                 (already present)
```

### Layer registry (the extension seam)

```ts
// layers.ts
const registry = new Map<string, z.ZodTypeAny>([
  ["text", textLayerSchema],
  ["rect", rectLayerSchema],
  ["image", imageLayerSchema],
  ["group", groupLayerSchema], // recursive via z.lazy(() => layerUnion())
]);
let cached: z.ZodTypeAny | null = null;

export function registerLayer(type: string, layerSchema: z.ZodTypeAny) {
  registry.set(type, layerSchema);
  cached = null; // invalidate memoized union
}

export function layerUnion(): z.ZodTypeAny {
  if (!cached) {
    cached = z.discriminatedUnion("type", [...registry.values()] as any);
  }
  return cached;
}
```

`schema.ts`'s `sceneSchema` references `z.array(z.lazy(() => layerUnion()))` so a call to
`registerLayer` made before `parseSpec` is invoked is picked up without rebuilding
`schema.ts`'s own schema object.

### Nesting-depth guard

`group.children` recurses through `layerUnion()`. Depth is enforced with a `superRefine` at
the top of `sceneSchema` that walks the parsed layer tree counting `group` ancestors; on a
violation it adds a Zod issue with a `path` pointing at the offending layer, which
`diagnostics.ts` turns into a normal JSON-pointer diagnostic (no special-casing needed there).

### Timeline compiler

```ts
function framesFor(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

export function compileTimeline(spec: VideoSpec, opts: { audioDurations?: Record<string, number> } = {}): Timeline {
  let frameCursor = 0;
  const sceneWindows: SceneWindow[] = [];
  const layers: TimelineLayer[] = [];

  for (const scene of spec.spec.scenes) {
    const seconds = scene.duration === "auto"
      ? requireAudioDuration(scene.id, opts.audioDurations)
      : scene.duration;
    const frameLen = framesFor(seconds, spec.fps);
    const startFrame = frameCursor;
    const endFrame = frameCursor + frameLen;
    sceneWindows.push({ sceneId: scene.id, startFrame, endFrame });
    layers.push(...flattenLayers(scene, startFrame, endFrame, spec));
    frameCursor = endFrame;
  }

  return {
    frameCount: frameCursor,
    sceneWindows,
    layers,
    activeAt: (frame) => activeAtImpl(sceneWindows, layers, frame),
  };
}
```

`requireAudioDuration` throws `MissingAudioDurationError` (a named exported error class, not
a generic `Error`) when `duration === "auto"` and the map lacks that scene's id — this is the
"no silent estimate" guard from GOALS.md, enforced structurally rather than by convention.

`activeAtImpl` binary-searches `sceneWindows` for the scene containing `frame`, then filters
that scene's layers by their own (already-resolved, already-clamped) `[startFrame, endFrame)`.
Binary search matters once specs reach the 30-min/54,000-frame golden-test scale under
repeated calls (e.g. from 002's per-frame render loop).

### Coordinate resolution (`resolve.ts`)

```ts
function resolveAxis(value: number | "center" | `${number}%` | undefined, dimension: number): number {
  if (value === undefined || value === "center") return dimension / 2;
  if (typeof value === "string" && value.endsWith("%")) return (parseFloat(value) / 100) * dimension;
  return value;
}
```

Applied once per layer at compile time against `spec.width`/`spec.height`; the resolved
`Timeline.layers[].x`/`y` are always plain numbers. Nothing downstream re-parses a string.

## File Changes Map

| File | Action | Description |
|------|--------|--------------|
| `pnpm-workspace.yaml` | create | declares `packages/*` |
| `tsconfig.base.json` | create | shared strict TS config |
| `package.json` (root) | create | workspace scripts: `build`, `test`, `lint` (turbo-free, just pnpm `-r`) |
| `.gitignore` | modify | add `node_modules/`, `dist/`, `.turbo/` if not already present |
| `packages/core/package.json` | create | `@claudevid/core`, deps: zod, zod-to-json-schema |
| `packages/core/tsup.config.ts` | create | ESM build, `.d.ts` emit |
| `packages/core/vitest.config.ts` | create | test runner config |
| `packages/core/src/schema.ts` | create | videoSpecSchema, sceneSchema, uniqueness refine |
| `packages/core/src/layers.ts` | create | layer union, registry, registerLayer() |
| `packages/core/src/types.ts` | create | z.infer exports |
| `packages/core/src/resolve.ts` | create | coordinate/style resolution |
| `packages/core/src/timeline.ts` | create | compileTimeline, Timeline, activeAt |
| `packages/core/src/easing.ts` | create | easing catalogue |
| `packages/core/src/diagnostics.ts` | create | parseSpec, Diagnostic |
| `packages/core/src/json-schema.ts` | create | generateJsonSchema() |
| `packages/core/src/index.ts` | create | public exports |
| `packages/core/test/*.test.ts` | create | unit + golden tests (7 files, see Architecture) |

## Data Model Changes

New (this is the first change — nothing pre-existing to migrate):

- `VideoSpec`, `Scene`, `Layer` (discriminated union: `TextLayer | RectLayer | ImageLayer |
  GroupLayer`, extensible via `registerLayer`), `Diagnostic`, `Timeline`, `TimelineLayer`,
  `SceneWindow`.

## API Changes

Public exports from `@claudevid/core` (`index.ts`):

- `parseSpec(json: unknown): { ok: true; spec: VideoSpec } | { ok: false; diagnostics: Diagnostic[] }`
- `compileTimeline(spec: VideoSpec, opts?: { audioDurations?: Record<string, number> }): Timeline`
- `registerLayer(type: string, schema: z.ZodTypeAny): void`
- `generateJsonSchema(): object`
- Easing: `linear`, `easeInQuad`, `easeOutQuad`, `easeInOutQuad`, `easeInCubic`, ..., `easeInExpo`, ..., `easeInBack`, ..., `cubicBezier(x1,y1,x2,y2): (t:number) => number`, `steps(n, direction): (t:number) => number`
- Types: `VideoSpec`, `Scene`, `Layer`, `TextLayer`, `RectLayer`, `ImageLayer`, `GroupLayer`,
  `Timeline`, `TimelineLayer`, `SceneWindow`, `Diagnostic`
- `MissingAudioDurationError` (named error class)

## Key Decisions

1. **`duration: "auto"` — proposal recommendation (a), no estimate mode in v1.** Optional
   `audioDurations` map; missing entry for an `"auto"` scene always throws
   `MissingAudioDurationError`. Rejected: silent estimate fallback (violates GOALS.md's "an
   absent map must not silently produce estimated timings" guard) and two-pass compile
   (adds complexity 001 doesn't need — 006 can resolve durations before calling
   `compileTimeline` once).
2. **`animation.enter`/`exit` typed as `string`, not a Zod enum.** GOALS.md's panel review of
   change 003 explicitly warns that a closed preset enum baked into core forces a core version
   bump every time the preset registry changes, and flags "two resolvers for `fade-up`" as a
   drift risk if core and 003 disagree. Core carries the field as an opaque string; 003 owns
   validating it against its live, versioned registry.
3. **Percentage-string coordinates (`"50%"`) included in v1; named safe-area anchors deferred.**
   Percentages are a small, self-contained addition (one branch in `resolveAxis`) that directly
   serves 007's `--vertical` flag. Safe-area anchors have no consumer yet in any approved
   proposal — deferring avoids designing an API against a guess.
4. **Layer nesting capped at 2 levels**, enforced by `superRefine` producing a normal
   diagnostic (not a raw recursion/stack error). Chosen per the proposal's own suggestion to
   bound raster-cache complexity in 002; additive to relax later.
5. **Frame rounding uses `Math.round`, not `Math.ceil`/`Math.floor`.** Ceil would
   systematically lengthen every scene (compounding drift toward longer total duration over
   many scenes); floor would systematically shorten it. Round is the only choice with zero
   expected bias, which is what the golden 1-hour-timeline test (AC5) actually verifies.
6. **`registerLayer`'s union is memoized and invalidated on registration**, not rebuilt from
   scratch on every `parseSpec` call — avoids `z.discriminatedUnion` reconstruction cost on
   every parse (007's repair loop calls `parseSpec` repeatedly in a tight retry loop).
7. **A layer's `start`/`duration` overflowing its scene window is silently clamped, not
   diagnosed, in v1.** Documented as a known limitation (spec.md Notes) rather than solved now
   — no proposal currently produces layers with per-layer timing in practice (003/006 do
   later); solving it well requires deciding whether it's a hard error or a warning, which is
   better decided with a real caller in hand.

## Risks & Mitigations

- **Risk: getting the contract wrong is expensive to unwind** (proposal's own risk framing —
  6 downstream changes depend on this schema). *Mitigation:* the two structural decisions with
  the widest blast radius (`duration: "auto"` handling, animation typing) both follow the
  proposal's and GOALS.md's own recommendations rather than inventing new positions; the
  narrowest-scope-that-satisfies-the-known-consumers principle is applied everywhere else
  (percentages yes / safe-areas no, nesting cap 2, no estimate mode).
- **Risk: `zod-to-json-schema` output drift from hand expectations of change 007's structured
  output.** *Mitigation:* AC10 round-trips the generated schema against a real validator in
  this change's own test suite, so a `zod-to-json-schema` version bump that changes output
  shape is caught here, not silently in 007.
- **Risk: silent clamping of overflowing layer timing (Key Decision 7) surprises a future
  caller.** *Mitigation:* documented explicitly in spec.md Notes and design Key Decisions so
  it's discoverable, and named as a candidate diagnostic to add once 003/006 exist.
