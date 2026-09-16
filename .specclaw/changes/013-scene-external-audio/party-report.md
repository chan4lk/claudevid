# Party Report: 013-scene-external-audio

**Reviewed:** 2026-09-16
**Tier:** deep (classifier) — One unresolved design question (whether padStart/padEnd belong in the schema or callers pre-pad their audio) whose answer changes the file list.
**Panel:** party-po(sonnet), party-architect(opus), party-ba(sonnet), party-security(opus), party-visionary(fable)
**Verdict:** CHANGES_REQUESTED

## Summary

24 findings: 3 BLOCK, 13 WARN, 6 NOTE upheld — 2 withdrawn

## Findings

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

### [WARN] party-ba — Central "no other path exists" claim is asserted, not sourced
**Quotes:**
> The one field that looks like it should — the top-level `audio.track` in
> `packages/core/src/schema.ts:17` — is declared, exported as `AudioTrack`, and **never read**
> anywhere in `packages/cli` or `packages/audio`. It is a stub.

**Problem:** The proposal's entire premise — that a new per-scene field is necessary rather than wiring up the field that already exists — rests on the claim that `audio.track` is "never read anywhere." One location is cited (`schema.ts:17`, where it is *declared*), but the negative claim about the rest of the codebase (that it is never *consumed*) has no citation — no grep output, no test reference, nothing a reader could check without leaving the document. If this claim is wrong, the "concrete consumer" problem might already be solvable by wiring up an existing dead field instead of adding a new one, which is a materially different (and smaller) fix.
**Fix:** Cite how "never read" was established (e.g., a grep/search result, or a specific negative test), or drop the certainty and phrase it as "not currently wired up as of this writing."
**Status:** upheld

### [WARN] party-ba — The one real-world justification for the whole proposal is an unsourced assertion
**Quotes:**
> Concrete consumer: the BISTEC Hearts Academy pipeline already produces per-slide narration as
> WAV files from cloned-voice backends (NeuTTS Air, OmniVoice, MiMo, Audio8) that reproduce a real
> presenter's voice. Those videos must use that voice, not Kokoro's presets.

**Problem:** This paragraph is the sole concrete evidence offered that the stated problem hurts anyone today — everything else in the Problem section is a description of the code's current architecture, not evidence of pain. There is no citation for who runs this pipeline, where its requirement to preserve presenter identity is recorded, or why the two documented workarounds ("give up duration: auto" / "use Kokoro") were actually tried and rejected rather than hypothesized. The proposal's scope and priority stand entirely on this one unverified sentence.
**Fix:** Point to the artifact that establishes the requirement (a ticket, a prior decision doc, a sample video that was rejected for using the wrong voice) rather than stating the need as fact.
**Status:** upheld

### [NOTE] party-ba — Default pad values are justified by an unsourced universal claim
**Quotes:**
> Recommendation: keep them — a 0.4 s lead-in and 0.6 s tail is exactly the "breath between
> slides" every academy scene needs, and padding PCM is trivial here but a second ffmpeg pass for
> every caller.

**Problem:** "every academy scene needs" a 0.4s/0.6s breath is a specific, falsifiable-sounding claim about presentation timing, offered with no source (no measurement of existing academy videos, no cited convention). It's used to justify keeping `padStart`/`padEnd` in the schema rather than pushing padding onto callers — a scope decision resting on a number that appears nowhere else in the document.
**Fix:** Either cite where the 0.4s/0.6s figures came from (an existing render, a style guide) or state the recommendation as a starting default rather than a settled fact about universal need.
**Status:** upheld

### [WARN] party-ba — Path-resolution rule assumes authors read and follow documentation with no fallback described
**Quotes:**
> Resolving relative `src` paths against the spec file's directory. Image layers today resolve
> against `process.cwd()`; this change keeps the same rule and documents "use absolute paths".

**Problem:** The correctness of every external-audio scene depends on authors supplying absolute paths, per documentation only — the proposal never establishes that authors of hand-written or generated video specs reliably do this (the existing `process.cwd()` rule for image layers is asserted as precedent, but no evidence is given that authors get *that* right either). This is a behavioral assumption load-bearing enough that if wrong, the feature silently resolves to the wrong file rather than erroring, and nothing in Scope's test list checks for a bad-path scenario.
**Fix:** Either cite that the existing `process.cwd()` convention for image layers works in practice for this consumer's specs, or add a criterion for what happens when a relative path is supplied.
**Status:** upheld

### [WARN] party-po — Value of shipping this is asserted, not quantified
**Quotes:**
> Concrete consumer: the BISTEC Hearts Academy pipeline already produces per-slide narration as
> WAV files from cloned-voice backends (NeuTTS Air, OmniVoice, MiMo, Audio8) that reproduce a real
> presenter's voice. Those videos must use that voice, not Kokoro's presets. Today the only options
> are:
>
> - **Give up `duration: "auto"`** and compute every scene's numeric duration from the WAV outside
>   claudevid, render silent, and mux with ffmpeg afterwards. That re-implements `compileTimeline`'s
>   cross-fade overlap arithmetic (`startFrame = frameCursor - overlapFrames`) in a second place,
>   which will drift the moment the timeline compiler changes.
**Problem:** The proposal names the workaround (external duration math + silent render + ffmpeg mux) and asserts it "will drift the moment the timeline compiler changes," but states no number for how often `compileTimeline`'s arithmetic has actually changed, how many academy videos per period use this workaround, or what a drift incident costs to detect and fix. The whole ~10-file, four-package change is justified by a risk that is named but never sized — the do-nothing option ("keep using the external-mux workaround") may be cheap and rare-to-break, or expensive and frequent; the artifact gives no basis to tell which.
**Fix:** State the volume (videos/month on the workaround) or the historical change frequency of the touched arithmetic, so the cost of the status quo can be weighed against the cost of this change.
**Status:** upheld

### [NOTE] party-po — Six-item scope ships as one atomic unit with no named cut line
**Quotes:**
> - `packages/core/src/schema.ts`, `types.ts`: `SceneAudio` schema/type, narration-xor-audio
>   refinement with a JSON-pointer diagnostic.
> - `packages/audio/src/decode.ts` (+ export from `index.ts`): ffmpeg-backed decoder with injectable
>   spawn; `DecodeError` carrying the ffmpeg stderr tail like `MuxError`.
> - `packages/cli/src/render-pipeline.ts`: Step A extension, `decodeAudioFn` seam in
>   `RenderPipelineOptions`, captions skip + warning.
> - Tests: ...
> - Regenerated `packages/claude/schemas/video-spec.schema.json` and the skill copy.
> - Skill/README documentation.
> - `pnpm build`, `pnpm test`, `pnpm package` and a reinstall of the global `claudevid` from the new
>   tarball so consumers pick the feature up.
**Problem:** The schema field + decoder + pipeline wiring is the load-bearing part; the SKILL.md/README documentation update and the global-reinstall step are bundled into the same shipped change with no stated reason they can't land as a fast-follow once the code path is proven. The proposal names no cut line between "code that makes the feature work" and "docs/distribution that make it discoverable," so a reviewer can't tell whether docs-lag is an acceptable trade for landing the capability sooner.
**Fix:** Name the smallest shippable slice (schema + decoder + pipeline, usable by hand-authored JSON) versus what can trail (docs, global reinstall), even if the recommendation is to ship them together.
**Status:** upheld

### [NOTE] party-po — Per-scene ffmpeg decode adds an unbounded per-render cost
**Quotes:**
> New `decodeAudioFile(src, { sampleRate }, spawnFn)` runs
> `ffmpeg -i <src> -f s16le -acodec pcm_s16le -ac 1 -ar <sampleRate> pipe:1` and returns
> `{ audio: Buffer, sampleRate }` — the same shape `synthesize()` returns. ffmpeg is already a hard
> requirement of every render, so this adds no dependency and accepts any container/rate ffmpeg
> can read (WAV at 24 k or 44.1 k, MP3, FLAC).
**Problem:** "Adds no dependency" is a true but different claim from "adds no cost" — every external-audio scene now spawns one additional ffmpeg subprocess per render, on top of the existing mux step, with transcode time scaling with source length/bitrate/format. For a many-scene academy video (the proposal's own named use case) this is N extra subprocess spawns per render, and the artifact states no bound on it (wall-clock added, or a cap on scene count before it matters for CI render tests or batch generation).
**Fix:** State the expected per-scene decode overhead (or measure it once and note the order of magnitude) so the added render-time cost is visible, not just the dependency-count claim.
**Status:** upheld

### [BLOCK] party-security — `audio.src` is an unconstrained string handed straight to `ffmpeg -i`, so a spec can make the renderer read any local file or fetch any URL and embed it in the output

**Quotes:**
> `sceneSchema` gains `audio?: { src: string (min 1); padStart?: number ≥ 0; padEnd?: number ≥ 0 }`
> New `decodeAudioFile(src, { sampleRate }, spawnFn)` runs `ffmpeg -i <src> -f s16le -acodec pcm_s16le -ac 1 -ar <sampleRate> pipe:1`
> ffmpeg is already a hard requirement of every render, so this adds no dependency and accepts any container/rate ffmpeg can read (WAV at 24 k or 44.1 k, MP3, FLAC).
> Resolving relative `src` paths against the spec file's directory. Image layers today resolve against `process.cwd()`; this change keeps the same rule and documents "use absolute paths".

**Problem:** The only stated validation on `src` is `min 1`. `ffmpeg -i` does not take filesystem paths — it takes a protocol URL, and the design explicitly advertises "any container ffmpeg can read". A spec (authored by Claude from a skill, not hand-typed by the operator) can therefore set `src` to `http://…`, `concat:`, `pipe:`, `/dev/…`, or any absolute path on the machine, and the renderer will read it and mux the result into a video the operator then uploads to YouTube. That is arbitrary local-file read and outbound network egress reached from a JSON field with no check, plus a data-exfiltration path via the published artifact. Round 1 sharpened rather than weakened this: `party-architect` independently observes that `src` is "validated as a non-empty string only", and `party-ba` and `party-visionary` both flag that the relative-path rule rests on prose ("documents 'use absolute paths'") with no guard and no stated behaviour on a bad path.

**Fix:** Validate `src` in the schema before it reaches spawn: reject any value containing `://` or a leading `pipe:`/`concat:`/`data:` protocol prefix, require it to resolve to an existing regular file, and `realpath` it and require containment under an allow-listed root (spec file's directory, or an explicit `--audio-root` flag) — failing closed with a JSON-pointer diagnostic when it does not. If remote sources are ever wanted, they should be an explicit opt-in flag, not the default surface of a free-form string.

**Status:** upheld

### [BLOCK] party-security — A decode that succeeds with empty or truncated PCM produces a green render with a silent one-second scene, indistinguishable from success

**Quotes:**
> The decoded block is stored with `offsetSeconds = padStart` and its scene's measured duration is `padStart + decoded + padEnd`.
> `audio/test/decode.test.ts` (fake spawn: argv shape, stdout → buffer, non-zero exit → `DecodeError`)
> Steps B, D and G need no change beyond the block source; `duration: "auto"` and cross-fade placement come for free.

**Problem:** The only named failure detection is ffmpeg's exit code. ffmpeg exits 0 in cases that yield little or no PCM on stdout — a container whose audio stream is empty, a stream that ends early, a truncated read of `pipe:1`, a source whose audio ffmpeg silently drops. In every such case `decoded ≈ 0`, the scene's `duration: "auto"` resolves to `padStart + padEnd` (1.0 s in the proposal's own example), the timeline compiler places it happily, the mux succeeds, and the render exits 0. The failure mode is a full-length video where one slide flashes past in a second with no voice, and nothing in the design distinguishes that from a correct run. `party-architect`'s NOTE that the only decoder tests compare argv to the same literal the implementation writes reinforces this: the byte-yield of the spawn is nowhere checked, so both the wrong-argv and the empty-stdout cases pass the listed suite.

**Fix:** Treat the decoded length as a checked value, not a measurement: raise `DecodeError` when the decoded buffer is empty or below a floor (e.g. < 0.25 s of PCM at the target rate), and cross-check the decoded sample count against `ffprobe`'s reported stream duration for the same file, failing closed on a mismatch beyond a small tolerance. Add the zero-byte-stdout-with-exit-0 case to `decode.test.ts`.

**Status:** upheld

### [WARN] party-security — `--captions` silently produces a partially-captioned video and still exits green

**Quotes:**
> `insertCaptionsLayers` requires reference text for forced alignment; an external audio scene has none, so `--captions` skips those scenes and prints one warning naming them.
> **`--captions` on a spec with external audio: skip with a warning (proposed) or hard error?**

**Problem:** The operator asked for captions and gets a video where some scenes have none, with a single stderr line as the only signal — buried in a render that already emits ffmpeg output, and with an exit code the proposal does not change. The output artifact is a normal MP4; nothing in it or beside it records that captioning was reduced in scope. For an accessibility feature on academy deliverables headed to YouTube, "quietly did less than asked, reported success" is the failure that gets shipped. `party-architect`'s BLOCK on the same clause raises the stakes: because the artifact does not say whether `insertCaptionsLayers` receives a filtered list or an exclusion set, the skip can also *misalign* captions on the Kokoro scenes that follow — a second silent wrong-output path behind the same green exit code.

**Fix:** Fail closed by default: with `--captions` and any external-audio scene present, error before rendering and name the scenes, with an explicit `--captions-allow-partial` opt-in for the skip behaviour. When the skip does run, exit non-zero or write the skipped scene ids into a machine-readable artifact beside the MP4 so the degradation survives the terminal scrollback.

**Status:** upheld

### [WARN] party-security — The decode spawn has no timeout, no output size cap, and buffers the whole stream in memory

**Quotes:**
> New `decodeAudioFile(src, { sampleRate }, spawnFn)` runs `ffmpeg -i <src> -f s16le -acodec pcm_s16le -ac 1 -ar <sampleRate> pipe:1` and returns `{ audio: Buffer, sampleRate }`
> `packages/cli/src/render-pipeline.ts`: Step A extension, `decodeAudioFn` seam in `RenderPipelineOptions`, captions skip + warning.

**Problem:** The decoder accumulates an unbounded `Buffer` from a subprocess reading a source the spec names. A long or endless input — a large archive-grade file, a `/dev/` character device, or a network stream given finding 1's surface — fills memory or hangs Step A forever with no wall-clock bound. There is no stated timeout, no maximum decoded-seconds limit, and no per-render aggregate cap, so one bad `src` takes down the render process rather than failing that scene. `party-po`'s NOTE on per-render decode cost observes the same unbounded spawn from the cost side; the failure-mode side is that nothing kills it.

**Fix:** Bound the spawn with a kill-after timeout and a maximum decoded byte count (derived from a `maxSceneSeconds` at the fixed 24 kHz rate); on exceeding either, kill the child and raise `DecodeError` naming the limit hit. Stream the PCM to a temp file rather than holding the full buffer if scene lengths are expected to be large.

**Status:** upheld

### [WARN] party-security — The scoped work overwrites the operator's globally installed CLI with no stated rollback

**Quotes:**
> `pnpm build`, `pnpm test`, `pnpm package` and a reinstall of the global `claudevid` from the new tarball so consumers pick the feature up.

**Problem:** This is an effect that leaves the change: the globally installed `claudevid` on the machine is replaced, affecting every other pipeline that shells out to it — including academy video builds unrelated to this feature. The proposal names no version pin, no retention of the prior tarball, and no verification step after install, so if the new build regresses an existing spec the operator has no stated path back to the working binary beyond rebuilding from an unspecified earlier commit. The self-assessed "existing specs parse and render identically" is asserted, not gated by a run against an existing spec. `party-po`'s NOTE proposes the reinstall could trail as a fast-follow, which is a scope argument; it does not supply the missing recovery path, so this stands either way.

**Fix:** State the recovery path in the proposal: keep the prior tarball (or record its exact version) before the global reinstall, and make the rollback command explicit. Gate the reinstall on a smoke render of one pre-existing, audio-free spec producing a duration-identical result to the current global build — narrowest grant being a local `pnpm link` for validation before any global replacement.

**Status:** upheld

### [NOTE] party-security — Rebuttal of party-visionary: deriving the decode rate from the synthesiser's reported rate replaces a fail-closed constant with an input-dependent one

**Quotes:**
> or decode its `audio.src` at **24 000 Hz** — Kokoro's native rate — so `assembleVoiceTrack`'s one-sample-rate rule holds when a spec mixes Kokoro and
>    external scenes.
> 2. **Decode rate: fixed 24 000 Hz, or "adopt the first block's rate"?** Fixed is simpler and
>    matches Kokoro; the only cost is downsampling 44.1 kHz sources, inaudible for speech.

**Problem:** `party-visionary`'s fix — "Derive the decode rate from the synthesiser's reported `sampleRate`" — is sound on the duplication lens but, read as a failure mode, it converts a constant the pipeline controls into a value that depends on what the run happens to contain. A spec with no narration blocks has no synthesiser-reported rate to derive from, and a future backend reporting a different rate makes the external scene's decode rate vary per spec while `assembleVoiceTrack` still enforces one rate across the track — the mismatch surfaces as wrong-pitch or wrong-length audio in a rendered MP4, not as an error. The fixed literal is the fail-closed choice precisely because it cannot be moved by spec content. The duplication objection is legitimate; the remedy should not be to make the rate data-derived.

**Fix:** Keep a single exported constant in `@claudevid/audio` that both the synthesiser and the decoder read (the second half of party-visionary's own fix), and if a synthesised block ever reports a rate other than that constant, raise an error rather than adopting it. That removes the duplication without making the track's sample rate a function of untrusted spec content.

**Status:** upheld

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

## Dissent

_Withdrawn findings. The severity token is prefixed WITHDRAWN so these do not count as live findings._

### [WITHDRAWN BLOCK] party-architect — Adds a second `audio` concept to the same schema while the first is named, kept, and left dead
**Quotes:** > The one field that looks like it should — the top-level `audio.track` in
> `packages/core/src/schema.ts:17` — is declared, exported as `AudioTrack`, and **never read**
> anywhere in `packages/cli` or `packages/audio`. It is a stub.
**Quotes:** > - Implementing or removing the dead top-level `audio.track` (music bed). Separate proposal; noted
>   in Open Questions.
**Quotes:** > - Regenerated `packages/claude/schemas/video-spec.schema.json` and the skill copy.
**Problem:** The proposal identifies an existing declared-and-exported `audio` field, proves it is unreachable, and then adds a *second* field named `audio` — at a different level, with a different shape (`src`/`padStart`/`padEnd` vs `track`) — while explicitly declining to extend or delete the first. The commit ships a regenerated JSON schema and skill copy containing both: one live per-scene `audio` and one inert top-level `audio.track`. That schema is the contract a model authors specs against, so the divergence is not internal cleanup deferred to later — it is published at merge, and Open Question 4 shows the proposal knows it has no answer for which of the two an author should reach for. Either the new capability is the realisation of the field that was already declared for it, or the artifact must say what `AudioTrack`'s shape cannot express, so the two names are not competing in one generated schema.
**Fix:** In this change, either delete `audio.track` from `sceneSchema`'s parent so the regenerated schema has exactly one `audio` contract, or state in the artifact why the declared `AudioTrack` cannot carry per-scene voice and therefore why a second key of the same name is correct.
**Status:** withdrawn — my probe-1 reading was wrong. The artifact does state what the existing field is for, in the Out of Scope line I quoted myself: "the dead top-level `audio.track` (music bed)". A whole-video music bed and a per-scene voice block are not one mechanism built twice — `AudioTrack` sits above the scene array and structurally cannot carry a per-scene contribution to `duration: "auto"`, which is the entire point of the new field. And within my radius, the merge commit diverges nothing: `audio.track` stays exactly as dead as it was, existing specs parse unchanged, no fact gains a second writer. What is left of my objection is that two same-named keys mean different things in one published grammar — which is a naming consequence with no correctness effect at merge, and party-visionary's finding on the permanence of the `audio` key is the durable version of it. I withdraw in their favour rather than hold a BLOCK on a hygiene point.

### [WITHDRAWN WARN] party-security — ffmpeg stderr from an arbitrary source file is placed in a diagnostic that feeds Claude's repair loop

**Quotes:**
> `packages/audio/src/decode.ts` (+ export from `index.ts`): ffmpeg-backed decoder with injectable spawn; `DecodeError` carrying the ffmpeg stderr tail like `MuxError`.
> a `superRefine` issue at `/scenes/N` with a repair suggestion, so the diagnostic reaches Claude's repair loop like every other parse failure.

**Problem:** I joined two mechanisms the artifact keeps separate. The only quoted line placing a diagnostic into the model repair loop describes the `superRefine` *parse* issue; `DecodeError` is described only as an error carrying a stderr tail, with no quoted text routing it to the loop. `party-architect`'s round-1 WARN makes the distinction explicit — it treats parse-time checks as the ones "reaching the repair loop" and decode-time failures as "a `DecodeError` abort" — which is the reading the proposal's own text supports. With no quoted entry point from ffmpeg stderr into model-read context, this is a speculative path, and evidence discipline says drop it rather than hedge it.

**Fix:** n/a — withdrawn.

**Status:** withdrawn — the artifact routes only the `superRefine` parse diagnostic into the repair loop; no quoted line puts `DecodeError`'s stderr tail in front of the model, and `party-architect` reads decode failures as an abort path. No quoted entry point, so the finding does not stand.
