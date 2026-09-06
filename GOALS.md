# claudevid — Implementation Goals

A Claude-native TypeScript library for generating fast, high-quality tech explainer videos
on Apple Silicon. Claude directs; the library renders and encodes.

Source requirement: `docs/Qwen_markdown_20260906_vsjxybyq8.md`
Proposals: `.specclaw/changes/<NNN>-<slug>/proposal.md`

**Build order is dependency order.** 001 first — everything imports it.

```
001 core ──┬─→ 002 renderer ──┬─→ 003 motion ──→ 004 code layer
           │                  │
           └─→ 005 encoder ←──┘
                    │
           006 audio/TTS ──→ 007 CLI + Claude skill
```

---

## Decide these two before starting — they recur across proposals

- [ ] **Does `duration: "auto"` land in core v1?** (affects 001 + 006)
      Recommendation: yes, via an optional `AudioDurations` argument to `compileTimeline`, so
      core stays I/O-free and 006 does not force a schema break. Panel adds a guard: an absent
      map must not silently produce estimated timings — require an explicit estimate mode.
- [ ] **How much motion vocabulary does Claude get?** (affects 003 + 007)
      Options: named presets only · presets + raw keyframe tracks · presets by default with an
      **operator-held** `allowRawTracks` opt-in. Panel: the flag must not be a spec field, or the
      model that it constrains can set it itself.

---

## 001 — VideoSpec Schema, Timeline Compiler & Core Contract

`.specclaw/changes/001-videospec-core/proposal.md` · medium / low risk · ~18 files
**Depends on:** nothing.

- [ ] Monorepo scaffolding (pnpm workspace, tsconfig base, tsup, vitest, `packages/*`)
- [ ] `schema.ts` — Zod VideoSpec v1 as the single source of truth
- [ ] `types.ts` — types inferred from Zod (validator and types can never disagree)
- [ ] `layers.ts` — `text` / `rect` / `image` / `group` + `registerLayer()` hook for 004/006
- [ ] `timeline.ts` — `compileTimeline`, integer-frame snapping, absolute layer intervals, `activeAt`
- [ ] `resolve.ts` — coordinate + style resolution (`"center"`, inherited background, safe areas)
- [ ] `easing.ts` — standard eases + `cubicBezier` + `steps`
- [ ] `diagnostics.ts` — JSON-pointer diagnostics with repair suggestions (feeds 007's repair loop)
- [ ] `json-schema.ts` — JSON Schema generated from the Zod definition, for Claude structured output
- [ ] Golden tests: fractional durations, zero-length scenes, non-dividing fps, 30-min timelines

**Done when:** a spec round-trips through `parseSpec` → `compileTimeline` and the frame windows
are asserted exactly; the generated JSON Schema is emitted and committed.

---

## 002 — Canvas Render Engine (@napi-rs/canvas) with Raster Caching

`.specclaw/changes/002-canvas-render-engine/proposal.md` · large / med-high risk · ~22 files
**Depends on:** 001.

- [ ] `frame-buffer.ts` — buffer pool, raw-pixel extraction (**not** `getImageData`)
- [ ] **Verify byte order empirically** — RGBA vs BGRA, premultiplied vs straight, matched to
      FFmpeg's `-pix_fmt`, via a known-colour round-trip test
- [ ] `raster-cache.ts` — content-hash keying, LRU, memory ceiling
- [ ] `text.ts` — measure → wrap → position → raster → cache (never re-layout per frame)
- [ ] `fonts.ts` — bundled Inter + JetBrains Mono, documented fallback chain (reproducible output)
- [ ] `draw-shapes.ts` — rect, rounded rect, borders, gradients, arrows
- [ ] `draw-image.ts` — decode cache, cover/contain/fill
- [ ] Scene culling + hold-frame reuse (unchanged frame → reuse previous buffer)
- [ ] Resolution scaling so 720p preview is the same composition, not a second code path
- [ ] `stats.ts` — ms/frame p50/p95, cache hit rate, allocation count
- [ ] Determinism test: same spec → byte-identical frame hashes
- [ ] Perf test in CI: representative 1080p scene under a ms/frame ceiling

**Done when:** a representative 1080p scene renders inside the 10–20 ms/frame budget and
`RenderStats` proves it. Committed backend is @napi-rs/canvas — no `Surface` port layer.

---

## 003 — Motion System (the motion graphics library proper)

`.specclaw/changes/003-motion-system/proposal.md` · large / medium risk · ~28 files
**Depends on:** 001, 002. **Panel: CHANGES_REQUESTED — 8 BLOCK, 21 WARN, 8 NOTE**
See `.specclaw/changes/003-motion-system/party-report.md`.

### Resolve before building (BLOCK findings)
- [ ] **Retire the old preset enum.** Deleting `AnimationPreset` from core's schema, removing
      `getEnterOpacity` and the renderer's preset branches are co-changes in the same commit —
      or the enum becomes an open string validated against a first-party registry snapshot.
      Two resolvers for `"fade-up"` will diverge the moment a registry entry is tuned.
- [ ] **Fix the dependency cycle.** motion cannot import core's `Timeline` while core imports
      motion's Zod fragment. Name the edge direction and the mechanism (extension point in core,
      or a third package that composes both), and which `package.json` gains which dependency.
- [ ] **Name the spring baker.** Baking to a frame count needs an fps that
      `evaluate(tracks, localTime)` does not carry. Say which component bakes, what it takes,
      and how the baked curve reaches `evaluate` without destroying its purity.
      Consider baking to *seconds* instead, so a 720p preview doesn't lie about final timing.
- [ ] **Seed the stagger.** `from: "random"` unseeded is not pure — it breaks golden tests and
      reshuffles at chunk boundaries under 005's parallel render. Derive the permutation from
      the group's `layerKey`s, or require a `seed`.
- [ ] **Bind diagnostics to an outcome.** Decide whether a cost/clamp diagnostic blocks or is
      advisory, which component owns it (`compileTimeline` vs render start — that choice decides
      whether a CI-failing diagnostic is even reachable), and state the "long window" threshold
      as a number. Write them to a persisted record alongside the video either way.
- [ ] **Decide transition timing semantics — it is a one-way door.** Overlapping (5.5 s) vs
      inserted (6.5 s) changes the duration of every spec with a transition, every narration
      cue in 006, and 005's ability to cut at scene edges. Record it as a persisted per-transition
      field so an alternative can coexist with old specs later.

### Build
- [ ] `properties.ts` — animatable channel registry with **cost classes** (free vs invalidating)
      · make 002 the authority for the cost of each mechanism, with a contract test
- [ ] `track.ts` — `Track`, pure `evaluate`, clamping, repeat/direction
      · state the default and precedence for every optional field (`from/to` vs `keyframes`,
        track easing vs keyframe easing, omitted `duration`, two tracks on one property)
- [ ] Define `PropertyBag` concretely — composed matrix vs raw scalars, and where the rotation
      origin comes from. It is the one type motion and 002 must agree on.
- [ ] `interpolate/` — number, **OKLCH** colour, transform matrix, discrete (typewriter/steps)
- [ ] `easing.ts` — spring solver + baking, with schema-bounded stiffness/damping/mass/velocity
      and a hard cap on baked frames (reject on cap, never silently truncate)
- [ ] `presets.ts` — presets as **data**, defined as parameterised templates with defaults
      (not static arrays with `48` baked in), plus a catalogue export for 007's prompt
      · restrict prompt injection to the first-party registry; emit structured fields only
      · released preset definitions immutable, or versioned so specs can pin
- [ ] `stagger.ts` — deterministic stagger over `group` children
- [ ] `transitions.ts` — cut, cross-fade, dip, push, slide, wipe · **`shared-element`** as its own
      slice, with unique-id requirement and ambiguous-match → `cut` + recorded diagnostic
      · state that transitions are a closed set of buffer operators co-owned with 002
- [ ] `tools/motion-preview` — frame contact-sheet dumper, bounded `N`, no-clobber output path
- [ ] Golden numeric tests per interpolator (keep motion's own suite purely numeric — contact-sheet
      hashing needs a canvas and drifts across machines)

### Scope decisions the panel raised
- [ ] Cut the day-one preset catalogue to fade/slide/scale + stagger? If so, **keep the channel
      table entries** (`blur`, `pathLength`, `counterValue`) here, or the deferred families are
      not "just a registry addition" later.
- [ ] Add acceptance criteria tied to the problem statement, not just interpolator tests.

---

## 004 — Animated Code Block Layer (Shiki, Line-Cached)

`.specclaw/changes/004-code-block-layer/proposal.md` · med-large / medium risk · ~16 files
**Depends on:** 001, 002, 003.

- [ ] `highlight.ts` — Shiki `createHighlighterCore` at **compile time**, lazy lang/theme loading,
      emitting a plain serializable `TokenizedCode` IR (must cross a worker boundary)
- [ ] `layout.ts` — monospace advance-width fast path, wrapping, fit-to-width
- [ ] `render.ts` — **per-line** raster cache (not per-block: typewriter mutates one line, so the
      hit rate goes 0% → (N-1)/N), chrome pre-rendered once
- [ ] `animations.ts` — typewriter (char/token/line), line reveal via stagger, focus + dim,
      diff, scroll, caret
- [ ] `annotate.ts` — line-anchored callouts
- [ ] `diagnostics.ts` — overflow names the line count and the fix; never render an overflowing block
- [ ] Bundled themes verified for contrast at video bitrates
- [ ] Tests: IR goldens per language, line-cache hit-rate assertion during typewriter

**Open:** Shiki bundling strategy (cold start matters for `preview` and batch) · diff input format
(unified diff vs before/after pair) · ligatures break the monospace fast path · whether an
ANSI/terminal layer folds in here or becomes change 008.

---

## 005 — FFmpeg VideoToolbox Encoder + Parallel Scene-Chunk Rendering

`.specclaw/changes/005-videotoolbox-encoder/proposal.md` · large / **high** risk · ~20 files
**Depends on:** 001, 002. **Panel: CHANGES_REQUESTED — 6 BLOCK, 8 WARN, 3 NOTE**
See `.specclaw/changes/005-videotoolbox-encoder/party-report.md`.

### Resolve before building (BLOCK findings)
- [ ] **Bench the single-pipe path first.** `chunk/pool/concat/cache` — half the change, and the
      highest-risk half — is priced only against the <5 min aggressive target. Measure the
      corrected single-pipe encoder against the primary <15 min target before building it.
      If the scope is gated, say explicitly that chunk-level resume (problem #5) and the bench's
      `cache hit rate` metric go with it.
- [ ] **One owner for the argv.** Flags are currently specified across `profiles.ts`, `pipe.ts`
      and `chunk.ts`; no component sees the whole command line, and "byte-identical encoder
      parameters across chunks" is exactly the invariant that split cannot enforce.
- [ ] **Cache key must cover the encoder identity** — resolved argv + probed FFmpeg/encoder
      version. Otherwise a stale chunk from a different profile or FFmpeg build joins the concat
      and the seam is silently wrong.
- [ ] **Split `temp.ts` vs `cache.ts` ownership.** One is specified to delete chunk artifacts on
      success and failure; the other to keep them for resume. Name which paths each owns.
- [ ] **Frame geometry has one owner.** A raw-RGBA pipe carries no dimensions, and the profile
      table also declares them. Either geometry is the renderer's alone (profiles = codec/bitrate
      only), or profiles drive a scale filter — say which, and remove CLI flag names from error
      text if 007 wires the flags.
- [ ] **Probe must derive from the profile table.** VP9 is in the table and not in the probe, so
      the `web` profile fails at spawn with the raw error the probe exists to prevent. State the
      fallback per profile.

### Build
- [ ] `probe.ts` — capability detection with actionable errors (not exit code 1)
- [ ] `pipe.ts` — raw RGBA pipe, real backpressure, `-fps_mode passthrough`, bt709 tagging,
      `yuv420p`, `+faststart`, stderr parsed into typed progress events
- [ ] Progress event contract stated **once**, in timeline-global terms (007 is a separate consumer)
- [ ] `profiles.ts` — start with `preview` + `final`; defer `hevc`/`master`/`web`/vertical
- [ ] `chunk.ts` — transition-aware splitting, forced keyframe at chunk start, GOP alignment
- [ ] `pool.ts` — worker_threads pool sized to **performance** cores (not `os.cpus()`), cancellation
- [ ] `concat.ts` — concat list, lossless stream-copy join, seam verification
- [ ] `cache.ts` — content-addressed chunk resume
- [ ] `temp.ts` — deterministic temp dirs, cleanup on success and failure, no orphaned FFmpeg
- [ ] `tools/bench` — ms/frame, render fps, encode fps, wall clock vs the stated targets
- [ ] A process-spawn seam plus unit tests that run with **no FFmpeg present**: splitter
      boundaries, GOP arithmetic, argv construction, cache-key derivation, stderr parsing
- [ ] Integration tests (real FFmpeg): colour round-trip, concat seam frame-hash continuity,
      frame-count exactness, cancellation leaves no children — with a stated CI wall-clock budget
- [ ] Decide the quality gate: `h264_videotoolbox` rings around glyph edges, which is the worst
      case for code walkthroughs. Either an SSIM/PSNR floor on a text-heavy clip, a documented
      manual sign-off, or an explicit statement that quality is out of acceptance scope.

---

## 006 — Local TTS Voiceover, Forced-Aligned Captions & Audio Mux

`.specclaw/changes/006-tts-voiceover-captions/proposal.md` · large / med-high risk · ~20 files
**Depends on:** 001, 002, 003, 005. **Panel: CHANGES_REQUESTED — 9 BLOCK, 16 WARN, 6 NOTE**
See `.specclaw/changes/006-tts-voiceover-captions/party-report.md`.

### Resolve before building (BLOCK findings)
- [ ] **Name the token-reconciliation component.** whisper.cpp is an *open transcriber*, not a
      forced aligner — it emits its own token stream that may not match the reference transcript.
      Reconciliation (recognized → reference alignment) is a required component and is in neither
      the scope list nor the file list. State whether every reference word is guaranteed a timing.
- [ ] **Validate the aligner's output before it leaves `align.ts`.** Reference transcript match
      after normalization; timestamps monotonic, non-negative, non-overlapping, bounded by measured
      audio length. Fail the block loudly on violation.
- [ ] **The low-confidence fallback must not be invisible.** Proportional distribution emits the
      same shape as a real alignment, so a guessed block ships green and indistinguishable.
      Fail closed by default; if kept, make it opt-in with a per-word `estimated` flag carried
      through captions and SRT, plus a run artifact naming every affected block.
- [ ] **Key the cache on the full resolved synthesis request** (post-lexicon text, all voice
      params, model id + file digest) — not a named subset. The lexicon and pitch are both missing
      today, so the named workflow (fix `kubectl`, re-render) hits stale audio and appears broken.
      Write entries atomically; store length/digest so a truncated entry is a miss.
- [ ] **Enumerate the core-side co-changes.** `duration: "auto"` and the `AudioDurations` argument
      touch core's schema union, `compileTimeline`'s signature, every call site, and existing
      timeline tests. Impact currently counts only new files.
- [ ] **Move the captions layer out of `packages/audio`.** Schema belongs in core, layout/styles
      with the renderer, emphasis with 003 — audio's only output here is `{word,start,end}[]`.
      State the rule, so the named audio-reactive-motion follow-on inherits it.
- [ ] **Pin the models.** An integrity check against a hash from the same host detects corruption,
      not substitution. Pin URL + digest in-repo, verify on every load, fail closed. Resolve any
      whisper binary from a configured absolute path, never bare PATH. No implicit network fetch
      during an ordinary render — gate it behind `claudevid models install`.
- [ ] **Mux writes to a distinct path.** Never overwrite 005's expensive encode in place; temp
      file + rename on exit code 0 only; refuse to clobber without `--force`.
- [ ] **Specify the word-timing contract fully** before three consumers freeze it: block-relative
      vs absolute origin and who applies padding, whether `word` is always the reference surface
      form, how punctuation and lexicon substitutions appear. Reserve `confidence`/`source` and an
      optional phrase grouping now.

### Build
- [ ] `tts.ts` — Kokoro via `kokoro-js` on onnxruntime-node (CoreML/Metal on M3), behind a named
      `synthesize()` seam so cache/duration/graph/export tests run against fixtures
- [ ] `align.ts` — whisper.cpp forced alignment behind a named `align()` seam, with validation
- [ ] `cache.ts` — per-block entry holding `{ audio, timings, duration }` keyed once (otherwise
      alignment is re-paid for all 360 blocks on every edit)
- [ ] `lexicon.ts` — pronunciation overrides for technical terms
- [ ] `durations.ts` — `AudioDurations` feeding `compileTimeline`, with a **maximum** duration as
      well as a minimum, and no silent estimate when the map is absent
- [ ] `graph.ts` — FFmpeg audio graph: gain, fades, sidechain ducking, `loudnorm` −14 LUFS
      · media files as separate `-i` argv elements, referenced by index — **never** interpolated
        into the filtergraph string; numeric params range-validated and rejected, not clamped
- [ ] `mux.ts` — final mux (reuse 005's FFmpeg invocation helper, or say why not)
- [ ] `captions/` — styles, safe-area handling, word emphasis via 003 tracks
- [ ] `export.ts` — SRT / VTT sidecars
- [ ] Tests with **stated thresholds**: drift tolerance in ms measured against ground-truth
      boundaries (not against the aligner's own output), ducking reduction in dB, loudness target,
      single-sentence-edit cache behaviour
- [ ] Licence review of Kokoro weights and voice packs before publishing

### Scope decision the panel raised
- [ ] Ship as two increments? Kokoro + duration feedback first (no whisper.cpp at all), then
      alignment + captions + motion sync + audio graph. Quantify seconds-per-block for synthesis
      and alignment on an M3, cache-cold and cache-warm, either way.

---

## 007 — CLI, Claude Director Loop & Claude Code Skill

`.specclaw/changes/007-cli-claude-skill/proposal.md` · med-large / medium risk · ~24 files
**Depends on:** all of 001–006.

- [ ] `claudevid init` — scaffold project, brand kit, examples, `.claudevid/` cache
- [ ] `claudevid validate` — 001's JSON-pointer diagnostics, exit 1 on failure
- [ ] `claudevid preview` — 720p fast render, `--watch`, `--sheet` contact sheet from 003
- [ ] `claudevid render` — full pipeline: audio → timeline → parallel render → encode → mux
- [ ] `claudevid generate` — Claude → spec → validate → **bounded** repair loop → stop
      (does **not** render by default; `--render` opts in)
- [ ] `claudevid batch` — job queue, per-job artifacts, stated failure policy
- [ ] `claudevid bench` · `claudevid models install`
- [ ] Flags: `--width --height --fps --encoder --quality --format --vertical --out
      --preview --concurrency --no-cache --profile --scenes --chapter`
- [ ] `generate.ts` — JSON Schema as structured output; diagnostics fed back on failure; fail
      loudly with the last diagnostics. **Never silently repair a spec.**
- [ ] `chapters.ts` — outline → chapters → merge, scene-id namespacing + collision check,
      a style contract carried into every chapter request, running summary of prior chapters
- [ ] `claudevid.config.ts` — brand kit: palette, fonts, logo, lower-thirds, intro/outro, voice
- [ ] `prompts/video-director.md` — **assembled at build time** from 003's live preset catalogue
      and 004's capabilities (a hand-maintained prompt drifts within two releases)
- [ ] `.claude/skills/video-generator/` — SKILL.md, generated+committed schema, examples, scripts
- [ ] CI check that regenerates the committed JSON Schema and diffs it
- [ ] Smoke test: `init → generate → render` produces a playable file

**Open:** `ANTHROPIC_API_KEY` vs reusing an existing Claude Code session · default model id ·
repair attempt budget · brand kit format (TS config vs JSON).

---

## Not in any proposal (candidate follow-ons)

- [ ] ANSI / terminal output layer (`npm install`, test output, `git log`) — same machinery as 004
- [ ] Audio-reactive motion (waveform-driven animation) — cheap once 006's timings exist
- [ ] Charts and data-driven diagrams
- [ ] Path-following motion along arbitrary beziers
- [ ] Cloud TTS provider adapters (ElevenLabs / OpenAI / Cartesia)
- [ ] MCP server exposing the renderer as tools
- [ ] Remotion project export for scenes the canvas renderer can't reach
- [ ] Zero-copy VideoToolbox surface handoff (bypassing the raw pipe)
