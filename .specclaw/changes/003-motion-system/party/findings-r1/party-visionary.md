### [WARN] party-visionary — The cost-class table is a hand-copied fact about 002's renderer, kept in sync by nobody
**Quotes:** > Every layer property becomes a typed animatable channel with a declared cost class:
> | `color`, `background` | colour | **invalidating** | re-raster |
> - `packages/motion/src/properties.ts` — animatable channel registry + cost classes
**Problem:** Whether `color` is free or invalidating is a property of how 002 paints, but it is declared in `packages/motion/src/properties.ts` and enforced by motion's diagnostic. The next change in 002 that tints cached glyph bitmaps with a composite operation (making `color` a free channel), or that adds a GPU path where `fontSize` is a transform, must also edit motion's table — and nothing fails if it doesn't. The drift is silent: the diagnostic keeps steering Claude (via 007's injected catalogue) away from a channel that is now cheap, and the only symptom is that generated videos never animate colour. Nobody notices until someone asks why.
**Fix:** Make 002 the authority — have it export a cost class per mechanism that `properties.ts` imports — or state in the artifact which side is authoritative and add a contract test that fails when the two disagree.
**Status:** upheld

### [WARN] party-visionary — Preset names and their numbers become a persisted, prompt-taught grammar with no version
**Quotes:** > "fade-up": [
>   { property: "opacity", from: 0, to: 1, easing: "out-cubic" },
>   { property: "y",       from: 48, to: 0, easing: "out-cubic" },
> ]
> New preset = a new entry in the registry. No core schema change, no renderer branch, and the
> catalogue is exported as documentation that change 007 injects into Claude's director prompt
**Problem:** The artifact argues only the additive case: a new preset is one registry entry. It does not address edit or removal. Once specs referencing `"fade-up"` are stored and 007 has taught Claude the catalogue, changing `from: 48` to `from: 32` silently re-renders every existing spec differently and breaks every contact-sheet hash; deleting a preset invalidates stored specs at Zod time. The registry is presented as cheap-to-grow data, but every entry becomes a frozen contract the moment a spec is saved, and nothing in the design carries a version to let old and new coexist.
**Fix:** State that released preset definitions are immutable (a changed look is a new name), or give registry entries a version that specs pin, so a later change to a preset is an addition rather than a rewrite of history.
**Status:** upheld

### [WARN] party-visionary — Baking springs to a frame count couples timeline duration to render fps
**Quotes:** > Springs are solved and **baked to a fixed frame count at compile time**, so evaluation stays a
> pure lookup and the timeline's duration is knowable in advance
> A dumper that renders N evenly-spaced frames of a scene to a single PNG grid. Reviewing motion
> should not require a 20-minute encode; this makes iterating on feel a 2-second loop
**Problem:** A spring baked to a frame count settles in a different number of seconds at 15 fps than at 60 fps. The first change that renders one spec at two rates — the `motion-preview` loop at a low rate for speed, then the final encode — either gets a preview whose timing lies about the final, or re-bakes per fps, in which case the "knowable in advance" duration is a function of fps and 005's chunk boundaries and 006's audio alignment inherit that dependency. The open question about live vs baked springs discusses interruptibility, not this.
**Fix:** Bake to a time duration in seconds (sampled at evaluation fps), or declare a canonical fps that defines duration and have all other rates resample from it, and say so in the artifact.
**Status:** upheld

### [WARN] party-visionary — Transitions are shipped as a closed named list, the exact shape the Problem section condemns for presets
**Quotes:** > New preset = a new entry in the registry. No core schema change, no renderer branch
> - `cut` (default), `cross-fade`, `dip-to-colour`
> - `push` / `slide` (4 directions), `wipe` (4 directions + radial)
> - `packages/motion/src/transitions.ts` — transition definitions incl. shared-element matching
**Problem:** Presets are made data precisely so that a new look does not need a schema enum member plus a renderer branch plus a prompt change. Transitions get no such statement: they are enumerated by name, `shared-element` has bespoke matching logic, and 002 is told to compose them "as an operator over two scene buffers". The contributor who adds a `zoom-through` transition one year on finds an enum in `schema.ts`, a branch in `transitions.ts`, a new operator in 002, and a manual edit to 007's prompt — the four-place change item 2 of the Problem section calls "precisely the design that stops libraries growing".
**Fix:** Either declare transitions as registry entries built from the same track/channel model applied to two scene buffers (with `shared-element` as the one primitive that needs matching), or acknowledge in the artifact that transitions are intentionally a closed set and say why.
**Status:** upheld

### [WARN] party-visionary — The shipped preset families already break the "preset is a bundle of tracks" rule, so that is the precedent that will be copied
**Quotes:** > A preset is *data*: a named bundle of tracks.
> Preset families shipped: fades, slides (4 directions), scale/pop, blur-in (pre-rendered), clip
> wipes (4 directions), typewriter, counter (animated numbers), draw-on (path length), and
> attention beats (pulse, shake, wiggle).
**Problem:** `blur-in (pre-rendered)` needs a pre-render path in 002; `draw-on (path length)` needs a path-length channel; `counter` needs a formatted-number channel. None of those channels appear in the cost-class table, so the first release of the registry contains presets that require a new channel plus renderer support to exist. What a contributor learns from reading `presets.ts` is therefore "a preset may pull in a renderer mechanism", and the next one — `glow-in`, `blur-out`, `morph` — does the same, and the "no renderer branch" property is gone without anyone deciding to give it up.
**Fix:** Add `blur`, `pathLength`, and `counterValue` to the channel table with cost classes so those presets really are pure track bundles, or put them in a separately named tier in the registry ("requires renderer capability X") so the exception is visible rather than inferred.
**Status:** upheld

### [WARN] party-visionary — Transition duration semantics is framed as a pipeline trade-off; it is a one-way contract on every video's length
**Quotes:** > Do transitions overlap scene durations or extend the timeline? A 0.5s cross-fade between
> two 3s scenes yields either 5.5s (overlapping) or 6.5s (inserted). Overlapping is correct for
> video but complicates change 005's chunk-boundary splitting
**Problem:** The question is posed as a cost to 005's chunking. What it actually decides is the total duration of every spec that has a transition, and therefore the timestamp of every narration cue in 006 and every caption. Once specs and audio are produced under one rule, flipping to the other shortens or lengthens every existing video and desynchronises its audio; there is no later change that can reverse it without re-authoring. The artifact lists it as open but does not mark it as the door it is.
**Fix:** Decide it in this change, record it as irreversible, and make the chosen semantics an explicit persisted field on the transition rather than an implicit rule, so a later alternative can coexist with old specs instead of replacing them.
**Status:** upheld

### [NOTE] party-visionary — Presets hardcode pixel magnitudes; one step from parameterised presets before the static shape is pinned
**Quotes:** >   { property: "y",       from: 48, to: 0, easing: "out-cubic" },
> (a) named presets + a few
>   numeric params only — most reliable, least expressive
**Problem:** The recommended default surface is presets, and the recommended option (a) mentions "a few numeric params", but the registry entry shape shown is a static array with `48` baked in. The next change that makes `fade-up` resolution-aware (48px reads differently at 4K), or lets Claude say "fade-up, distance 24", has to change every registry entry from a static array to a template after specs and 007's prompt have pinned the static form. Defining entries as `(params) => Track[]` with defaults costs nothing now and is the seam that makes option (a) actually expressive.
**Fix:** Define preset entries as parameterised templates with defaults from the start, and let the catalogue export list the parameters.
**Status:** upheld

### [NOTE] party-visionary — Cost classes stop at a warning; the same data could drive 002's invalidation schedule for free
**Quotes:** > The cost class is not decoration — the compiler **emits a diagnostic** when a spec animates an
> invalidating channel over a long window
> Build `@claudevid/motion` — a **pure, declarative, time → property-bag evaluation engine**.
**Problem:** With a pure evaluator and declared cost classes, the compiler already knows for each layer the exact frames on which an invalidating channel changes value. Emitting that as an invalidation interval list would let 002 re-raster only on those frames — a 1s colour change in a 10s layer costs 30 re-rasters, not 300 — and would make the "long window" diagnostic a measured number rather than a heuristic. The artifact builds all the inputs and stops at telling the author to avoid the channel.
**Fix:** State that the diagnostics pass also emits per-layer invalidation intervals consumed by 002's raster cache, or record why that is deferred.
**Status:** upheld
