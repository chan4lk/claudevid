### [BLOCK] party-security — Preset catalogue is exported as untrusted content directly into the director prompt
**Quotes:**
> New preset = a new entry in the registry. No core schema change, no renderer branch, and the
> catalogue is exported as documentation that change 007 injects into Claude's director prompt —
> so the model's expressive range grows automatically as the registry grows.

**Problem:** Registry entries — names, descriptions, and any prose in a preset bundle — are concatenated into a model prompt with no stated escaping, delimiting, or allow-listing. Any preset added by a third-party package, a user config, or a generated file becomes prompt text in a trusted position: it can instruct the director to emit arbitrary spec content, including `allowRawTracks` usage or channels the operator disabled. No seat's round-1 finding removes this entry point; party-visionary's independent reading of the same line ("the catalogue is exported as documentation that change 007 injects into Claude's director prompt") treats the registry as an unversioned persisted grammar, which concedes rather than rebuts that registry content flows unreviewed into the prompt. Nothing on the page constrains the catalogue to a first-party, in-repo, reviewed source.
**Fix:** State that catalogue export emits only structured fields (preset name plus typed track data) rendered by a fixed template, never free-form registry prose; restrict prompt injection to the first-party shipped registry, and require any externally-registered preset to be excluded from the prompt unless explicitly allow-listed by the operator.
**Status:** upheld

### [BLOCK] party-security — Cost and over-length "diagnostics" have no stated severity, so the design fails open by default
**Quotes:**
> The cost class is not decoration — the compiler **emits a diagnostic** when a spec animates an
> invalidating channel over a long window, telling the author (or Claude) the cheap equivalent
> ("animate `scale` instead of `fontSize`"). This is the mechanism that keeps generated videos fast
> by construction rather than by luck.
> A 2s enter animation on
> a 1.2s layer is a **diagnostic**, not a silent truncation — otherwise Claude generates it, nobody
> notices, and the video ships with a title that never finishes appearing.

**Problem:** "Emits a diagnostic" is never bound to an outcome. A diagnostic that does not fail the build, and is not recorded in a machine-readable artifact, is a warning printed into a log nobody reads during an unattended generation run — the exact failure the second quote says it is preventing. The render still completes and still returns a green result, so a 4 fps spec and a truncated title are indistinguishable from a healthy run at the only place an operator looks: the exit status and the output file. Two other seats independently reached the ambiguity from their own lenses — party-ba on the term carrying "two contradictory readings (advisory warning vs. hard failure)" and party-architect on the owning layer being unchosen — which confirms the disposition is genuinely absent from the page rather than implied by it. Neither of their fixes closes the fail-open path: naming the layer and defining the term still permits "advisory, logged, run continues green" as the answer.
**Fix:** Assign each diagnostic class a stated disposition: cost diagnostics and clamped-animation diagnostics must be non-zero-exit errors in non-interactive/CI mode (overridable only by an explicit operator flag), and in all modes must be written to a persisted diagnostics record emitted alongside the video so a degraded run is distinguishable after the fact.

**Status:** upheld

### [BLOCK] party-security — `allowRawTracks` is an escape hatch with no stated holder; if the spec can set it, the reviewed party controls its own gate
**Quotes:**
> (c) presets by default, raw tracks behind an opt-in `allowRawTracks` flag. **Recommendation: (c)** — the cost diagnostics exist precisely so
> (b) fails loudly, but the default should be the safe surface.

**Problem:** The proposal never says where `allowRawTracks` lives. If it is a field the spec carries — and a spec is the artifact Claude authors — then the model that the flag exists to constrain can set the flag and grant itself the unconstrained surface, with no operator in the loop. The safety argument leans entirely on "the cost diagnostics exist precisely so (b) fails loudly", and party-ba's round-1 finding independently shows that the "50× slower" figure this recommendation rests on is itself unsourced, while my finding above shows nothing on the page makes a diagnostic loud enough to stop a run. Both legs of the fallback control are therefore absent, and no seat has identified an operator-side holder for the flag anywhere in the artifact.
**Fix:** State that `allowRawTracks` is an operator-supplied render/compile option (CLI flag or host config) and is explicitly rejected if present anywhere in the spec document; a spec containing raw tracks without the operator option must be a hard schema rejection, not a downgrade to presets.

**Status:** upheld

### [WARN] party-security — Spring solver and repeat/loop are unbounded compile-time work with no stated limits
**Quotes:**
> Springs are solved and **baked to a fixed frame count at compile time**, so evaluation stays a
> pure lookup and the timeline's duration is knowable in advance (a spring that settles on its own
> schedule cannot be composed into a fixed-length scene).
> repeat?: number | "loop"; direction?: "normal" | "alternate"

**Problem:** `spring({ stiffness, damping, mass, velocity })` accepts author-supplied numbers with no stated valid ranges. A near-zero `damping` or `mass`, or a negative value, produces a spring that never settles — so "baked to a fixed frame count" either loops until a settle threshold that never arrives (unbounded compile time and memory for the baked table) or silently truncates the motion. `repeat: number` is likewise unbounded, and the spec is model-authored, so these values arrive from a generator that has no cost intuition. Two seats attacked the same sentence from other angles in round 1 — party-architect on which component performs the bake and where fps enters, party-visionary on frame-count-versus-seconds coupling — and both fixes are compatible with mine and neither supplies a bound. The proposal names no valid range and no behaviour on a degenerate solve.
**Fix:** Schema-bound `stiffness`/`damping`/`mass`/`velocity` to positive finite ranges and `repeat` to a maximum count; cap the bake at a hard maximum frame count and make hitting the cap a rejection with a diagnostic, never a silent truncation of the curve.

**Status:** upheld

### [WARN] party-security — Shared-element matching is control flow driven by model-authored ids with no stated collision behaviour
**Quotes:**
> - **`shared-element`** — layers in adjacent scenes carrying the same `id` are matched and
> their position/scale/colour interpolated across the boundary.
> **Shared-element transitions need stable ids across scenes.** Should core's schema *require*
> unique layer ids, or should matching be opt-in via an explicit `sharedId`?

**Problem:** Matching is a control-flow decision made from a model-authored string field, and the proposal's own open question concedes uniqueness is not currently guaranteed. The behaviour when two layers in the same scene share an id, when an id matches by accident across unrelated scenes, or when a match is found but the two layers have incompatible types is unspecified — leaving an ambiguous match to resolve as first-wins or last-wins silently. Party-po's round-1 NOTE on the same lines argues shared-element is a separable slice; deferring it does not change the failure mode when it does ship, and party-architect's `random`-seed finding establishes the same pattern the panel already accepts — an underspecified nondeterminism inside the pure evaluator. The visible result here is a wrong-element morph in the shipped video with nothing in the run to indicate a match was ambiguous.
**Fix:** Require ids used for shared-element matching to be unique within a scene, and specify that an ambiguous or type-incompatible match degrades to `cut` **and** emits a recorded diagnostic rather than picking a candidate silently.

**Status:** upheld

### [NOTE] party-security — `motion-preview` writes files with no stated output-path constraint
**Quotes:**
> - `tools/motion-preview` — frame contact-sheet dumper
> A dumper that renders N evenly-spaced frames of a scene to a single PNG grid.

**Problem:** The dumper's only stated effect is writing a PNG, and neither the destination path nor `N` is constrained on the page. If the output path is derived from spec content (scene name, layer id) it is model-authored text reaching a filesystem path, and an overwrite of an existing file is an irreversible effect with no stated recovery. `N` is unbounded, so a large value is unbounded render work and disk. Party-architect's round-1 finding on the same tool argues it lacks a stub seam and acquires a renderer dependency; that neither establishes nor removes a path constraint, so the exposure remains undemonstrable from the text as written. Filed at NOTE for that reason.
**Fix:** State that the contact-sheet path is operator-supplied or a fixed derived slug (sanitised, no separators or traversal), that the tool refuses to overwrite an existing file without an explicit flag, and that `N` has a documented upper bound.

**Status:** upheld

### [NOTE] party-security — Rebuttal: party-architect's alternative fix, an open `string` validated against the registry, converts a fail-closed check into a fail-open one
**Quotes:**
> New preset = a new entry in the registry. No core schema change, no renderer branch, and the
> catalogue is exported as documentation that change 007 injects into Claude's director prompt —
> so the model's expressive range grows automatically as the registry grows.

**Problem:** Party-architect's first BLOCK is correct that two resolvers for `"fade-up"` will diverge, and I do not contest it. But its second offered remedy — making the preset name an open `string` validated against the registry — matters to my lens, because a closed enum in core's schema is currently the only fail-closed check on the page: an unknown preset name is rejected before anything resolves it. Combined with my first finding, if the registry is also the thing whose entries reach the director prompt and can be extended by a third-party package or generated file, then validating "against the registry" means the set of accepted names is defined by the same mutable surface that teaches the model what to emit — a check whose authority and whose subject are the same object, which is not a check. Whichever divergence remedy is chosen, the resolution must not be the one that widens the accepted-name set to whatever happens to be registered at load time.
**Fix:** If the enum is opened, state that registry validation runs against the first-party shipped registry snapshot only, that an unknown or externally-registered preset name is a hard schema rejection rather than a pass-through, and that registration order cannot widen the accepted set at runtime.
**Status:** upheld
