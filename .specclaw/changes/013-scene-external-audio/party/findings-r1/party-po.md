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
