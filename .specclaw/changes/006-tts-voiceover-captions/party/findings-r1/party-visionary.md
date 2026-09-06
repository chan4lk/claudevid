### [WARN] party-visionary — The cache key is a hand-maintained list of "everything that changes the waveform", and the proposal already names two inputs it omits
**Quotes:** > Narration is synthesized per scene (or per narration block), keyed by a hash of
> `text + voice + speed + model version`, cached under `.claudevid/cache/tts/`.
> Voice selection, speed and pitch are exposed
> per-spec and per-scene.
> A project lexicon mapping technical terms to phonemes or respellings
**Problem:** The key enumerates four inputs, but the same document exposes pitch and a project lexicon as synthesis inputs and puts neither in the key. The lexicon case is the one that bites a year on: a contributor fixes the `kubectl` respelling, re-renders, and every block containing `kubectl` is a cache hit on the old mispronounced audio, because `text` did not change. Nothing fails; the video simply ships wrong, and the fix looks broken. Every future synthesis knob (emotion, SSML pauses, a second model) repeats this unless someone remembers the key, which nobody will because the key is a string in `cache.ts` and the knob is in `tts.ts` or `lexicon.ts`.
**Fix:** Define the key as a hash of the full resolved synthesis request object (post-lexicon text, all voice parameters, model id) rather than a named subset, so adding a knob cannot bypass the cache without touching the request type.
**Status:** upheld

### [WARN] party-visionary — `duration: "auto"` makes the visual timeline a function of an unpinned model download, so a model upgrade silently changes every existing video's cut points
**Quotes:** > keyed by a hash of
> `text + voice + speed + model version`
> Model acquisition: download-on-first-use with integrity check and a documented cache location
> A scene carrying `narration` may declare `duration: "auto"`. The audio pipeline measures the
> synthesized block and supplies an `AudioDurations` map to change 001's `compileTimeline`
**Problem:** Model version is in the cache key, but nothing in the proposal pins it in the project. With download-on-first-use, "model version" is whatever the machine happens to have. The consequence compounds through item 4: scene durations are measured from synthesized audio, so a newer Kokoro that speaks 3% faster re-times every `auto` scene, shifts every motion cue in change 003, and re-flows every caption. Re-rendering a six-month-old spec on a fresh machine produces a different video, and the first Kokoro upgrade invalidates the entire cache for every project at once, which is exactly the "re-synthesizes 30 minutes" scenario the proposal calls ruinous. The proposal never says whether the spec records the model it was rendered with.
**Fix:** State that the model id and version are a spec-level (or lockfile-level) fact that the pipeline reads, not a machine-level fact it discovers, and that a mismatch is a warning rather than a silent re-time.
**Status:** upheld

### [WARN] party-visionary — Narration as a bare string plus multi-speaker out of scope closes the schema door the out-of-scope item would need
**Quotes:** > - Multi-speaker dialogue / character voices
> - **Where does narration live in the schema?** `scene.narration: string`, or a `voiceover` layer,
>   or a top-level script array indexed to scenes? The first is simplest for Claude to emit
>   correctly
**Problem:** The proposal leans toward `scene.narration: string` because it is easiest to emit, and separately defers multi-speaker. Those two decisions interact: a string has nowhere to put a speaker, a per-sentence voice override, or a pause marker. The change that adds character voices later has to either break every existing spec (string becomes object) or introduce a parallel `narration2`-style field and support both forever. The proposal flags the location as an open question but not as a one-way door; the shape is what persists, and the shape is decided by the moment the first spec is committed and the cache keys on its text.
**Fix:** Whichever location is chosen, make the value a structured block (`{ text, voice?, speaker? }` or an array of them) from day one, with the bare string accepted as shorthand that normalises to it. The shorthand keeps Claude's emit path simple; the normalised form keeps the door open.
**Status:** upheld

### [WARN] party-visionary — The word-timings artifact is frozen by three consumers on merge day, and the proposal already names a case where consumers need provenance it does not carry
**Quotes:** > Output: `{ word, start, end }[]` per block. This single artifact drives captions, speech-synced
> motion, and SRT/VTT export.
> or do we need a fallback (proportional distribution across a phrase) when
>   confidence is low?
> does the `synthesize()` signature we write now accommodate a
>   provider that *returns its own word timings* (skipping alignment entirely)?
**Problem:** Once captions, 003 motion tracks, and export all read `{ word, start, end }`, adding a field means touching three consumers and every fixture. The proposal itself lists two futures that need more: low-confidence fallback timings (a karaoke highlight on a proportionally-guessed word should probably degrade to phrase mode, but the consumer cannot tell guessed from aligned) and cloud providers that return native timings (often with phrase boundaries and punctuation attached). The type is described as the piece that unlocks everything, which is exactly why its first shape is the one the project lives with.
**Fix:** Reserve the room now: a per-word `confidence` or `source` field and an optional phrase/segment grouping, even if v1 always fills them with constants. Cheap today, a three-consumer migration in a year.
**Status:** upheld

### [NOTE] party-visionary — Putting the `captions` layer inside `packages/audio` teaches that a layer lives where its data comes from, and the named follow-on will copy it
**Quotes:** > - `packages/audio/src/captions/` — captions layer schema, layout, styles, word emphasis
> A `captions` layer registered into core, rendered by change 002, animated by change 003
> - Audio-reactive motion (waveform-driven animation) — a natural follow-on once timings exist
**Problem:** The captions layer is a visual layer whose only tie to audio is that it consumes the timings artifact, yet it ships inside the audio package. The contributor who picks up the "natural follow-on" of audio-reactive motion will generalise correctly from this: motion driven by audio data goes in `packages/audio`. Two follow-ons later, the audio package is the home of half the visual layer catalogue and every renderer change has to import it. The precedent is right for the audio graph and wrong for anything the renderer draws.
**Fix:** State in the artifact that layers live with the renderer and consume audio artifacts by type import only, and place `captions/` accordingly, so the follow-on has a correct template to copy.
**Status:** upheld

### [NOTE] party-visionary — The optional `AudioDurations` seam is one step short of letting the timeline compile without models at all
**Quotes:** > **Recommendation: yes, with an optional
>   `AudioDurations` argument**, so core stays I/O-free and 006 does not force a schema break.
> Total
>   footprint and where it lives (`~/.cache/claudevid/`?) needs deciding before anyone ships this
>   in CI.
**Problem:** Making `AudioDurations` optional is the right seam, but the proposal never says what `duration: "auto"` resolves to when the map is absent. As written, every future consumer of `compileTimeline` that is not a final render — storyboard preview, thumbnail extraction, a schema linter, a CI smoke test — either fails on `auto` scenes or must download 400 MB of models first. Defining a deterministic no-audio estimate (words-per-minute from the narration text, clearly marked as an estimate) at the same time costs almost nothing and makes the whole preview class of changes free.
**Fix:** Specify the absent-map behaviour for `auto` as a documented estimate, and have the real measurement replace it, so the pipeline order is the fast path rather than the only path.
**Status:** upheld

### [NOTE] party-visionary — The cache stores the audio but not the timings or measured duration it was created to produce, so alignment is paid on every run the cache was meant to make free
**Quotes:** > Editing one
> sentence re-synthesizes one block. This mirrors change 005's chunk resume and is what makes the
> edit loop survivable.
> We run **whisper.cpp** (Metal-accelerated on M3) over the
> *generated* audio to get word-level timestamps.
**Problem:** The proposal describes caching synthesis output, and alignment as a step run over that output; it never says alignment results are cached. The same content hash that identifies the audio identifies its timings and duration exactly, so the cache entry could be `{ audio, timings, duration }` and the edit loop would skip whisper for 359 of 360 scenes. Left as described, the next contributor who notices the slow edit loop adds a second cache with a second key in `align.ts`, and the two drift.
**Fix:** Make the cache entry the full per-block artifact set keyed once, so alignment and measurement are hits whenever synthesis is.
**Status:** upheld
