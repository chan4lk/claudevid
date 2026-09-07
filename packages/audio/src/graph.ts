// Argv-safe FFmpeg audio filter graph (spec.md FR7, AC6/AC7, design.md D5, Key Decision D5).
// Mirrors `packages/encoder-ffmpeg/src/argv.ts` exactly: `buildAudioGraphArgv` is pure and
// branchless-in-spirit (same input -> same argv array, no I/O, no wall-clock/random dependency),
// and it is the sole owner of the filter-graph string it builds. Every numeric parameter is
// validated against an explicit range BEFORE it is formatted into any string (never clamped
// silently); every `filePath` becomes its own standalone `-i` argv element and is NEVER
// substituted into the `-filter_complex` string — that string only ever references inputs by
// bracketed index (`[0:a]`, `[1:a]`, ...) plus validated numbers. This is the concrete security
// property AC6 checks structurally (no raw path ever appears as a substring of the filter
// string).
//
// FFmpeg binary/capability resolution reuses `packages/encoder-ffmpeg`'s own `probe()` (FR7's "no
// second binary-resolution implementation") rather than re-implementing PATH/version detection
// here — `resolveFfmpegCapabilities` below is a thin re-export/wrapper, not a new probe.

import { probe, type EncoderCapabilities } from "@claudevid/encoder-ffmpeg";

/** One media input to the audio graph (spec.md FR7). `filePath` is the caller's job to have
 * already resolved against a safe root (this function never sanitizes it as a path) — the
 * contract this module upholds is narrower and absolute: `filePath` is never concatenated into
 * the filter-graph string, full stop; it only ever appears as its own `-i` argv element. */
export interface AudioTrack {
  filePath: string;
  /** Gain applied via the `volume=` filter, in dB. Range: [-60, 20]. */
  gainDb?: number;
  /** Fade-in duration in seconds, via `afade=t=in:...`. Range: [0, 30]. */
  fadeInSeconds?: number;
  /** Fade-out duration in seconds, via `afade=t=out:...`. Range: [0, 30]. Must not exceed
   * `outputDurationSeconds` (a fade-out starting before the track begins is not meaningful). */
  fadeOutSeconds?: number;
  /** Loop-to-length (music beds): the input is repeated via `aloop` before being trimmed to
   * `outputDurationSeconds`, rather than leaving trailing silence. */
  loop?: boolean;
  /** This track ducks under the graph's `role: "voice"` track(s) via `sidechaincompress`.
   * Meaningful only when `role !== "voice"`; ignored for `role === "voice"` tracks. */
  duck?: boolean;
  role: "voice" | "music" | "sfx";
}

export interface AudioGraphOptions {
  tracks: AudioTrack[];
  /** Target output length in seconds — every track is trimmed (and, if `loop`, looped first) to
   * this length so the mix is a single coherent duration. Range: (0, 86400]. */
  outputDurationSeconds: number;
  /** EBU R128 integrated loudness target fed to `loudnorm=I=...` (spec.md FR7). Defaults to -14
   * LUFS. Range: [-70, -5]. */
  loudnormTargetLufs?: number;
}

/** Thrown by `buildAudioGraphArgv` when a numeric parameter is out of its declared range, or when
 * the track set is structurally invalid (e.g. a `duck: true` track with no `role: "voice"` track
 * to duck against). Always names the specific field/track/value involved — never a bare "invalid
 * input" message (mirrors this repo's `EncodeError`/`AlignmentValidationError` convention of
 * naming the exact violated check). Never clamps a value into range; always rejects instead. */
export class AudioGraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioGraphValidationError";
  }
}

interface NumericRange {
  min: number;
  max: number;
}

const GAIN_DB_RANGE: NumericRange = { min: -60, max: 20 };
const FADE_SECONDS_RANGE: NumericRange = { min: 0, max: 30 };
const OUTPUT_DURATION_RANGE: NumericRange = { min: 0.001, max: 86400 };
const LOUDNORM_LUFS_RANGE: NumericRange = { min: -70, max: -5 };

/** Validates `value` against `range`, throwing `AudioGraphValidationError` naming `label` and the
 * offending value on failure. Never clamps — every caller below relies on this throwing rather
 * than silently substituting an in-range value (spec.md FR7's "rejecting out-of-range values
 * rather than clamping"). */
function assertInRange(value: number, range: NumericRange, label: string): void {
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    throw new AudioGraphValidationError(
      `${label}=${value} is out of its declared range [${range.min}, ${range.max}]`,
    );
  }
}

/** Builds one track's per-input filter chain (trim/loop/gain/fades), returning the filter-graph
 * fragment (`[<index>:a]...[t<index>]`) and the label it produced. Every number substituted here
 * has already passed `assertInRange` in `buildAudioGraphArgv` — this function never re-validates,
 * it only formats already-validated values into filter syntax. */
function buildTrackChain(track: AudioTrack, index: number, outputDurationSeconds: number): { label: string; fragment: string } {
  const stages: string[] = [];

  // Loop-to-length (music beds, spec.md FR7): repeat indefinitely via `aloop`, then let the
  // `atrim` below cut it down to exactly `outputDurationSeconds`.
  if (track.loop) {
    stages.push("aloop=loop=-1:size=2147483647");
  }

  // Trim (every track, not just looped ones) so the mix is a single coherent duration regardless
  // of how long the source file actually is.
  stages.push(`atrim=0:${outputDurationSeconds}`);
  // Reset PTS after atrim/aloop so downstream `amix` sees timestamps starting at (near) zero —
  // otherwise a trimmed/looped stream's original PTS offset would misalign the mix.
  stages.push("asetpts=PTS-STARTPTS");

  if (track.gainDb !== undefined) {
    stages.push(`volume=${track.gainDb}dB`);
  }
  if (track.fadeInSeconds !== undefined && track.fadeInSeconds > 0) {
    stages.push(`afade=t=in:d=${track.fadeInSeconds}`);
  }
  if (track.fadeOutSeconds !== undefined && track.fadeOutSeconds > 0) {
    const start = outputDurationSeconds - track.fadeOutSeconds;
    stages.push(`afade=t=out:st=${start}:d=${track.fadeOutSeconds}`);
  }

  const label = `t${index}`;
  return { label, fragment: `[${index}:a]${stages.join(",")}[${label}]` };
}

/**
 * Builds the complete argv array for an FFmpeg invocation that composes `opts.tracks` into a
 * single mixed-down audio stream (spec.md FR7). Pure: no I/O, no spawning — this function only
 * ever returns a `string[]`, it never runs FFmpeg (that is T8/`mux.ts`'s job).
 *
 * Structural invariant (AC6): every `track.filePath` is emitted as its own standalone `-i` argv
 * element; the `-filter_complex` string references inputs ONLY via `[<index>:a]` and contains
 * numbers formatted from already-range-checked fields, never a raw file path substring.
 *
 * Stages, in order per track: loop-to-length (music only, `aloop`) -> trim to
 * `outputDurationSeconds` (`atrim`) -> gain (`volume=`) -> fade in/out (`afade=`). Then, for every
 * `role !== "voice"` track with `duck: true`, a `sidechaincompress` stage ducks it under the
 * first `role: "voice"` track. Finally every track's (possibly ducked) output is combined via
 * `amix=`, then loudness-normalized via `loudnorm=I=<target>:TP=-1.5:LRA=11`.
 */
export function buildAudioGraphArgv(opts: AudioGraphOptions): string[] {
  const { tracks, outputDurationSeconds } = opts;
  const loudnormTargetLufs = opts.loudnormTargetLufs ?? -14;

  assertInRange(outputDurationSeconds, OUTPUT_DURATION_RANGE, "outputDurationSeconds");
  assertInRange(loudnormTargetLufs, LOUDNORM_LUFS_RANGE, "loudnormTargetLufs");

  if (tracks.length === 0) {
    throw new AudioGraphValidationError("tracks must contain at least one entry");
  }

  tracks.forEach((track, index) => {
    if (track.gainDb !== undefined) {
      assertInRange(track.gainDb, GAIN_DB_RANGE, `tracks[${index}].gainDb`);
    }
    if (track.fadeInSeconds !== undefined) {
      assertInRange(track.fadeInSeconds, FADE_SECONDS_RANGE, `tracks[${index}].fadeInSeconds`);
    }
    if (track.fadeOutSeconds !== undefined) {
      assertInRange(track.fadeOutSeconds, FADE_SECONDS_RANGE, `tracks[${index}].fadeOutSeconds`);
      if (track.fadeOutSeconds > outputDurationSeconds) {
        throw new AudioGraphValidationError(
          `tracks[${index}].fadeOutSeconds=${track.fadeOutSeconds} exceeds ` +
            `outputDurationSeconds=${outputDurationSeconds}`,
        );
      }
    }
  });

  const voiceIndex = tracks.findIndex((track) => track.role === "voice");
  const duckIndices = tracks
    .map((track, index) => (track.role !== "voice" && track.duck ? index : -1))
    .filter((index) => index >= 0);
  if (duckIndices.length > 0 && voiceIndex === -1) {
    throw new AudioGraphValidationError(
      'one or more tracks have duck: true but no track with role "voice" is present to duck against',
    );
  }

  const inputArgs: string[] = [];
  for (const track of tracks) {
    inputArgs.push("-i", track.filePath);
  }

  const filterParts: string[] = [];
  const preLabels: string[] = [];
  tracks.forEach((track, index) => {
    const { label, fragment } = buildTrackChain(track, index, outputDurationSeconds);
    filterParts.push(fragment);
    preLabels.push(label);
  });

  const finalLabels = [...preLabels];
  if (voiceIndex !== -1) {
    for (const duckIndex of duckIndices) {
      const duckedLabel = `d${duckIndex}`;
      filterParts.push(
        `[${preLabels[duckIndex]}][${preLabels[voiceIndex]}]` +
          `sidechaincompress=threshold=0.02:ratio=20:attack=5:release=250[${duckedLabel}]`,
      );
      finalLabels[duckIndex] = duckedLabel;
    }
  }

  const mixInputs = finalLabels.map((label) => `[${label}]`).join("");
  filterParts.push(`${mixInputs}amix=inputs=${finalLabels.length}:duration=longest:dropout_transition=2[mix]`);
  filterParts.push(`[mix]loudnorm=I=${loudnormTargetLufs}:TP=-1.5:LRA=11[out]`);

  const filterComplex = filterParts.join(";");

  return [...inputArgs, "-filter_complex", filterComplex, "-map", "[out]"];
}

/** Resolves FFmpeg binary presence/capabilities via `packages/encoder-ffmpeg`'s own `probe()`
 * (spec.md FR7, design.md D5) — `graph.ts` deliberately implements no binary-resolution logic of
 * its own; this is a thin pass-through so callers in this package (and T8's `mux.ts`) have a
 * single, obvious entry point without importing `@claudevid/encoder-ffmpeg` directly themselves. */
export async function resolveFfmpegCapabilities(): Promise<EncoderCapabilities> {
  return probe();
}
