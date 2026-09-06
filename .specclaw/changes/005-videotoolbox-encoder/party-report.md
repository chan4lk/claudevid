# Party Report: 005-videotoolbox-encoder

**Reviewed:** 2026-09-06
**Tier:** standard (classifier) — Introduces a new concurrent encoder package (~20 files, all additive) with complex FFmpeg orchestration, caching, and keyframe alignment; all edits are independently revertible and open questions are implementation details within the scoped architecture.
**Panel:** party-po(sonnet), party-architect(opus), party-ba(sonnet)
**Verdict:** CHANGES_REQUESTED

## Summary

17 findings: 6 BLOCK, 8 WARN, 3 NOTE upheld — 0 withdrawn

## Findings

### [BLOCK] party-architect — FFmpeg argument construction is split across three modules while the design's own correctness invariant requires a single owner
**Quotes:** > - `packages/encoder-ffmpeg/src/profiles.ts` — the profile table above, flag construction
**Quotes:** > `-fps_mode passthrough` so every frame we produce is exactly one frame in the output, bt709 primaries/trc/colorspace tagging, `-pix_fmt yuv420p`, `-movflags +faststart`.
**Quotes:** > - Each chunk starts on a **forced keyframe** (`-force_key_frames 0`, `-g` set to the chunk length) so stream-copy concatenation is lossless and seamless.
**Quotes:** > - Encoder parameters are byte-identical across chunks — any drift makes `concat -c copy` fail or produce a broken stream.
**Problem:** The artifact names `profiles.ts` as the owner of "flag construction", then specifies a second set of flags in the pipe layer (`-fps_mode`, colour tagging, `-pix_fmt`, `-movflags`) and a third set in the chunk layer (`-force_key_frames`, `-g`). Three modules each contribute to one argv. The proposal simultaneously states the invariant that makes chunking work — byte-identical encoder parameters across chunks — which is exactly the invariant that a three-way-split argv builder cannot enforce, because no single component sees the whole command line. The first flag added in `pipe.ts` for the single-pipe path and not mirrored in the chunk path produces a concat failure or a broken stream, which the proposal itself classifies as the highest-risk failure class. No seat's round-1 findings addressed argv ownership; nothing contradicts this.
**Fix:** Name one component that emits the complete argv for a given profile+mode, have `pipe.ts`, `chunk.ts` and `concat.ts` consume it rather than append to it, and state that the chunk path and single-pipe path differ only in inputs, not in flags.
**Status:** upheld

### [BLOCK] party-architect — The chunk cache key omits the encoder parameters the concat invariant depends on
**Quotes:** > A chunk whose input hash (its slice of the timeline + render settings + asset hashes) matches an existing artifact is skipped and reused.
**Quotes:** > - Encoder parameters are byte-identical across chunks — any drift makes `concat -c copy` fail or produce a broken stream.
**Quotes:** > At startup, probe the FFmpeg binary: presence, version, and which of `h264_videotoolbox` / `hevc_videotoolbox` / `prores_ks` / `libx264` are available.
**Problem:** The hash inputs are enumerated exhaustively — timeline slice, render settings, asset hashes — and none of them is the encoder profile, the resolved codec, the bitrate, or the FFmpeg/encoder version that the probe explicitly reads. A resume that hits stale artifacts encoded under a different profile, or by a different FFmpeg build after an upgrade, produces a chunk set that is not byte-identical in encoder parameters, which is the precise condition the proposal says makes `concat -c copy` fail or emit a broken stream. Worse, the failure mode is the silent one: the concat may succeed and the seam be wrong. Two implementers reading "render settings" will disagree about whether encoder flags are inside it. `party-ba`'s round-1 finding that the resume claim has no test is complementary, not overlapping: theirs is that resume is unverified, mine is that the key as enumerated is wrong.
**Fix:** State explicitly that the cache key covers the resolved encoder argv plus the probed FFmpeg/encoder version identity, or state that cached artifacts are invalidated wholesale when the probe result changes.
**Status:** upheld

### [BLOCK] party-architect — Two components are given contradictory lifecycle ownership of the same chunk files
**Quotes:** > - `packages/encoder-ffmpeg/src/cache.ts` — content-addressed chunk artifacts, resume
**Quotes:** > - `packages/encoder-ffmpeg/src/temp.ts` — temp dir lifecycle, cleanup, signal handling
**Quotes:** > **6. Process hygiene.** Deterministic temp directories, guaranteed cleanup on success and failure, cancellation that propagates SIGTERM to every child, and no orphaned FFmpeg processes after a Ctrl-C.
**Quotes:** > - **Where does resume state live?** `.claudevid/cache/` in the project, or a user-level cache?
**Problem:** Chunk artifacts are the output of the encode and the input to resume. `temp.ts` is specified to guarantee cleanup on both success and failure; `cache.ts` is specified to keep those same artifacts so that "iterating on scene 43 of 200 then costs one chunk, not 200". As written, the two modules land in the same commit with opposite mandates over the same files, and the location question is still open, so an implementer has no rule telling them which files are temp and which are cache. The likely outcome is either a resume feature that never hits (cleanup wins) or a leaked artifact directory that process hygiene was written to prevent (cache wins).
**Fix:** Draw the boundary in the artifact: name which paths `temp.ts` owns and deletes unconditionally, name which paths `cache.ts` owns and never deletes on the encode path, and state how a chunk artifact is promoted from one to the other.
**Status:** upheld

### [BLOCK] party-architect — CLI surface is introduced here but the CLI package is neither in scope nor named as a co-change
**Quotes:** > Install FFmpeg with VideoToolbox support or pass --encoder libx264 to silence this."*
**Quotes:** > Plus vertical/short presets (1080×1920) for the `--vertical` flag.
**Quotes:** > **7. Benchmark harness.** `claudevid bench` renders a fixed reference spec and reports ms/frame (p50/p95), render fps, encode fps, cache hit rate and total wall clock
**Quotes:** > - `tools/bench` — reference spec + reported metrics
**Problem:** The proposal introduces at least four user-facing CLI flags (`--encoder`, `--vertical`, `--cpu-encode`, `--concurrency`) and one new subcommand (`claudevid bench`), and its own text places the CLI in a different change ("the CLI's progress bar in change 007"). The In Scope list contains only `packages/encoder-ffmpeg/*` and `tools/bench`; no CLI argument parser, flag registration, or subcommand wiring appears anywhere. A merge of this change as scoped ships an error message instructing the user to pass a flag that does not exist and a benchmark that is reachable only as a tool directory, not as the documented `claudevid bench`. This is a co-change to a caller the artifact never names.
**Fix:** Either enumerate the CLI files that must change in this commit, or state that the encoder exposes these as library options only and that the flags and `bench` subcommand are wired in change 007 — and then remove the flag names from the shipped error text.
**Status:** upheld

### [BLOCK] party-architect — Output resolution gets a second source of truth in the profile table
**Quotes:** > **Depends on:** 001-videospec-core (serializable `Timeline`), 002-canvas-render-engine (`renderFrame` into a reusable buffer).
**Quotes:** > | `preview` | h264_videotoolbox, 720p, low bitrate | fast draft loop (change 007) |
**Quotes:** > Plus vertical/short presets (1080×1920) for the `--vertical` flag.
**Quotes:** > Raw RGBA on stdin with real backpressure (`write()` → `await once(stdin, 'drain')`),
**Problem:** The render engine named as a dependency produces frames into a buffer at some fixed dimension, and a raw-RGBA stdin pipe carries no dimensions at all — FFmpeg must be told the exact `WxH` of the incoming bytes or it misreads every frame. The profile table then independently declares dimensions (720p, 1080×1920), so the artifact now has two places that decide output resolution and no statement of which one wins. The two readings produce different systems: either the encoder scales (a filter chain that the profile table does not mention and that changes the raw-input geometry contract), or the renderer must be reconfigured per profile (a caller co-change into change 002 that is not named). `party-po`'s recommendation to drop the vertical presets would narrow but not remove this: `preview` at 720p alone creates the same two-owner conflict.
**Fix:** State that frame geometry is owned solely by the renderer and that profiles carry codec/bitrate only, or state that profiles drive a scale filter and specify how the raw-input geometry is derived independently of the profile.
**Status:** upheld

### [WARN] party-architect — The progress-event contract is defined for one FFmpeg process and consumed under N
**Quotes:** > stderr is *parsed* — `frame=`, `fps=`, `speed=`, `time=` become typed progress events for the CLI's progress bar in change 007
**Quotes:** > Split the `Timeline` at scene boundaries into chunks of a target duration, render and encode each chunk concurrently in a `worker_threads` pool sized to the machine's performance cores
**Quotes:** > - **Default: chunked or single-pipe?** Chunking is faster but adds seam and disk risk.
**Problem:** The progress contract is specified in terms of a single FFmpeg stderr stream, but the chunked path has one such stream per worker, and the artifact leaves the choice between the two paths open. Change 007 is a separate consumer of this event type, so two implementers must agree on it: does a `frame=` event carry a chunk-local or timeline-global frame index, does `fps=` aggregate across workers, is `time=` a chunk offset or a timeline position? Every answer is defensible from the text, and the consumer is in another change, which is exactly the case where an under-specified shared contract diverges.
**Fix:** Specify the progress event shape once, in timeline-global terms, including which fields are aggregated across workers and what the single-pipe path emits for the fields that only exist under chunking.
**Status:** upheld

### [WARN] party-architect — Every named test requires a live FFmpeg with specific encoders and no stub seam is named
**Quotes:** > - Tests: round-trip colour fidelity (known colour in → same colour out), concat seam frame-hash continuity, frame-count exactness, cancellation leaves no child processes
**Quotes:** > - **Non-macOS behaviour.** Do we support Linux/CI as a first-class fallback (libx264) or declare it best-effort? CI needs *something* that works for the tests above to run at all.
**Quotes:** > **Risk:** high — the highest-risk change in the set. Concat seams, colour management, and cross-machine FFmpeg variance are all classes of bug that produce output which *looks* fine in a spot check and is wrong in ways viewers notice.
**Problem:** Three separate modules in the scope list spawn FFmpeg (`probe.ts`, `pipe.ts`, `concat.ts`) and none is named as an injectable process seam. `party-po` argues correctly that colour fidelity, concat-seam continuity and cancellation cannot be mocked without losing the property under test, and I accept that for those three — that half of my fix is conceded. What survives, and is the load-bearing half, is that the parts which are pure logic and *could* be tested with no FFmpeg present — chunk boundary selection against transition spans, GOP/keyframe arithmetic, argv construction per profile, cache-key derivation, stderr line parsing — are not listed as having tests at all, and the artifact concedes CI may have no viable encoder, so the integration-only list becomes conditionally skipped and those components ship untested.
**Fix:** Add unit-level tests for splitter boundaries, argv construction, cache-key derivation and stderr parsing that run with no FFmpeg binary present, and name a stub seam for `probe.ts` specifically so capability-dependent branches are exercisable off-macOS.
**Status:** upheld

### [WARN] party-architect — The capability probe does not cover the codecs the profile table requires, and the fallback mapping is unspecified
**Quotes:** > probe the FFmpeg binary: presence, version, and which of `h264_videotoolbox` / `hevc_videotoolbox` / `prores_ks` / `libx264` are available. Return a typed `EncoderCapabilities`.
**Quotes:** > | `web` | VP9/WebM (CPU) | web embed |
**Quotes:** > A missing VideoToolbox encoder produces *"h264_videotoolbox not available on this machine; falling back to libx264 (slower)."*
**Problem:** The probe enumerates exactly four encoders; the profile table names five codecs, and VP9 is not among the probed set, so the `web` profile has no capability check and fails at spawn time with the raw FFmpeg error the probe exists to prevent. Separately, the fallback rule is stated only for `h264_videotoolbox → libx264`; the table's `hevc`, `master` and `web` profiles have no stated fallback, so an implementer must invent whether an unavailable `prores_ks` is a hard error or a substitution. Two components share this — the probe produces `EncoderCapabilities` and the profile resolver consumes it — and the mapping between them is the contract that is missing. `party-po`'s proposal to drop `hevc`/`master`/`web` would moot the VP9 half if adopted, but the derivation defect (a hand-written probe list that can silently drift from the profile table) survives any profile-set size.
**Fix:** Make the probed encoder set derive from the profile table rather than being a separate hand-written list, and specify per profile whether an unavailable codec falls back and to what, or errors.
**Status:** upheld

### [NOTE] party-architect — Rebuttal to party-po's BLOCK: chunking cannot be cut cleanly because the artifact couples resume and the bench's own metric to it
**Quotes:** > Bench the single-pipe path first (the harness in item 7 already exists to do exactly this); gate the chunking/pool/concat/resume scope on that number failing to clear the primary (<15min) target, not the aggressive one.
**Quotes:** > A chunk whose input hash (its slice of the timeline + render settings + asset hashes) matches an existing artifact is skipped and reused.
**Quotes:** > **7. Benchmark harness.** `claudevid bench` renders a fixed reference spec and reports ms/frame (p50/p95), render fps, encode fps, cache hit rate and total wall clock
**Quotes:** > 5. **Nothing is resumable.** Changing scene 43 of 200 re-renders all 200.
**Problem:** Stating the coupling fact only, not a release order, which is `party-po`'s call. The proposal's resume unit is the chunk — "a chunk whose input hash... is skipped and reused" — so `cache.ts` has no addressable artifact without `chunk.ts` and `concat.ts`. Grouping "chunking/pool/concat/resume" as one gated block therefore also gates problem #5, which is presented as an independent problem with an independent fix, not as a consequence of the speed target. Separately, the harness named as the instrument for the gate itself reports "cache hit rate", a metric that is identically zero and meaningless without the chunk cache the gate would defer. If `party-po`'s cut is taken, the artifact needs to say that problem #5 goes unaddressed in the gated variant and that the bench metric set shrinks accordingly; otherwise the gate silently redefines what the change delivers.
**Fix:** If the scope is gated, state in the artifact that chunk-level resume and the `cache hit rate` bench metric are inside the gated block, so the deferral of problem #5 is explicit rather than incidental.
**Status:** upheld

### [WARN] party-ba — "Invisible failures" is named as problem #2 but no acceptance criterion tests actionable error output
**Quotes:**
> **FFmpeg failures are invisible.** The sample pipes stderr to `console.error` and rejects on
>   non-zero exit. In reality FFmpeg exits non-zero for a dozen distinct reasons, and the user
>   sees a wall of banner text plus `FFmpeg exited with code 1`. If VideoToolbox is unavailable
>   — which happens on CI, in Docker, on Intel Macs, on Linux — the user is told nothing useful.
> Tests: round-trip colour fidelity (known colour in → same colour out), concat seam frame-hash
>   continuity, frame-count exactness, cancellation leaves no child processes

**Problem:** Problem #2 is presented as one of five things that "break in practice" and the solution promises a specific fix ("h264_videotoolbox not available on this machine; falling back to libx264... Install FFmpeg with VideoToolbox support or pass --encoder libx264 to silence this."). The enumerated Tests list contains four items and none of them verify that a missing-encoder or non-zero-exit scenario produces the promised actionable message rather than a raw exit code. A criterion that isn't stated can't fail at ship time — the proposal's stated problem-fix for #2 is unverified.
**Fix:** Add a test (or explicit acceptance criterion) that asserts capability-probe failure paths and non-zero FFmpeg exits surface the typed `EncodeError` message, not just exit code + banner text.
**Status:** upheld

### [WARN] party-ba — Resume claim ("costs one chunk, not 200") has no matching test; bench's "cache hit rate" has no pass/fail threshold
**Quotes:**
> **Nothing is resumable.** Changing scene 43 of 200 re-renders all 200.
> A chunk whose input hash (its slice of the timeline + render settings + asset hashes) matches an
>   existing artifact is skipped and reused. Iterating on scene 43 of 200 then costs one chunk, not
>   200. This is what makes the library usable for real editing loops rather than one-shot generation.
> `claudevid bench` renders a fixed reference spec and reports ms/frame (p50/p95), render fps, encode fps, cache hit rate and total wall clock, against the doc's stated
>   targets (<15 / <10 / <5 minutes for 30-minute 1080p30).

**Problem:** This is called out as "what makes the library usable" — a headline claim — yet the Tests list (round-trip colour fidelity, concat seam, frame-count exactness, cancellation) contains no test that a single-scene edit re-renders exactly one chunk. The bench harness reports "cache hit rate" as a number but states a pass/fail target only for wall-clock time (<15/<10/<5 min); cache hit rate is reported with no threshold it must clear. A metric with no threshold cannot fail, so the resume claim is unverified at ship time.
**Fix:** Add a falsifiable test: edit one scene of an N-scene timeline, assert exactly one chunk is re-rendered/re-encoded, and either add a target cache-hit-rate threshold to the bench harness or drop the implication that it functions as an acceptance gate.
**Status:** upheld

### [WARN] party-ba — Output quality for the stated target use case (code walkthroughs) has no acceptance criterion; only speed is gated
**Quotes:**
> `h264_videotoolbox` is meaningfully worse than `libx264` at equal
>   bitrate, and crisp text and code on flat backgrounds is the worst case for it — ringing around
>   glyph edges is exactly what a code walkthrough shows.
> The performance claim in this project is
>   load-bearing; it should be a number in CI, not a sentence in a README.

**Problem:** The proposal's own Open Questions section identifies visual quality (ringing/artifacts on text) as a known risk specifically for the primary content type this tool targets ("a code walkthrough"). Yet the only quantified, CI-gated claim is speed ("<15/<10/<5 minutes"), and the listed Tests check colour fidelity of a "known colour in → same colour out" round trip — a hue/tagging check, not a compression-artifact or perceptual-quality check. If this ships and the speed targets pass, the proposal's success criteria are satisfied while the risk it names as most relevant to its own target use case remains completely unverified.
**Fix:** Either add a falsifiable quality gate (e.g., SSIM/PSNR floor on a text-heavy reference clip, or a documented manual sign-off gate before ship) or state explicitly that quality is out of scope for acceptance at this stage.
**Status:** upheld

### [NOTE] party-ba — "a dozen distinct reasons" is an unsourced quantity
**Quotes:**
> In reality FFmpeg exits non-zero for a dozen distinct reasons, and the user
>   sees a wall of banner text plus `FFmpeg exited with code 1`.

**Problem:** This specific count is asserted with no citation (no link to FFmpeg's error taxonomy, no enumeration). It's plausible and not obviously wrong, and it isn't the sole justification for the capability-probe work (the missing-VideoToolbox scenario carries most of the weight), so it's low-stakes — but it is a bare number used as color/justification for engineering effort, and a reader can't check it.
**Fix:** Either cite a source/enumeration or soften to a qualitative claim ("FFmpeg's exit reasons are not self-explanatory").
**Status:** upheld

### [BLOCK] party-po — Parallel chunking/pool/concat/resume infrastructure is priced only against the aggressive target, never checked against whether the base target needs it at all
**Quotes:**
> An M3 has multiple performance cores; a single render loop uses one. The doc identifies parallel scene rendering + `concat` as the fix and does not build it — and it is the difference between the "under 15 minutes" target and the "under 5 minutes" aggressive target for a 30-minute video.
> **3. Parallel scene-chunk rendering — the speedup.**
> The correctness conditions, which are the actual work:
> **Risk:** high — the highest-risk change in the set. Concat seams, colour management, and cross-machine FFmpeg variance are all classes of bug that produce output which *looks* fine in a spot check and is wrong in ways viewers notice.
**Problem:** Four of the eight source files (`chunk.ts`, `pool.ts`, `concat.ts`, `cache.ts`) plus the transition-aware splitting, GOP alignment, per-worker memory ceiling, and concat-seam verification logic exist to move the result from "under 15 minutes" (the primary target) to "under 5 minutes" (the aggressive target). The proposal never states what wall-clock a corrected single-pipe encoder (item 2: `-fps_mode passthrough`, proper backpressure, correct tagging — no chunking) would achieve for the reference 30-minute video, so it is impossible to tell whether the primary target is already met without any of the highest-risk scope in the change. The cheapest variant — ship the single-pipe fix, measure it against the doc's own bench harness, and only build chunking/pool/concat/resume if the primary target isn't met — is never considered; instead the entire apparatus ships in v1 regardless of whether it's load-bearing. Nothing in either other seat's round-1 findings addresses whether this scope is load-bearing at the stated primary target — architect's findings assume the chunking layer ships and critique its internal contracts, which does not bear on whether it should ship at all in v1.
**Fix:** Bench the single-pipe path first (the harness in item 7 already exists to do exactly this); gate the chunking/pool/concat/resume scope on that number failing to clear the primary (<15min) target, not the aggressive one.
**Status:** upheld

### [WARN] party-po — Output profile matrix has no per-profile value justification beyond the two named in the Problem section
**Quotes:**
> | `hevc` | hevc_videotoolbox | smaller files, 4K delivery |
> | `master` | prores_ks profile 3 (422 HQ) | editing intermediate |
> | `web` | VP9/WebM (CPU) | web embed |
> Plus vertical/short presets (1080×1920) for the `--vertical` flag.
**Problem:** Nothing in the Problem section names 4K delivery, ProRes editing-intermediate workflows, or WebM web embedding as a stated failure mode or requirement — only `preview` and `final` map back to the doc's stated targets and change 007's progress bar. `hevc`, `master`, and `web` (plus the vertical/short cross-product, doubling the matrix) are additive profiles bundled in because the profile table exists and it's tidy to fill it out, not because a cost was named for omitting them. Architect's round-1 finding on this same table (probe coverage gap for `web`'s VP9 codec) reinforces rather than contradicts this: the unjustified profile is also the one whose capability contract is incomplete, which is exactly the signature of scope added without anyone pricing its edges.
**Fix:** Ship `preview`/`final` (the two with stated value) in this change; move `hevc`/`master`/`web`/vertical presets to a follow-on once a caller actually needs them.
**Status:** upheld

### [NOTE] party-po — Benchmark harness and the extra profile set are a cut line the proposal doesn't name
**Quotes:**
> **7. Benchmark harness.** `claudevid bench` renders a fixed reference spec and reports ms/frame (p50/p95), render fps, encode fps, cache hit rate and total wall clock, against the doc's stated targets (<15 / <10 / <5 minutes for 30-minute 1080p30).
> `packages/encoder-ffmpeg/src/profiles.ts` — the profile table above, flag construction
**Problem:** `tools/bench` and the three unjustified profiles (`hevc`, `master`, `web`) are each independently useful and independently shippable — the bench harness validates the core pipe/chunk work regardless of profile count, and the extra profiles are pure additive config once `profiles.ts` exists. The proposal lists them as one undifferentiated in-scope block rather than naming them as a line that could ship after the core probe/pipe/chunk/cache work lands and is validated.
**Fix:** Name the cut explicitly: core (probe, pipe, chunk, pool, concat, cache, temp, preview/final profiles, bench) vs. follow-on (hevc/master/web profiles, vertical presets).
**Status:** upheld

### [WARN] party-po — Test suite's recurring CI cost is unstated for a suite that necessarily runs real FFmpeg encodes
**Quotes:**
> Tests: round-trip colour fidelity (known colour in → same colour out), concat seam frame-hash continuity, frame-count exactness, cancellation leaves no child processes
> **Complexity:** large
**Problem:** These tests require actually invoking FFmpeg (colour fidelity needs a real encode/decode round trip, concat seam continuity needs a real chunked render + join, cancellation needs a real spawned child to kill) — they cannot be mocked without losing the property being tested. Combined with the benchmark harness rendering a "fixed reference spec" against multi-minute targets, this is real CPU/wall-clock cost on every CI run. The proposal states file count (~20) and a qualitative complexity label ("large") but no CI-minutes number for a suite that, by its own admission, must run non-trivial encodes to be meaningful. Architect's round-1 finding on this same test list (no injectable spawn seam, so CI may have no viable encoder at all) is a structural finding about testability, distinct from this one: even if a spawn seam existed, the encode-dependent tests that *do* run still carry an unstated wall-clock cost, and that cost is what this finding prices.
**Fix:** State an expected CI wall-clock budget for the test suite (e.g., "bench excluded from PR CI, run nightly"; "encode tests capped at N seconds each via short reference clips").
**Status:** upheld

## Dissent

No withdrawals.
