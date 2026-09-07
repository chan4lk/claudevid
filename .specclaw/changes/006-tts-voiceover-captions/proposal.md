# Proposal: Local TTS Voiceover & Duration Feedback (Kokoro synthesis only)

**Created:** 2026-09-06
**Revised:** 2026-09-07 — split per party-po review; scope cut to the smaller, lower-risk half
**Status:** 🟡 Draft

**Depends on:** 001-videospec-core (`duration: "auto"`, `CompileTimelineOptions.audioDurations`,
`MissingAudioDurationError` — **already shipped**, see Grounding below).

**Followed by:** 008-forced-alignment-captions-audio-graph — whisper.cpp alignment, captions
layer, audio graph/mux, lexicon, SRT/VTT. Depends on this change for the synthesis+cache layer.

## Why this is split from the original 006 proposal

The original 006 proposal bundled two independent value propositions into one large,
dual-native-runtime change:

1. **Scene durations are guesses** — fixed by measuring synthesized narration length. Needs
   only Kokoro TTS. No alignment involved.
2. **Captions / speech-synced motion / SRT-VTT** — needs whisper.cpp forced alignment on top
   of (1).

Adversarial panel review (`party-report.md` in this folder, round 2, verdict `CHANGES_REQUESTED`,
9 BLOCK / 16 WARN / 6 NOTE, 0 withdrawn) flagged this bundling directly:

> (party-po) "Duration-fix and caption/motion-sync value are bundled into one large,
> dual-native-runtime change with no staged variant considered... Name the split explicitly:
> Kokoro-synthesis + duration-feedback as a smaller first cut; forced-alignment + captions +
> motion-sync + audio-graph as a follow-on that reuses the cache."

This proposal is that first cut. It ships one native runtime (onnxruntime-node via `kokoro-js`),
no filter-graph construction, no captions layer, no cross-package layer ownership question.

## Problem

> ### Phase 5: Audio
> `ffmpeg -i video.mp4 -i voiceover.mp3 -c:v copy -c:a aac -shortest final.mp4`

Scene durations in the requirements doc are author-guessed (`duration: 4`), and a Claude-authored
narration script actually takes however long the synthesized voice takes to say it. On a 30-scene
video, the mismatch means cuts land mid-sentence in some fraction of scenes and there is no
practical way to hand-fix it at scale. **Editing one sentence must re-synthesize one sentence,
not the whole project** — otherwise iteration cost grows with project size and the tool is
unusable for anything beyond a handful of scenes.

## Proposed Solution

**1. Local synthesis with Kokoro.**
`kokoro-js` on `onnxruntime-node` (CoreML/Metal execution provider on Apple Silicon where
available, CPU fallback elsewhere). Fully offline (no API key, no rate limit, no per-render
cost), MIT-licensed. Voice and speed are exposed at the spec level only in this increment (see
Scope cuts below).

**2. Structured narration in the schema, not a bare string.**
`scene.narration` is `{ text: string; voice?: string; speed?: number }` or an array of that shape
(an array when a scene needs sentence-level cache granularity) — never a bare string. This
directly resolves a party-visionary WARN:

> "Narration as a bare string... closes the schema door the out-of-scope item [multi-speaker]
> would need... a bare string has no room for [voice/speed knobs]... the migration also
> invalidates every cached block."

A bare string is accepted as shorthand and normalized to `{ text }` — one narration item, one
cache entry, one synthesis unit. This also resolves party-ba's granularity NOTE ("block" meaning
scene vs. sentence): the unit is explicit and structural, not a documentation convention.

**3. One content-addressed cache, keyed on the full resolved synthesis request.**
Correction to the original proposal: **change 005 (`encoder-ffmpeg`) ships no chunk-resume cache**
— its own party review cut that (see `.specclaw/changes/005-videotoolbox-encoder/design.md`
Grounding sources: *"chunk cache-key gap → moot, no `cache.ts` in v1"*). The claim that this
cache "mirrors change 005's chunk resume" was wrong; there is nothing to duplicate. This is the
project's first content-hash cache, at `.claudevid/cache/tts/` (project-relative, resolved via a
single root-resolution helper shared with the model-cache path below — one function, two
callers, so both agree on where project caches live).

Per party-security and party-visionary (independent convergence, both upheld):

> "Key on the full resolved synthesis request object... including a digest of the applied
> lexicon entries and the model file digest... write cache entries atomically (temp file plus
> rename), store length/digest alongside so a partial entry is a miss rather than replayed
> audio."

The key is a hash of the fully-resolved request object — `{ text, voice, speed, modelId,
modelDigest }` in this increment — not a hand-maintained field list. A field added later (pitch,
lexicon digest in 008) is added to the request type and the key changes automatically; no cache
code changes. Cache writes are atomic (temp file + rename); a partial write from an interrupted
run is a miss, never replayed audio.

**4. Duration feedback into the timeline — using an already-shipped core seam.**
Grounding: `packages/core/src/timeline.ts` already implements `CompileTimelineOptions.audioDurations`,
`MissingAudioDurationError`, and `duration: "auto"` handling — this landed with change 001 and
needs **no core-side code change**. `resolveSceneDurationSeconds` throws
`MissingAudioDurationError(sceneId)` when an `"auto"` scene has no matching entry — i.e. core
**already fails closed** on the absent-map case the original proposal's Open Questions left
unresolved, and does *not* silently substitute a words-per-minute estimate. This resolves the
BLOCK about an unnamed `compileTimeline` co-change (there is none — it shipped already) and the
WARN about an unmarked fail-open estimate (there is no estimate path to guard).

This package's job is narrow: measure each synthesized narration block's duration (plus
configurable head/tail padding and a **minimum and maximum** duration bound — the original
proposal named only a minimum) and produce the `Record<string, number>` that `compileTimeline`
already accepts as `opts.audioDurations`.

**5. Model pinning.**
The Kokoro ONNX model is pinned to an explicit URL and digest committed in this package (not
"download with an integrity check" against a self-served hash). Verified on every load from
cache; fails closed on mismatch rather than re-downloading. Network access happens only during an
explicit `claudevid models install` step — never implicitly during a render. Resolves
party-security's root-of-trust WARN and party-visionary's reproducibility WARN (a project's
rendered output cannot silently shift because the library's bundled model version changed on a
contributor's machine — the model id is recorded as a fact of the render, and a mismatch on
re-render is a warning, not a silent re-time).

## Scope

### In Scope

- `packages/audio/src/types.ts` — `NarrationBlock`, `SynthesisRequest` (the full resolved
  object the cache keys on), `AudioDurations` (alias for core's `Record<string, number>`)
- `packages/audio/src/tts.ts` — Kokoro synthesis, ONNX session lifecycle, injectable
  synthesis interface (`synthesize(request): Promise<{ audio: Buffer; sampleRate: number }>`)
  so cache/duration logic has a fixture seam and does not require the real model in tests —
  resolves party-architect's WARN on no deterministic test seam, scoped to what this increment
  needs
- `packages/audio/src/cache.ts` — content-hash cache over the full `SynthesisRequest`, atomic
  writes, stores `{ audio, durationSeconds }` together (per party-visionary NOTE: cache the
  measurement alongside the audio, not just the audio)
- `packages/audio/src/durations.ts` — measures cached/fresh audio, applies configurable
  head/tail padding and **min + max** duration bounds, produces the `AudioDurations` map;
  exceeding the max errors and names the scene rather than clamping silently
- `packages/audio/src/models.ts` — pinned model URL + digest, `claudevid models install`,
  verify-on-load
- Schema addition to `packages/core`: `scene.narration` structured type (`{ text, voice?,
  speed? }` or array), bare-string shorthand normalized to it — **this is a core-side change
  named explicitly**, unlike the original proposal's silent core coupling
- Tests: cache-hit behaviour on single-sentence edit (via the `synthesize()` fixture seam, no
  real model needed), duration-bounds test (min/max, both directions), atomic-write-under-
  interruption test, one integration-tier test gated separately that runs real Kokoro synthesis
  end-to-end

### Out of Scope (this increment — see 008)

- Forced alignment / word-level timings, whisper.cpp
- Captions layer (schema, layout, rendering, animation)
- Speech-synced motion
- Audio graph (gain/fades/ducking/loudnorm), mux into 005's output
- SRT/VTT export
- Pronunciation lexicon
- Per-scene voice/speed override (spec-level only in this increment — the original proposal's
  per-scene knob had no named scenario requiring it; add it in 008 if a concrete scene need
  appears)
- Cloud TTS providers, voice cloning, multi-speaker dialogue, music generation, real-time/
  streaming synthesis

## Impact

- **Files affected:** ~8 new (down from ~20; captions/graph/mux/align/lexicon/export moved to 008)
- **Complexity:** medium (down from large)
- **Risk:** medium — one native ML runtime (onnxruntime-node), model download with pinned
  digest, Apple Silicon build variance. No filter-graph construction, no second untrusted-model
  validation problem, no cross-package layer question in this increment.

## Open Questions

- **Per-block wall-clock cost.** party-po (upheld): no seconds-per-block estimate given for
  synthesis on target hardware, cache-cold vs. cache-warm, at representative project scale. This
  must be measured during design/build (design.md should include an indicative bench, the same
  way change 005's design.md ran an indicative smoke bench before committing to numeric targets)
  rather than asserted here.
- **Licensing.** Kokoro's model weights and voice packs need a licence review before this ships
  in a public package (carried over from the original proposal, still open).
- **Narration schema exact shape.** `{ text, voice?, speed? }` vs. requiring an explicit array
  always (no bare-string shorthand) — deciding this in spec.md/design.md, not here, since it's
  now scoped narrowly enough to resolve without blocking on 008's needs.

### Panel findings addressed by this revision (from `party-report.md`, round 2)

Resolved by scope cut / schema change / correction of a false claim, not carried forward as open
items: the captions-placement BLOCK, the second-cache BLOCK (claim was false — no 005 cache
exists to duplicate), the `compileTimeline` co-change BLOCK (already shipped in 001, verified
against `packages/core/src/timeline.ts`), the forced-alignment-accuracy BLOCK and the matching
party-ba BLOCK (alignment moved entirely to 008), the FFmpeg-filter-graph-injection BLOCK (no
filter graph in this increment), the untrusted-aligner-output BLOCK and the fail-open-fallback
BLOCK (no aligner in this increment), the cache-key-omits-lexicon BLOCK (no lexicon in this
increment; key is now the full resolved request object so this class of bug can't recur when 008
adds fields), the bundling WARN (this split *is* the fix), the config-surface WARN (per-scene
voice/speed/pitch and four caption styles cut — captions aren't in this increment at all, and
per-scene override is cut pending a named scenario), the duration-ceiling WARN (max bound added),
the mux-destination WARN (no mux in this increment), the model-root-of-trust WARN (pinned digest
+ explicit install step), the circular-drift-test WARN (no aligner, no drift claim, in this
increment), the fail-open-estimate WARN (moot — core's existing behaviour is already fail-closed,
see item 4 above), the cache-key-enumeration WARN (key is the full request object, not a field
list), the model-reproducibility WARN (pinned + recorded model id), the narration-schema WARN
(structured type from day one), the cache-should-store-timings-too NOTE (duration stored
alongside audio now; timings will join in 008 without a key-scheme migration since the key
already covers the full request).

Carried forward to 008 (not applicable to this increment's scope): word-timings-artifact WARN,
FFmpeg-invoked-from-two-packages NOTE, per-word-provenance WARN, captions-teach-precedent NOTE.

Still open, unresolved by scope alone: the per-block wall-clock cost WARN (needs measurement, see
Open Questions above), licensing (unchanged from original proposal).

---

**To proceed:** Review this proposal and approve to begin planning.
