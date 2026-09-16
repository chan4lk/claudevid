### [WARN] party-visionary — The key `audio` is being spent on "voice replacement" at scene level while its meaning at the root is left undecided
**Quotes:**
> The one field that looks like it should — the top-level `audio.track` in
> Add an optional **per-scene** `audio` field that behaves exactly like a synthesised narration
> 4. **What to do with the dead `audio.track`?** Leave (this proposal), implement as a looped music
>    bed via `graph.ts`'s `loop`/`duckUnderVoice`, or delete it from the schema to stop misleading
>    authors.
**Problem:** The proposal commits `scene.audio` to mean "the voice for this scene" and publishes it into the JSON schema, the skill copy, and Claude's repair-loop diagnostics, while explicitly deferring what `audio` means one level up. If Open Question 4 later resolves to "implement `audio.track` as a music bed", the spec grammar ends up with `audio` meaning music at the root and voice inside a scene, and the next plausible change — a per-scene music sting or bed (an intro slide with a jingle, exactly what `graph.ts`'s `duckUnderVoice` exists for) — finds `scene.audio` already taken and has to invent `scene.music` or `scene.bed`, leaving the two levels permanently asymmetric. Once academy specs on disk carry `"audio": { "src": ... }`, renaming the scene key is a migration of every spec plus a schema deprecation alias, not a flip. The artifact treats the field as "additive, low risk" and does not acknowledge that the name is the one part that cannot be walked back. Round 2: party-architect's BLOCK on the same lines covers the merge-day half (two competing `audio` contracts in one generated schema); this finding is the half that begins the day the first academy spec is committed with the key in it. Both fixes converge on the same action — decide `audio.track` now — so this is upheld as the reason the architect's fix cannot be deferred to the "separate proposal" the artifact names.
**Fix:** Either resolve Open Question 4 before this ships (delete `audio.track`, freeing the name for a consistent meaning at both levels), or pick a scene key that names the role rather than the medium (e.g. a voice-source field) so a later music bed can take `audio` at either level without collision. State in the artifact that the key name is the permanent commitment.
**Status:** upheld

### [WARN] party-visionary — Copying the `process.cwd()` path rule bakes machine-absolute paths into the "single source of truth" and doubles the cost of ever fixing it
**Quotes:**
> - Resolving relative `src` paths against the spec file's directory. Image layers today resolve
>   against `process.cwd()`; this change keeps the same rule and documents "use absolute paths".
> Neither is acceptable for a pipeline whose whole point is that the JSON spec is the single source
> of truth for timing.
> 5. **Docs.** `.claude/skills/video-generator/SKILL.md` gets an "External audio per scene" section
>    (when to use it, the 24 kHz mono normalisation, mutual exclusion with `narration`, absolute
>    paths). The dist README follows.
**Problem:** Every academy spec produced under this rule will contain `/Users/<someone>/...` in each scene's `audio.src`. A spec that is supposed to be the single source of truth becomes un-rerenderable on any other machine or in CI the moment it is committed; the fix for a moved WAV directory is a sed over N specs. Separately, the precedent is now taught twice: image layers and audio both resolve against cwd, and both SKILL.md and the dist README say "use absolute paths" in prose. The next change that makes `src` spec-relative (which the proposal itself names as the deferred fix) must flip two field types together, update two prose documents that nothing tests, and decide what to do with existing specs whose absolute paths happen to still resolve — and the third `src`-bearing field (the music bed) will copy whichever rule is in place when it lands. Two rules become three before anyone fixes one. Round 2: party-security's BLOCK on the same line arrives at containment under "the spec file's directory, or an explicit `--audio-root`" from the trust-boundary side, and party-ba's WARN arrives at "add a criterion for a relative path" from the evidence side. Three seats from three lenses land on the same fix; adopting security's containment root as the spec directory resolves this finding for free, which is the compounding case the artifact declines by keeping the cwd rule.
**Fix:** Either resolve `audio.src` relative to the spec file's directory now (with absolute paths still accepted), so this field does not extend the cwd precedent, or state in the artifact that spec portability is being traded away and record the two documentation sites that must change when the rule is fixed.
**Status:** upheld

### [WARN] party-visionary — Hard-coding 24 000 Hz at the decode call site duplicates a fact the synthesiser already reports, and the copy drifts the day a second TTS backend is wired in
**Quotes:**
> or decode its `audio.src` at **24 000 Hz** — Kokoro's native rate — so `assembleVoiceTrack`'s one-sample-rate rule holds when a spec mixes Kokoro and
>    external scenes.
> `{ audio: Buffer, sampleRate }` — the same shape `synthesize()` returns.
> 2. **Decode rate: fixed 24 000 Hz, or "adopt the first block's rate"?** Fixed is simpler and
>    matches Kokoro; the only cost is downsampling 44.1 kHz sources, inaudible for speech.
**Problem:** `synthesize()` returns its own `sampleRate`; the pipeline will nonetheless carry a literal `24000` chosen because it "matches Kokoro", and the same number is restated as "the 24 kHz mono normalisation" in SKILL.md and the README. The proposal's own Problem section lists four cloned-voice backends the academy already runs; the plausible next change is wiring one of them (or any non-Kokoro engine) as a native synthesis backend rather than via pre-rendered WAV. That contributor changes the synth package, runs a mixed spec, and hits `assembleVoiceTrack`'s one-rate rule from a literal in `render-pipeline.ts` they had no reason to look at — then must also correct two prose documents that nothing fails on. Open Question 2 frames this as a simplicity choice; it is actually a sync obligation between `@claudevid/audio` and `@claudevid/cli` with no owner. No other seat addressed this line and no round-1 finding gives a reason to think the reading is wrong.
**Fix:** Derive the decode rate from the synthesiser's reported `sampleRate` (or a single exported constant in `@claudevid/audio` that both the synth and the decoder read), and keep the number out of the prose docs, which only need to say "normalised to the voice track's rate".
**Status:** upheld

### [NOTE] party-visionary — The decoder is the seam the deferred music bed needs, but it is shaped for voice only and the artifact does not claim it as the reusable piece
**Quotes:**
> New `decodeAudioFile(src, { sampleRate }, spawnFn)` runs
>    `ffmpeg -i <src> -f s16le -acodec pcm_s16le -ac 1 -ar <sampleRate> pipe:1`
> - Per-scene gain, fades, or ducking — `graph.ts` already has that vocabulary for whole tracks; not
>   needed for a voice replacement.
**Problem:** Returning the `synthesize()` shape means anything that yields PCM can enter Steps B/D/G unchanged — that is real leverage, and it is exactly what implementing `audio.track` as a looped, ducked music bed via `graph.ts` will need. But the decoder hard-codes `-ac 1`, so the music-bed change must widen the signature (channels) and re-touch `decode.test.ts`'s argv assertions, and the artifact never states that this decoder is the intended entry point for that later work. The next contributor is as likely to write a second ffmpeg-spawning decoder beside it as to extend this one. Round 2: party-architect's NOTE observes the argv is asserted only against a fake spawn comparing to the same literal; that makes widening the argv later cheaper to get wrong, not harder, so it reinforces rather than contradicts this finding. party-security's WARN on timeout and output caps names further options (`maxSceneSeconds`, kill-after) that a music bed would also need — one more reason the decoder's option bag should be shaped for reuse now rather than grown by three later changes independently.
**Fix:** Take channels as an option now (defaulting to mono), and add one sentence to the artifact naming `decodeAudioFile` as the input path for the deferred music bed so the seam is used rather than duplicated.
**Status:** upheld
