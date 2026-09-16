### [BLOCK] party-architect — Adds a second `audio` concept to the same schema while the first is named, kept, and left dead
**Quotes:** > The one field that looks like it should — the top-level `audio.track` in
> `packages/core/src/schema.ts:17` — is declared, exported as `AudioTrack`, and **never read**
> anywhere in `packages/cli` or `packages/audio`. It is a stub.
**Quotes:** > - Implementing or removing the dead top-level `audio.track` (music bed). Separate proposal; noted
>   in Open Questions.
**Quotes:** > - Regenerated `packages/claude/schemas/video-spec.schema.json` and the skill copy.
**Problem:** The proposal identifies an existing declared-and-exported `audio` field, proves it is unreachable, and then adds a *second* field named `audio` — at a different level, with a different shape (`src`/`padStart`/`padEnd` vs `track`) — while explicitly declining to extend or delete the first. The commit ships a regenerated JSON schema and skill copy containing both: one live per-scene `audio` and one inert top-level `audio.track`. That schema is the contract a model authors specs against, so the divergence is not internal cleanup deferred to later — it is published at merge, and Open Question 4 shows the proposal knows it has no answer for which of the two an author should reach for. Either the new capability is the realisation of the field that was already declared for it, or the artifact must say what `AudioTrack`'s shape cannot express, so the two names are not competing in one generated schema.
**Fix:** In this change, either delete `audio.track` from `sceneSchema`'s parent so the regenerated schema has exactly one `audio` contract, or state in the artifact why the declared `AudioTrack` cannot carry per-scene voice and therefore why a second key of the same name is correct.
**Status:** upheld

### [BLOCK] party-architect — `--captions` behaviour changes but no captions file appears in the enumerated co-changes
**Quotes:** > 4. **Captions.** `insertCaptionsLayers` requires reference text for forced alignment; an external
>    audio scene has none, so `--captions` skips those scenes and prints one warning naming them.
**Quotes:** > - **Files affected:** ~10 (estimated) — `schema.ts`, `types.ts`, `decode.ts`, `audio/index.ts`,
>   `render-pipeline.ts`, three test files, the generated schema (two copies), `SKILL.md`.
**Problem:** The proposal changes what `insertCaptionsLayers` is asked to do — it must now receive, or be told about, a subset of scenes rather than all of them — but the file list and the In Scope list name no captions module at all; the only home offered is `render-pipeline.ts`: "captions skip + warning". Two readings follow and the artifact does not choose: either the caller filters the scene list before the call (which changes the argument `insertCaptionsLayers` receives and therefore the indices it aligns against, a co-change to that function's contract), or `insertCaptionsLayers` itself learns about `scene.audio` (a file the commit does not list). Implemented on the first reading by one person and the second by another, this half-lands: a skip that silently misaligns caption layers for the *Kokoro* scenes that follow an external-audio scene is indistinguishable from success until someone watches the video.
**Fix:** Name the module that owns the skip and state whether `insertCaptionsLayers` receives a filtered scene list or the full list plus an exclusion set, and which one keeps scene indices stable.
**Status:** upheld

### [WARN] party-architect — `padEnd` has no specified effect on the voice track, only on duration, next to existing overlap arithmetic
**Quotes:** > The decoded block is stored with `offsetSeconds = padStart` and its scene's
>    measured duration is `padStart + decoded + padEnd`.
**Quotes:** > That re-implements `compileTimeline`'s
>   cross-fade overlap arithmetic (`startFrame = frameCursor - overlapFrames`) in a second place,
**Quotes:** > voice-track placement at `startFrame/fps + padStart`; mixed Kokoro + external scene; captions
>   skip).
**Problem:** `padStart` is fully specified — it becomes `offsetSeconds` and shifts PCM placement. `padEnd` is specified only as a term in the measured duration; nothing says whether trailing silence is laid into the voice track, and the proposal already tells us scene starts are pulled *backwards* by `overlapFrames`. So the scene now has two independent knobs governing the gap around its audio — the author's `padEnd` and the compiler's cross-fade overlap — and the artifact never states which wins. An implementer who treats `padEnd` as duration-only lets the next scene's voice begin inside it whenever `overlapFrames > 0`; one who pads the buffer does not. The named test asserts placement at `startFrame/fps + padStart` and says nothing about the tail, so both implementations pass the stated test suite.
**Fix:** State whether `padEnd` reserves silence in the assembled voice track or only extends the measured duration, and what it means when `overlapFrames` exceeds `padEnd`.
**Status:** upheld

### [WARN] party-architect — External audio with a numeric `duration` is an unspecified case the schema permits
**Quotes:** > Add an optional **per-scene** `audio` field that behaves exactly like a synthesised narration
> block from the timeline's point of view:
**Quotes:** > `sceneSchema` gains `audio?: { src: string (min 1); padStart?:
>    number ≥ 0; padEnd?: number ≥ 0 }`. A scene may carry `narration` **or** `audio`, not both — a
>    `superRefine` issue at `/scenes/N` with a repair suggestion, so the diagnostic reaches Claude's
>    repair loop like every other parse failure.
**Quotes:** > `duration: "auto"` and cross-fade placement come for free.
**Problem:** Every worked example and every named test uses `duration: "auto"`. The schema as described constrains only `narration`-xor-`audio`, so `{"duration": 6, "audio": {...}}` parses cleanly, and the artifact never says what the pipeline does when the decoded block runs past the frame the scene ends on — truncate, bleed into the next scene, or fail. "Behaves exactly like a synthesised narration block" is offered as the answer but is a claim about unstated existing behaviour, not a specification. Relatedly, `src` is validated as a non-empty string only, so a missing file passes the parse layer that owns diagnostics and the repair loop, and fails instead inside Step A after other scenes have already been synthesised — putting the check on the wrong side of the seam the proposal itself chose for author-facing errors.
**Fix:** Either extend the `superRefine` to require `duration: "auto"` alongside `audio`, or state the overrun rule; and say whether `src` existence is checked at parse time (reaching the repair loop) or at decode time (a `DecodeError` abort).
**Status:** upheld

### [WARN] party-architect — Step A gains a second collection path that bypasses the synthesis cache, with the cache declared out of scope
**Quotes:** > 3. **Pipeline (`@claudevid/cli`).** Step A becomes "collect scene audio": for each scene, either
>    synthesise its narration blocks (unchanged) or decode its `audio.src` at **24 000 Hz** — Kokoro's
>    native rate
**Quotes:** > - Any change to Kokoro synthesis, chunking, or the synthesis cache.
**Problem:** The proposal renames Step A from synthesis to "collect scene audio" — a generalisation of the stage — and then fences the cache that stage owns out of scope. The result is one stage with two branches under different rules: narration blocks are cached, decoded blocks are re-run through ffmpeg on every render, and the artifact never says this is intentional. An implementer must guess whether decoded PCM is keyed into the existing cache (needing a key derived from `src` plus mtime plus the pads, none of which the proposal defines) or deliberately uncached. The two choices produce materially different behaviour on re-render and are indistinguishable from the text.
**Fix:** State explicitly that decoded blocks do not participate in the synthesis cache, or define the cache key for them.
**Status:** upheld

### [NOTE] party-architect — Every named decoder test stubs the thing being specified
**Quotes:** > New `decodeAudioFile(src, { sampleRate }, spawnFn)` runs
>    `ffmpeg -i <src> -f s16le -acodec pcm_s16le -ac 1 -ar <sampleRate> pipe:1` and returns
>    `{ audio: Buffer, sampleRate }` — the same shape `synthesize()` returns.
**Quotes:** > `audio/test/decode.test.ts` (fake spawn: argv shape, stdout → buffer, non-zero exit →
> `DecodeError`)
**Problem:** The injectable-spawn and `decodeAudioFn` seams are the right call and make the pipeline tests deterministic — probe 5 is largely satisfied. The residue is that the one claim the whole feature rests on, that this argv yields headerless signed-16-bit mono PCM at 24 kHz in the byte layout `assembleVoiceTrack` expects, is asserted only by a fake-spawn test comparing the argv to the same literal the implementation writes. A transposed flag or a missing `-f s16le` passes every listed test and produces noise in the rendered video. A single checked-in one-second fixture decoded by real ffmpeg, asserting sample count and rate, closes it without making the suite network- or model-dependent.
**Fix:** Add one real-ffmpeg fixture test asserting decoded sample count and rate, alongside the fake-spawn argv test.
**Status:** upheld
