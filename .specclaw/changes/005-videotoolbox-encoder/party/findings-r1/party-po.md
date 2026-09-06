### [BLOCK] party-po — Parallel chunking/pool/concat/resume infrastructure is priced only against the aggressive target, never checked against whether the base target needs it at all
**Quotes:**
> An M3 has multiple performance cores; a single render loop uses one. The doc identifies parallel scene rendering + `concat` as the fix and does not build it — and it is the difference between the "under 15 minutes" target and the "under 5 minutes" aggressive target for a 30-minute video.
> **3. Parallel scene-chunk rendering — the speedup.**
> The correctness conditions, which are the actual work:
> **Risk:** high — the highest-risk change in the set. Concat seams, colour management, and cross-machine FFmpeg variance are all classes of bug that produce output which *looks* fine in a spot check and is wrong in ways viewers notice.
**Problem:** Four of the eight source files (`chunk.ts`, `pool.ts`, `concat.ts`, `cache.ts`) plus the transition-aware splitting, GOP alignment, per-worker memory ceiling, and concat-seam verification logic exist to move the result from "under 15 minutes" (the primary target) to "under 5 minutes" (the aggressive target). The proposal never states what wall-clock a corrected single-pipe encoder (item 2: `-fps_mode passthrough`, proper backpressure, correct tagging — no chunking) would achieve for the reference 30-minute video, so it is impossible to tell whether the primary target is already met without any of the highest-risk scope in the change. The cheapest variant — ship the single-pipe fix, measure it against the doc's own bench harness, and only build chunking/pool/concat/resume if the primary target isn't met — is never considered; instead the entire apparatus ships in v1 regardless of whether it's load-bearing.
**Fix:** Bench the single-pipe path first (the harness in item 7 already exists to do exactly this); gate the chunking/pool/concat/resume scope on that number failing to clear the primary (<15min) target, not the aggressive one.
**Status:** upheld

### [WARN] party-po — Output profile matrix has no per-profile value justification beyond the two named in the Problem section
**Quotes:**
> | `hevc` | hevc_videotoolbox | smaller files, 4K delivery |
> | `master` | prores_ks profile 3 (422 HQ) | editing intermediate |
> | `web` | VP9/WebM (CPU) | web embed |
> Plus vertical/short presets (1080×1920) for the `--vertical` flag.
**Problem:** Nothing in the Problem section names 4K delivery, ProRes editing-intermediate workflows, or WebM web embedding as a stated failure mode or requirement — only `preview` and `final` map back to the doc's stated targets and change 007's progress bar. `hevc`, `master`, and `web` (plus the vertical/short cross-product, doubling the matrix) are additive profiles bundled in because the profile table exists and it's tidy to fill it out, not because a cost was named for omitting them.
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
**Problem:** These tests require actually invoking FFmpeg (colour fidelity needs a real encode/decode round trip, concat seam continuity needs a real chunked render + join, cancellation needs a real spawned child to kill) — they cannot be mocked without losing the property being tested. Combined with the benchmark harness rendering a "fixed reference spec" against multi-minute targets, this is real CPU/wall-clock cost on every CI run. The proposal states file count (~20) and a qualitative complexity label ("large") but no CI-minutes number for a suite that, by its own admission, must run non-trivial encodes to be meaningful.
**Fix:** State an expected CI wall-clock budget for the test suite (e.g., "bench excluded from PR CI, run nightly"; "encode tests capped at N seconds each via short reference clips").
**Status:** upheld
