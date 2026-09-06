### [WARN] party-po — Duration-fix and caption/motion-sync value are bundled into one large, dual-native-runtime change with no staged variant considered
**Quotes:**
> **4. Duration feedback into the timeline.**
> A scene carrying `narration` may declare `duration: "auto"`. The audio pipeline measures the
> synthesized block and supplies an `AudioDurations` map to change 001's `compileTimeline`
>
> **3. Word-level timings via forced alignment — the piece that unlocks everything.**
> Kokoro produces audio, not timings. We run **whisper.cpp** (Metal-accelerated on M3) over the
> *generated* audio to get word-level timestamps.
>
> **Risk:** medium-high — two native ML runtimes (onnxruntime-node, whisper.cpp) with model
> downloads and Apple Silicon build variance, plus a genuine cross-change coupling into 001's
> timeline compilation.
**Problem:** The proposal's own opening problem is "scene durations are guesses" — item 4 fixes that using only Kokoro's synthesized-audio length, no whisper.cpp involved. Whisper.cpp forced alignment is needed only for captions and motion-sync (items 5/6), a separate value proposition. The proposal ships both native ML runtimes, plus the full audio-graph/mux/export/lexicon stack, as one "large" / "medium-high risk" unit, and never names or prices the cheaper option of shipping duration-feedback (Kokoro + measurement only) first, deferring the whisper.cpp dependency to a second increment once the first is validated. Round-1 findings from party-architect (no test seam for the two-runtime stack) and party-security (fallback timings indistinguishable from measured ones) independently establish that the alignment half is the riskier, less-settled half of this change — reinforcing rather than undermining the case for splitting it from the duration-fix half.
**Fix:** Name the split explicitly: Kokoro-synthesis + duration-feedback as a smaller first cut; forced-alignment + captions + motion-sync + audio-graph as a follow-on that reuses the cache. State why (if there is a reason) they must land atomically instead.
**Status:** upheld

### [WARN] party-po — Per-render wall-clock cost of the pipeline is never quantified
**Quotes:**
> fast enough on M3 for real-time-plus synthesis
>
> We run **whisper.cpp** (Metal-accelerated on M3) over the *generated* audio to get word-level
> timestamps.
**Problem:** "Real-time-plus" and "Metal-accelerated" describe direction, not magnitude. This pipeline stage runs on every new/edited narration block for every render, on top of change 005's encode step, and the proposal's own example (30-minute video, 360 scenes) establishes the scale at which this cost compounds — but supplies no wall-clock estimate for synthesis+alignment at that scale, cached or cold. Without a number, the "iteration is ruinous... this is what makes the edit loop survivable" claim in scope item 2 can't be checked against the running cost it's meant to solve. Party-visionary's round-1 finding that alignment results are never cached (only audio is) sharpens this: as written, whisper.cpp reruns on every render regardless of cache-hit status on the synthesis side, which makes the unstated per-run cost larger than the proposal implies, not smaller.
**Fix:** State expected seconds-per-block for synthesis and alignment on the target M3 hardware, and the aggregate for a representative video, cache-cold and cache-warm.
**Status:** upheld

### [WARN] party-po — Configuration surface (per-scene voice/speed/pitch, four caption styles, configurable padding) is added with no value attached to the granularity itself
**Quotes:**
> Voice selection, speed and pitch are exposed per-spec and per-scene.
>
> - styles: word-by-word pop, phrase blocks, karaoke highlight (active word emphasized), classic
>   bottom-third
> - safe-area aware, with a distinct centred/burned style for vertical shorts
>
> configurable head/tail padding, minimum duration
**Problem:** The problem section motivates one caption need (captions must exist and not drift) and one duration need (scenes must not cut mid-sentence). Nothing in the problem section asks for four caption presentation styles, a dedicated vertical-format variant, or voice/speed/pitch control at both the spec level *and* the per-scene level rather than spec-level alone. Each knob is a permanent surface: more schema, more tests, more combinations to keep in sync with change 003's emphasis tracks. None of these four items has a stated value beyond "nice to have configurable."
**Fix:** For each knob, name the scenario that requires per-scene (not per-spec) override, and cut caption styles to the one the problem section actually needs, adding the rest only if a scene demonstrably requires it.
**Status:** upheld

### [NOTE] party-po — SRT/VTT export and the lexicon are cheap add-ons riding on the alignment artifact and could be named as an explicit late cut line
**Quotes:**
> **7. Sidecar exports.** SRT and VTT generated from the same word timings, for platform upload.
>
> **8. Pronunciation control.** A project lexicon mapping technical terms to phonemes or respellings
**Problem:** Both items are low marginal cost once word timings exist (item 3) and each has a stated value (platform upload, avoiding mispronunciation), so neither is objectionable on its own. But if the panel accepts the split proposed above (duration-feedback first, alignment-dependent features second), the proposal should say explicitly that items 7 and 8 belong to the *second* increment, not the first — right now they're listed as flat in-scope items with no shipping-order relative to items 1-4. Party-security's round-1 finding that the lexicon is missing from the cache key is a separate (correctness) defect in item 8 and does not change its value-per-cost; the sequencing point stands independently of whether that defect is fixed.
**Fix:** Tag each in-scope file with which increment it belongs to if the staged-delivery option above is adopted.
**Status:** upheld
