// computeAudioDurations() — the FR5 entry point (spec.md FR5/AC7/AC8, design.md's Technical
// Approach diagram and Key Decision D6). For every scene whose `duration` is `"auto"`, this
// resolves each of the scene's narration blocks into a full `SynthesisRequest`, routes it through
// `cache.ts`'s `getOrSynthesize` (cache-checked, injectable `synthesizeFn` — NFR2), sums the
// measured `durationSeconds` across the scene's blocks, applies configurable head/tail padding,
// and clamps/validates against a configurable minimum and maximum (spec.md FR5).
//
// `NarrationBlock` is intentionally NOT imported by name from `@claudevid/core` — T1 added the
// interface to `packages/core/src/types.ts` but did not add it to `packages/core/src/index.ts`'s
// export list, and this task's scope is limited to `packages/audio`. Instead the element type is
// derived structurally from the already-exported `VideoSpec` type (same "derive from the public
// shape" pattern `packages/core/src/timeline.ts` itself uses for `VideoSpec["scenes"][number]`).
import type { VideoSpec } from "@claudevid/core";

import { getOrSynthesize } from "./cache.js";
import { PINNED_MODEL } from "./models.js";
import { synthesize } from "./tts.js";
import type { AudioDurationsOptions, SynthesisRequest } from "./types.js";

type Scene = VideoSpec["scenes"][number];
type NarrationBlock = NonNullable<Scene["narration"]>[number];

/** Fallback voice used when neither the narration block nor `opts.defaultVoice` specifies one.
 * `af_heart` is a real Kokoro voice id (also used as the fixture voice in cache.test.ts) — picked
 * simply as "a valid, always-available default," not as an endorsement of any particular voice;
 * callers needing a different default should set `opts.defaultVoice` (or per-block `voice`). */
const FALLBACK_VOICE = "af_heart";

/** Fallback speed (Kokoro's own "normal" playback rate) used when neither the narration block nor
 * `opts.defaultSpeed` specifies one. */
const FALLBACK_SPEED = 1;

/** Default padding: zero. Padding is opt-in — a caller who doesn't ask for head/tail silence
 * shouldn't get any added to their computed scene duration. */
const DEFAULT_HEAD_PADDING_SECONDS = 0;
const DEFAULT_TAIL_PADDING_SECONDS = 0;

/** Default minimum: zero, i.e. no floor unless a caller opts in — a computed duration of a
 * fraction of a second is legitimate on its own and shouldn't silently grow unless asked. */
const DEFAULT_MIN_DURATION_SECONDS = 0;

/** Default maximum: a generous 600 seconds (10 minutes) per scene. This is deliberately loose —
 * high enough that no reasonable single-scene narration trips it by accident, while still
 * catching the actual failure mode FR5/AC8 cares about (e.g. a runaway/misconfigured request
 * producing an absurdly long scene) rather than clamping silently (design.md D6: exceeding the
 * ceiling always throws, never clamps). Callers with tighter per-scene budgets set
 * `maxDurationSeconds` explicitly. */
const DEFAULT_MAX_DURATION_SECONDS = 600;

/** Thrown when a `duration: "auto"` scene has no narration blocks to compute a duration from —
 * either `scene.narration` is entirely absent, or present as an empty array (spec.md's Edge
 * Cases: "Narration array is empty on a scene with `duration: \"auto\"` — throws naming the
 * scene"). Both are treated identically: a duration cannot be derived from zero blocks either
 * way. */
export class EmptyNarrationError extends Error {
  constructor(public readonly sceneId: string) {
    super(
      `Scene "${sceneId}" has duration: "auto" but no narration blocks to compute a duration from ` +
        "(scene.narration is missing or empty)",
    );
    this.name = "EmptyNarrationError";
  }
}

/** Thrown when a scene's computed duration (sum of its narration blocks' measured durations plus
 * configured padding) exceeds `maxDurationSeconds` — spec.md FR5/AC8, design.md D6: "Exceeding
 * the maximum throws (naming the scene id and the measured value) rather than silently
 * clamping." Never thrown for falling below `minDurationSeconds` — that case is silently raised
 * to the floor instead (see `computeAudioDurations`). */
export class MaxDurationExceededError extends Error {
  constructor(
    public readonly sceneId: string,
    public readonly computedSeconds: number,
    public readonly maxDurationSeconds: number,
  ) {
    super(
      `Scene "${sceneId}"'s computed audio duration (${computedSeconds}s, including padding) exceeds ` +
        `the configured maximum of ${maxDurationSeconds}s`,
    );
    this.name = "MaxDurationExceededError";
  }
}

/** `computeAudioDurations`'s options: `AudioDurationsOptions`'s padding/min/max (spec.md FR5) plus
 * the runtime seams this function needs but that aren't waveform-affecting fields of
 * `SynthesisRequest` itself.
 *
 * `synthesizeFn` defaults to `tts.ts`'s real (Kokoro-backed) `synthesize` — but tests always pass
 * their own fixture here instead, so nothing in this module's test suite ever triggers real
 * inference (NFR2), mirroring `cache.ts`'s `getOrSynthesize` seam that this function calls
 * underneath. */
export interface ComputeAudioDurationsOptions extends AudioDurationsOptions {
  /** Injected `synthesize`-shaped function (spec.md FR2's seam). Defaults to `tts.ts`'s real
   * Kokoro-backed `synthesize` in production; tests always override this with a fixture. */
  synthesizeFn?: (request: SynthesisRequest) => Promise<{ audio: Buffer; sampleRate: number }>;
  /** Forwarded to `cache.ts`'s `getOrSynthesize` — the project root cache entries resolve under.
   * Test seam so tests never touch this repo's real `.claudevid/cache/`; defaults to
   * `process.cwd()` via `cache-root.ts`'s own default when omitted. */
  projectRoot?: string;
  /** Spec-level default voice, used for any narration block that doesn't set its own `voice`.
   * Falls back to `FALLBACK_VOICE` when neither is set. */
  defaultVoice?: string;
  /** Spec-level default speed, used for any narration block that doesn't set its own `speed`.
   * Falls back to `FALLBACK_SPEED` (1, i.e. normal rate) when neither is set. */
  defaultSpeed?: number;
}

/** Resolves one `NarrationBlock` into a fully-concrete `SynthesisRequest` (spec.md FR3: "every
 * optional field left unresolved by the time it reaches the cache" — none are, here).
 * `modelId`/`modelDigest` come from `models.ts`'s `PINNED_MODEL` (FR6) so every request in this
 * increment is pinned to the one committed model. */
function resolveSynthesisRequest(block: NarrationBlock, opts: ComputeAudioDurationsOptions): SynthesisRequest {
  return {
    text: block.text,
    voice: block.voice ?? opts.defaultVoice ?? FALLBACK_VOICE,
    speed: block.speed ?? opts.defaultSpeed ?? FALLBACK_SPEED,
    modelId: PINNED_MODEL.id,
    modelDigest: PINNED_MODEL.digest,
    lexiconDigest: "",
  };
}

/**
 * Computes a seconds-duration for every scene in `spec.scenes` whose `duration === "auto"` —
 * spec.md FR5, the exact `Record<string, number>` shape `CompileTimelineOptions.audioDurations`
 * already accepts (`packages/core/src/timeline.ts`, unchanged by this task — NFR3/design.md D3).
 *
 * Scenes with a numeric `duration` are simply absent from the returned record (never present with
 * a `0`/placeholder value) — matches core's `MissingAudioDurationError` semantics, which only
 * fires for `"auto"` scenes lacking an entry.
 */
export async function computeAudioDurations(
  spec: VideoSpec,
  opts: ComputeAudioDurationsOptions = {},
): Promise<Record<string, number>> {
  const synthesizeFn = opts.synthesizeFn ?? synthesize;
  const headPaddingSeconds = opts.headPaddingSeconds ?? DEFAULT_HEAD_PADDING_SECONDS;
  const tailPaddingSeconds = opts.tailPaddingSeconds ?? DEFAULT_TAIL_PADDING_SECONDS;
  const minDurationSeconds = opts.minDurationSeconds ?? DEFAULT_MIN_DURATION_SECONDS;
  const maxDurationSeconds = opts.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS;

  const durations: Record<string, number> = {};

  for (const scene of spec.scenes) {
    if (scene.duration !== "auto") continue;

    const blocks = scene.narration;
    if (!blocks || blocks.length === 0) {
      throw new EmptyNarrationError(scene.id);
    }

    let totalSeconds = 0;
    for (const block of blocks) {
      const request = resolveSynthesisRequest(block, opts);
      const { durationSeconds } = await getOrSynthesize(request, synthesizeFn, {
        projectRoot: opts.projectRoot,
      });
      totalSeconds += durationSeconds;
    }

    totalSeconds += headPaddingSeconds + tailPaddingSeconds;

    if (totalSeconds > maxDurationSeconds) {
      // Fail closed (design.md D6): never silently clamp an over-long scene down to the max.
      throw new MaxDurationExceededError(scene.id, totalSeconds, maxDurationSeconds);
    }
    if (totalSeconds < minDurationSeconds) {
      // A floor is not diagnostic-worthy (FR5/design.md D6) — silently raise, no error.
      totalSeconds = minDurationSeconds;
    }

    durations[scene.id] = totalSeconds;
  }

  return durations;
}
