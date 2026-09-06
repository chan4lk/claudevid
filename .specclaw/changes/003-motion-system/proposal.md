# Proposal: Motion System — Animatable Properties, Springs, Stagger & Scene Transitions

**Created:** 2026-09-06
**Status:** 🟡 Draft

**Depends on:** 001-videospec-core (`Timeline`, easing), 002-canvas-render-engine (raster cache
boundary — what is cheap to animate).

## Problem

This is the change the whole library is named for, and it is the one the requirement doc
underspecifies most.

The doc's animation model is a **flat string enum**:

```ts
type AnimationPreset =
  | "fade" | "fade-up" | "fade-down" | "scale-fade"
  | "slide-left" | "slide-right" | "typewriter";
```

evaluated by a single helper that returns an opacity:

```ts
function getEnterOpacity(layer, localTime) { /* linear 0 → 1 */ }
```

That is a slideshow, not motion graphics. Four things are wrong with it, and each one is a
ceiling the library would hit within a week of real use:

1. **Only opacity animates.** `fade-up` is in the enum but there is no mechanism to move
   anything. Position, scale, rotation, colour, clip, letter-spacing — none are animatable.
2. **Presets are code branches, not data.** Every new look ("slide-up-blur", "wipe-in-left")
   means a new enum member in the core Zod schema *and* a new `if` in the renderer *and* a
   change to Claude's director prompt. The library's expressiveness becomes a function of how
   many `if` statements someone wrote, which is precisely the design that stops libraries
   growing.
3. **No stagger, no transitions.** The two highest-value motion-graphics primitives are absent.
   Bullet points appearing one-by-one, code lines cascading in, chart bars rising in sequence —
   all stagger. Scenes cutting hard to black between every beat, with no cross-fade, push, or
   shared-element move, is the single most obvious "this was generated" tell in an explainer video.
4. **Easing is linear.** `(localTime - delay) / duration`. Linear motion reads as mechanical
   and cheap to any viewer, whatever the content.

Meanwhile the deeper constraint from change 002 is unaddressed anywhere in the doc: **some
properties are free to animate and some are ruinously expensive.** Animating `y` is a
transform on a cached bitmap (~free). Animating `fontSize` invalidates the raster cache and
forces a full text re-layout every frame (~50× the cost). A motion system that does not know
the difference will cheerfully produce a spec that renders at 4 fps, and nobody will know why.

## Proposed Solution

Build `@claudevid/motion` — a **pure, declarative, time → property-bag evaluation engine**.
It draws nothing. It takes tracks and a local time and returns resolved values. That purity is
what makes it exhaustively testable, trivially parallelizable across the workers in change 005,
and safe to hand to Claude.

**1. Animatable property model.**
Every layer property becomes a typed animatable channel with a declared cost class:

| Channel | Type | Cost | Mechanism in 002 |
|---|---|---|---|
| `opacity` | number | free | `globalAlpha` |
| `x`, `y` | number | free | transform |
| `scale`, `scaleX/Y` | number | free | transform |
| `rotation`, `skew` | number | free | transform |
| `clip` (reveal fraction) | number | free | clip rect on blit |
| `color`, `background` | colour | **invalidating** | re-raster |
| `fontSize`, `letterSpacing`, `width` | number | **invalidating** | re-layout + re-raster |
| `text` / `revealChars` | string/int | **line-cached** | see change 004 |

The cost class is not decoration — the compiler **emits a diagnostic** when a spec animates an
invalidating channel over a long window, telling the author (or Claude) the cheap equivalent
("animate `scale` instead of `fontSize`"). This is the mechanism that keeps generated videos fast
by construction rather than by luck.

**2. Track model.**

```ts
type Track = {
  property: AnimatableProperty
  from?: Value; to?: Value          // shorthand
  keyframes?: { at: number; value: Value; easing?: Easing }[]
  easing?: Easing
  delay?: number; duration?: number
  repeat?: number | "loop"; direction?: "normal" | "alternate"
}

evaluate(tracks: Track[], localTime: number): PropertyBag   // pure
```

**3. Interpolators, per type.**
- **number** — with easing applied in normalized time.
- **colour** — interpolated in **OKLCH**, not sRGB. An sRGB lerp from a brand blue to a brand
  orange passes through muddy grey; OKLCH stays saturated. This is a small amount of maths that
  visibly separates polished output from generic output.
- **transform** — composed as a matrix so rotation about a chosen origin behaves correctly
  under nesting.
- **discrete** — typewriter character counts, line reveal indices, sprite indices (step easing).

**4. Easing, properly.**
The full standard set, CSS-compatible `cubic-bezier(x1,y1,x2,y2)`, `steps(n, jump)`, and —
the one that matters most for feel — **springs**: `spring({ stiffness, damping, mass, velocity })`.
Springs are solved and **baked to a fixed frame count at compile time**, so evaluation stays a
pure lookup and the timeline's duration is knowable in advance (a spring that settles on its own
schedule cannot be composed into a fixed-length scene).

**5. Presets become compositions, not enum members.**
A preset is *data*: a named bundle of tracks.

```ts
"fade-up": [
  { property: "opacity", from: 0, to: 1, easing: "out-cubic" },
  { property: "y",       from: 48, to: 0, easing: "out-cubic" },
]
```

New preset = a new entry in the registry. No core schema change, no renderer branch, and the
catalogue is exported as documentation that change 007 injects into Claude's director prompt —
so the model's expressive range grows automatically as the registry grows.

Preset families shipped: fades, slides (4 directions), scale/pop, blur-in (pre-rendered), clip
wipes (4 directions), typewriter, counter (animated numbers), draw-on (path length), and
attention beats (pulse, shake, wiggle).

**6. Stagger — the highest-value primitive here.**

```ts
stagger({ each: 0.06, from: "first" | "center" | "last" | "random", easing?, overlap? })
```

Applied to a `group`'s children (change 001's `group` layer exists for exactly this), it turns
one declaration into a cascading reveal of bullets, code lines, chart bars, or icon rows.
This is the difference between "text appeared" and "the list built itself".

**7. Scene transitions — evaluated at the timeline level.**
A transition is declared *between* scenes and evaluated above the layer loop, so change 002 can
compose it as an operator over two scene buffers:

- `cut` (default), `cross-fade`, `dip-to-colour`
- `push` / `slide` (4 directions), `wipe` (4 directions + radial)
- **`shared-element`** — layers in adjacent scenes carrying the same `id` are matched and
  their position/scale/colour interpolated across the boundary. This is the "one continuous
  idea" effect that makes a sequence read as an argument rather than a deck. It is the reason
  change 001 assigns stable `layerKey`s.

**8. Timing safety and diagnostics.**
Animations are clamped to the layer's active interval from change 001. A 2s enter animation on
a 1.2s layer is a **diagnostic**, not a silent truncation — otherwise Claude generates it, nobody
notices, and the video ships with a title that never finishes appearing.

**9. `motion-preview` contact sheet.**
A dumper that renders N evenly-spaced frames of a scene to a single PNG grid. Reviewing motion
should not require a 20-minute encode; this makes iterating on feel a 2-second loop, and it is
what makes changes 004/006/007 developable at all.

## Scope

### In Scope

- `packages/motion/src/track.ts` — `Track`, `evaluate`, clamping, repeat/direction
- `packages/motion/src/properties.ts` — animatable channel registry + cost classes
- `packages/motion/src/interpolate/` — number, oklch colour, transform matrix, discrete
- `packages/motion/src/easing.ts` — spring solver + baking (builds on 001's easing primitives)
- `packages/motion/src/presets.ts` — preset registry, shipped preset families, catalogue export
- `packages/motion/src/stagger.ts` — stagger over `group` children
- `packages/motion/src/transitions.ts` — transition definitions incl. shared-element matching
- `packages/motion/src/schema.ts` — Zod fragment contributed to core's layer/scene schema
- `packages/motion/src/diagnostics.ts` — cost warnings, over-long animation warnings
- `tools/motion-preview` — frame contact-sheet dumper
- Golden numeric tests per interpolator; visual regression via contact-sheet hashes

### Out of Scope

- Physics beyond springs (collisions, particles, n-body)
- 3D transforms, camera, perspective
- WebGL/shader effects, per-pixel filters
- Audio-reactive motion (needs 006's audio analysis — a natural follow-on)
- Path-following along arbitrary bezier paths (candidate for a later change)
- The actual painting of any of this — change 002 owns pixels

## Impact

- **Files affected:** ~28 new
- **Complexity:** large
- **Risk:** medium — the maths is well-understood and pure functions are cheap to test. The
  real risk is **schema surface area**: every capability added here is something Claude can get
  wrong, and the expressiveness/reliability tradeoff is a genuine design decision (below).

## Open Questions

- **How much motion vocabulary does Claude get?** Three options: (a) named presets + a few
  numeric params only — most reliable, least expressive; (b) presets plus raw keyframe tracks —
  maximally expressive, and a model that emits `{ property: "fontSize", keyframes: [...] }` over
  8 seconds has just made the render 50× slower; (c) presets by default, raw tracks behind an
  opt-in `allowRawTracks` flag. **Recommendation: (c)** — the cost diagnostics exist precisely so
  (b) fails loudly, but the default should be the safe surface.
- **Shared-element transitions need stable ids across scenes.** Should core's schema *require*
  unique layer ids, or should matching be opt-in via an explicit `sharedId`? Requiring ids is
  cleaner but adds a field Claude must get right on every layer.
- **Spring baking vs live integration.** Baking gives fixed durations and pure evaluation but
  loses interruptibility (irrelevant for offline render). Confirm no future interactive/preview
  use case needs live springs before committing.
- **Where do cost diagnostics fire?** At `compileTimeline` (early, but core would need to know
  about motion) or at render start (later, but keeps core motion-agnostic)? This is a layering
  decision that affects change 001's public API.
- **Do transitions overlap scene durations or extend the timeline?** A 0.5s cross-fade between
  two 3s scenes yields either 5.5s (overlapping) or 6.5s (inserted). Overlapping is correct for
  video but complicates change 005's chunk-boundary splitting, since chunks can no longer be cut
  cleanly at scene edges.

### Panel findings (adversarial review, round 2 — all upheld)

_Appended by the party panel. Verdict: CHANGES_REQUESTED (advisory; `party.block: false`)._

- **[BLOCK]** (party-architect) The existing preset enum and its renderer branches are never retired, leaving two sources of truth for what a preset is — see party-report.md
- **[BLOCK]** (party-architect) The package dependency is declared in both directions at once and the injection mechanism is unnamed — see party-report.md
- **[BLOCK]** (party-architect) Spring baking needs a frame rate that the pure evaluation signature does not carry, and no component is named as the baker — see party-report.md
- **[BLOCK]** (party-architect) `from: "random"` puts nondeterminism inside the component whose purity is the design's load-bearing claim — see party-report.md
- **[WARN]** (party-architect) The `Track` shape leaves at least four resolution rules for the implementer to invent — see party-report.md
- **[WARN]** (party-architect) `PropertyBag` is the contract with the renderer and its shape is undefined, particularly for transforms — see party-report.md
- **[WARN]** (party-architect) The body asserts the compiler emits cost diagnostics; the open questions say the layer is undecided — see party-report.md
- **[WARN]** (party-architect) Transition timing semantics decide the meaning of timeline duration, and are left open while three other components depend on the answer — see party-report.md
- **[WARN]** (party-architect) Two easing homes: the full standard set lands in motion while core keeps the easing this proposal builds on — see party-report.md
- **[WARN]** (party-architect) The visual regression strategy has no stub seam; it runs through the render engine this package claims not to depend on — see party-report.md
- **[NOTE]** (party-architect) Rebuttal of party-visionary on transitions-as-closed-list: transitions and presets sit at different seams, so the preset remedy does not transfer — see party-report.md
- **[BLOCK]** (party-ba) The core problem evidence (quoted "doc" code) is unsourced and unverifiable from this artifact — see party-report.md
- **[WARN]** (party-ba) The "~50× the cost" figure is asserted twice with no source, and drives a real design recommendation — see party-report.md
- **[WARN]** (party-ba) No acceptance criteria section exists; the proposal's central claims have no falsification path — see party-report.md
- **[WARN]** (party-ba) "Diagnostic" is load-bearing and carries two contradictory readings (advisory warning vs. hard failure) — see party-report.md
- **[NOTE]** (party-ba) Proposal assumes an unestablished human-review step will catch what diagnostics don't — see party-report.md
- **[WARN]** (party-po) Do-nothing cost is stated only as qualitative severity, never quantified — see party-report.md
- **[WARN]** (party-po) Full preset catalogue shipped day one, despite the proposal's own argument that presets are cheap to add later — see party-report.md
- **[NOTE]** (party-po) Shared-element transition is bundled with the simple transition set, with no separate cut line named — see party-report.md
- **[WARN]** (party-po) Recurring visual-regression test cost is unstated — see party-report.md
- **[WARN]** (party-po) Shipped default for transition duration semantics is left undecided — see party-report.md
- **[BLOCK]** (party-security) Preset catalogue is exported as untrusted content directly into the director prompt — see party-report.md
- **[BLOCK]** (party-security) Cost and over-length "diagnostics" have no stated severity, so the design fails open by default — see party-report.md
- **[BLOCK]** (party-security) `allowRawTracks` is an escape hatch with no stated holder; if the spec can set it, the reviewed party controls its own gate — see party-report.md
- **[WARN]** (party-security) Spring solver and repeat/loop are unbounded compile-time work with no stated limits — see party-report.md
- **[WARN]** (party-security) Shared-element matching is control flow driven by model-authored ids with no stated collision behaviour — see party-report.md
- **[NOTE]** (party-security) `motion-preview` writes files with no stated output-path constraint — see party-report.md
- **[NOTE]** (party-security) Rebuttal: party-architect's alternative fix, an open `string` validated against the registry, converts a fail-closed check into a fail-open one — see party-report.md
- **[WARN]** (party-visionary) The cost-class table is a hand-copied fact about 002's renderer, kept in sync by nobody — see party-report.md
- **[WARN]** (party-visionary) Preset names and their numbers become a persisted, prompt-taught grammar with no version — see party-report.md
- **[WARN]** (party-visionary) Baking springs to a frame count couples timeline duration to render fps — see party-report.md
- **[WARN]** (party-visionary) Transitions are shipped as a closed named list, the exact shape the Problem section condemns for presets — see party-report.md
- **[WARN]** (party-visionary) The shipped preset families already break the "preset is a bundle of tracks" rule, so that is the precedent that will be copied — see party-report.md
- **[WARN]** (party-visionary) Transition duration semantics is framed as a pipeline trade-off; it is a one-way contract on every video's length — see party-report.md
- **[NOTE]** (party-visionary) Presets hardcode pixel magnitudes; one step from parameterised presets before the static shape is pinned — see party-report.md
- **[NOTE]** (party-visionary) Cost classes stop at a warning; the same data could drive 002's invalidation schedule for free — see party-report.md
- **[NOTE]** (party-visionary) Rebuttal of party-po: deferring blur-in/counter/draw-on is not "consistent with the grows-automatically claim", because those presets are not registry additions — see party-report.md

---

**To proceed:** Review this proposal and approve to begin planning.
