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
