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
