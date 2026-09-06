### [WARN] party-visionary — The cache key is a hand-maintained list of "everything that changes the waveform", and the proposal already names two inputs it omits
**Quotes:** > Narration is synthesized per scene (or per narration block), keyed by a hash of
> `text + voice + speed + model version`, cached under `.claudevid/cache/tts/`.
> Voice selection, speed and pitch are exposed
> per-spec and per-scene.
> A project lexicon mapping technical terms to phonemes or respellings
**Problem:** The key enumerates four inputs, but the same document exposes pitch and a project lexicon as synthesis inputs and puts neither in the key. party-security independently filed the lexicon omission as a BLOCK on the fail-open axis; that convergence confirms the merge-day defect, but the long-horizon defect is the enumeration itself. party-security's proposed fix is a longer enumeration (text, voice, speed, model version, model file digest, lexicon digest, padding), which is the same pattern with more entries, and the next knob (emotion, SSML pauses, a second model) bypasses it in exactly the same way because the key lives in `cache.ts` and the knob lands in `tts.ts` or `lexicon.ts`. If party-po's staged split is adopted, this gets worse: increment one fixes the key shape before increment two adds the inputs that most need to be in it.
**Fix:** Define the key as a hash of the full resolved synthesis request object (post-lexicon text, all voice parameters, model id and digest) rather than a named subset, so adding a knob cannot bypass the cache without touching the request type. Adopt party-security's atomic-write and stored-digest points on top of that.
**Status:** upheld

### [WARN] party-visionary — `duration: "auto"` makes the visual timeline a function of an unpinned model download, so a model upgrade silently changes every existing video's cut points
**Quotes:** > keyed by a hash of
> `text + voice + speed + model version`
> Model acquisition: download-on-first-use with integrity check and a documented cache location
> A scene carrying `narration` may declare `duration: "auto"`. The audio pipeline measures the
> synthesized block and supplies an `AudioDurations` map to change 001's `compileTimeline`
**Problem:** No other seat addressed reproducibility. party-security's root-of-trust finding asks for a pinned URL and digest committed in the repository, which is necessary but pins the *library's* model, not the *project's*: a library upgrade six months on still re-times every `auto` scene in every existing spec, shifts every 003 motion cue, and re-flows every caption, and invalidates the whole TTS cache for every project at once. The proposal never says whether a spec records the model it was rendered with, so re-rendering an old spec on a fresh machine produces a different video with no warning.
**Fix:** State that the model id and version are a spec-level (or lockfile-level) fact the pipeline reads, not a machine-level fact it discovers, and that a mismatch is a warning rather than a silent re-time.
**Status:** upheld

### [WARN] party-visionary — Narration as a bare string plus multi-speaker out of scope closes the schema door the out-of-scope item would need
**Quotes:** > - Multi-speaker dialogue / character voices
> - **Where does narration live in the schema?** `scene.narration: string`, or a `voiceover` layer,
>   or a top-level script array indexed to scenes? The first is simplest for Claude to emit
>   correctly
**Problem:** Two round-1 findings from other seats sharpen this rather than weaken it. party-ba shows the survivability claim only holds if a "block" is sentence-sized, which means the schema must carry sentence segmentation the string cannot express. party-po questions per-scene voice/speed/pitch knobs; wherever they land, a structured narration block is the natural carrier and a bare string has no room for them. The change that adds character voices later has to either break every existing spec (string becomes object) or introduce a parallel field and support both forever, and the cache keys on the text so the migration also invalidates every cached block.
**Fix:** Whichever location is chosen, make the value a structured block (`{ text, voice?, speaker? }` or an array of them) from day one, with the bare string accepted as shorthand that normalises to it.
**Status:** upheld

### [WARN] party-visionary — The word-timings artifact is frozen by three consumers on merge day, and the proposal already names a case where consumers need provenance it does not carry
**Quotes:** > Output: `{ word, start, end }[]` per block. This single artifact drives captions, speech-synced
> motion, and SRT/VTT export.
> or do we need a fallback (proportional distribution across a phrase) when
>   confidence is low?
> does the `synthesize()` signature we write now accommodate a
>   provider that *returns its own word timings* (skipping alignment entirely)?
**Problem:** Three seats reached this type independently: party-architect asks it to state timing origin and surface-form conventions, party-security requires a per-word `estimated: true` marker on the fallback path, and this seat asks for provenance and segment grouping. That is three fields from three lenses on a type the proposal specifies as three fields total and describes as the piece that unlocks everything. If it ships as `{ word, start, end }` and each of those needs arrives as a separate later change, each is a three-consumer migration plus fixture rewrite; the first one sets the precedent that the type is frozen and the rest get bolted on as side maps.
**Fix:** Reserve the room now: a per-word `confidence` or `source` field, an optional phrase/segment grouping, and a stated timing origin, even if v1 always fills them with constants.
**Status:** upheld

### [NOTE] party-visionary — Putting the `captions` layer inside `packages/audio` teaches that a layer lives where its data comes from, and the named follow-on will copy it
**Quotes:** > - `packages/audio/src/captions/` — captions layer schema, layout, styles, word emphasis
> A `captions` layer registered into core, rendered by change 002, animated by change 003
> - Audio-reactive motion (waveform-driven animation) — a natural follow-on once timings exist
**Problem:** party-architect filed the merge-day layering problem as a BLOCK; this finding is the precedent it leaves if the block is resolved by exception rather than by rule. The contributor who picks up the named "natural follow-on" of audio-reactive motion will generalise from where captions landed, not from a reviewer comment on this change. If captions move to the renderer, the artifact should say *why* so the follow-on inherits the rule.
**Fix:** State in the artifact that layers live with the renderer and consume audio artifacts by type import only, and place `captions/` accordingly, so the follow-on has a correct template to copy.
**Status:** upheld

### [NOTE] party-visionary — The optional `AudioDurations` seam is one step short of letting the timeline compile without models at all
**Quotes:** > **Recommendation: yes, with an optional
>   `AudioDurations` argument**, so core stays I/O-free and 006 does not force a schema break.
> Total
>   footprint and where it lives (`~/.cache/claudevid/`?) needs deciding before anyone ships this
>   in CI.
**Problem:** party-architect's test-seam finding is the same gap seen from the test side: nothing can exercise `compileTimeline` on an `auto` scene without the real stack. The proposal never says what `auto` resolves to when the map is absent, so every future non-render consumer (storyboard preview, thumbnail extraction, schema linter, CI smoke test) either fails on `auto` scenes or downloads models first. A deterministic no-audio estimate defined now makes the whole preview class of changes free and gives the test seam a meaningful default.
**Fix:** Specify the absent-map behaviour for `auto` as a documented words-per-minute estimate, clearly marked as such, and have the real measurement replace it.
**Status:** upheld

### [NOTE] party-visionary — The cache stores the audio but not the timings or measured duration it was created to produce, so alignment is paid on every run the cache was meant to make free
**Quotes:** > Editing one
> sentence re-synthesizes one block. This mirrors change 005's chunk resume and is what makes the
> edit loop survivable.
> We run **whisper.cpp** (Metal-accelerated on M3) over the
> *generated* audio to get word-level timestamps.
**Problem:** party-po's unquantified wall-clock finding makes this concrete: whatever the per-block alignment cost is, as described it is paid for all 360 blocks on every edit, not the one that changed. If party-po's staged split is adopted, the risk is sharper still, because increment one fixes the cache entry as audio-only and increment two, arriving later with alignment, adds a second cache with a second key in `align.ts`; the two drift on the first key change. The content hash that identifies the audio identifies its timings and duration exactly.
**Fix:** Make the cache entry the full per-block artifact set `{ audio, timings, duration }` keyed once, with the timings slot allowed to be empty until alignment lands, so alignment and measurement are hits whenever synthesis is.
**Status:** upheld
