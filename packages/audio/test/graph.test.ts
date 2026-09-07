// Tests for graph.ts (spec.md FR7, AC6/AC7, design.md D5).
//
// AC6 (structural, no real FFmpeg needed): every numeric parameter is validated against its
// declared range before use; every track's `filePath` is emitted as its own standalone argv
// element; the constructed `-filter_complex` string never contains a raw file path substring —
// this is the actual security property FR7 exists for, so it is asserted explicitly, including
// against a deliberately "hostile-looking" path (containing filter-syntax metacharacters like
// `[`, `]`, `;`, `:`) to demonstrate the property holds regardless of what the path contains.
//
// AC7 (ducking, real level check): gated behind a real FFmpeg binary, mirroring
// `packages/encoder-ffmpeg/test/pipe.live.test.ts`'s "probe a real capability once, up front, and
// skip gracefully rather than fail the build if it's unavailable" pattern. Synthesizes a voice
// fixture (a tone active only during a middle window) and a music fixture (a constant tone for
// the whole duration), builds the real `buildAudioGraphArgv` filter graph with the music track
// `duck: true`, and measures the *music track's own* post-processing level (not the final mixed
// output) via FFmpeg's `volumedetect`, comparing a pre-voice window against a during-voice window
// — this isolates the ducking effect from the unrelated (and expected) fact that a mixed-down
// output is louder whenever more sources are simultaneously active. `loudnorm`'s own dynamic gain
// smoothing was measured (during test development) to significantly re-flatten the *final* mixed
// output's level even when the pre-loudnorm `sidechaincompress` stage is working correctly, so
// this test measures at the `mix`-stage's per-track intermediate label instead of the graph's
// final `[out]` — still the real, unmodified `filter_complex` string `buildAudioGraphArgv`
// produces, just mapping a different (also real, always-present) intermediate node for
// measurement purposes.

import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { AudioGraphValidationError, buildAudioGraphArgv, type AudioTrack } from "../src/graph.js";

const execFileAsync = promisify(execFile);

describe("buildAudioGraphArgv (AC6) — range validation", () => {
  const baseTracks = (overrides: Partial<AudioTrack> = {}): AudioTrack[] => [
    { filePath: "/media/voice.wav", role: "voice", ...overrides },
  ];

  it("throws naming the track index/field/value for an out-of-range gainDb", () => {
    expect(() =>
      buildAudioGraphArgv({ tracks: baseTracks({ gainDb: 100 }), outputDurationSeconds: 10 }),
    ).toThrow(AudioGraphValidationError);
    expect(() =>
      buildAudioGraphArgv({ tracks: baseTracks({ gainDb: 100 }), outputDurationSeconds: 10 }),
    ).toThrow(/tracks\[0\]\.gainDb=100/);
  });

  it("throws for a below-range gainDb", () => {
    expect(() =>
      buildAudioGraphArgv({ tracks: baseTracks({ gainDb: -61 }), outputDurationSeconds: 10 }),
    ).toThrow(/tracks\[0\]\.gainDb=-61/);
  });

  it("throws for an out-of-range fadeInSeconds", () => {
    expect(() =>
      buildAudioGraphArgv({ tracks: baseTracks({ fadeInSeconds: 31 }), outputDurationSeconds: 10 }),
    ).toThrow(/tracks\[0\]\.fadeInSeconds=31/);
  });

  it("throws for an out-of-range fadeOutSeconds", () => {
    expect(() =>
      buildAudioGraphArgv({ tracks: baseTracks({ fadeOutSeconds: -1 }), outputDurationSeconds: 10 }),
    ).toThrow(/tracks\[0\]\.fadeOutSeconds=-1/);
  });

  it("throws when fadeOutSeconds exceeds outputDurationSeconds, naming both values", () => {
    expect(() =>
      buildAudioGraphArgv({ tracks: baseTracks({ fadeOutSeconds: 8 }), outputDurationSeconds: 5 }),
    ).toThrow(/fadeOutSeconds=8 exceeds outputDurationSeconds=5/);
  });

  it("throws for an out-of-range outputDurationSeconds", () => {
    expect(() => buildAudioGraphArgv({ tracks: baseTracks(), outputDurationSeconds: 0 })).toThrow(
      AudioGraphValidationError,
    );
    expect(() => buildAudioGraphArgv({ tracks: baseTracks(), outputDurationSeconds: -5 })).toThrow(
      AudioGraphValidationError,
    );
  });

  it("throws for an out-of-range loudnormTargetLufs", () => {
    expect(() =>
      buildAudioGraphArgv({ tracks: baseTracks(), outputDurationSeconds: 10, loudnormTargetLufs: 0 }),
    ).toThrow(/loudnormTargetLufs=0/);
  });

  it("never clamps: values are rejected, not silently substituted", () => {
    // A single call either throws or returns a graph built from the exact input numbers — there
    // is no code path that returns a "corrected" argv for an out-of-range input.
    expect(() =>
      buildAudioGraphArgv({ tracks: baseTracks({ gainDb: 21 }), outputDurationSeconds: 10 }),
    ).toThrow();
  });

  it("throws when a duck: true track has no role: \"voice\" track to duck against", () => {
    expect(() =>
      buildAudioGraphArgv({
        tracks: [
          { filePath: "/media/music.wav", role: "music", duck: true },
          { filePath: "/media/sfx.wav", role: "sfx" },
        ],
        outputDurationSeconds: 10,
      }),
    ).toThrow(AudioGraphValidationError);
  });

  it("throws for an empty tracks array", () => {
    expect(() => buildAudioGraphArgv({ tracks: [], outputDurationSeconds: 10 })).toThrow(
      AudioGraphValidationError,
    );
  });
});

describe("buildAudioGraphArgv (AC6) — argv/filter-graph structural safety", () => {
  it("emits each track's filePath as its own standalone -i argv element", () => {
    const voicePath = "/safe/root/voice-block-0.wav";
    const musicPath = "/safe/root/music-bed.wav";
    const argv = buildAudioGraphArgv({
      tracks: [
        { filePath: voicePath, role: "voice", gainDb: 0 },
        { filePath: musicPath, role: "music", gainDb: -6, loop: true, duck: true },
      ],
      outputDurationSeconds: 30,
    });

    expect(argv).toContain(voicePath);
    expect(argv).toContain(musicPath);
    // Each path must appear as a whole array element immediately following its own "-i" flag —
    // not merely present somewhere in the array.
    expect(argv[argv.indexOf(voicePath) - 1]).toBe("-i");
    expect(argv[argv.indexOf(musicPath) - 1]).toBe("-i");
  });

  it("never lets a file path — however adversarial-looking — reach the filter-graph string", () => {
    // A path containing filter-syntax metacharacters (`[`, `]`, `;`, `:`) would be dangerous if it
    // were ever concatenated into the filter string; this asserts it never is, regardless of
    // content, because this function never formats `filePath` into anything but its own `-i`
    // argv element.
    const hostileVoicePath = "/tmp/evil];amix=inputs=99[out];[0:a]volume=1[voice.wav";
    const hostileMusicPath = "/tmp/another[0:a][1:a]sidechaincompress=weird.wav";
    const argv = buildAudioGraphArgv({
      tracks: [
        { filePath: hostileVoicePath, role: "voice" },
        { filePath: hostileMusicPath, role: "music", duck: true },
      ],
      outputDurationSeconds: 12,
    });

    expect(argv).toContain(hostileVoicePath);
    expect(argv).toContain(hostileMusicPath);

    const filterComplexIndex = argv.indexOf("-filter_complex");
    expect(filterComplexIndex).toBeGreaterThanOrEqual(0);
    const filterComplex = argv[filterComplexIndex + 1]!;

    expect(filterComplex).not.toContain(hostileVoicePath);
    expect(filterComplex).not.toContain(hostileMusicPath);
    expect(filterComplex.includes(".wav")).toBe(false);
  });

  it("references inputs only via bracketed index, and includes gain/fade/loop/loudnorm stages", () => {
    const argv = buildAudioGraphArgv({
      tracks: [
        { filePath: "/media/voice.wav", role: "voice", fadeInSeconds: 0.5 },
        {
          filePath: "/media/music.wav",
          role: "music",
          gainDb: -10,
          loop: true,
          fadeOutSeconds: 2,
          duck: true,
        },
      ],
      outputDurationSeconds: 20,
      loudnormTargetLufs: -16,
    });
    const filterComplex = argv[argv.indexOf("-filter_complex") + 1]!;

    expect(filterComplex).toContain("[0:a]");
    expect(filterComplex).toContain("[1:a]");
    expect(filterComplex).toContain("volume=-10dB");
    expect(filterComplex).toContain("afade=t=in:d=0.5");
    expect(filterComplex).toContain("afade=t=out:st=18:d=2");
    expect(filterComplex).toContain("aloop=loop=-1");
    expect(filterComplex).toContain("sidechaincompress");
    expect(filterComplex).toContain("amix=inputs=2");
    expect(filterComplex).toContain("loudnorm=I=-16");
    expect(argv.at(-2)).toBe("-map");
    expect(argv.at(-1)).toBe("[out]");
  });

  it("omits sidechaincompress entirely when no track has duck: true", () => {
    const argv = buildAudioGraphArgv({
      tracks: [
        { filePath: "/media/voice.wav", role: "voice" },
        { filePath: "/media/music.wav", role: "music" },
      ],
      outputDurationSeconds: 20,
    });
    const filterComplex = argv[argv.indexOf("-filter_complex") + 1]!;
    expect(filterComplex).not.toContain("sidechaincompress");
  });

  it("defaults loudnormTargetLufs to -14 LUFS when not supplied", () => {
    const argv = buildAudioGraphArgv({
      tracks: [{ filePath: "/media/voice.wav", role: "voice" }],
      outputDurationSeconds: 5,
    });
    const filterComplex = argv[argv.indexOf("-filter_complex") + 1]!;
    expect(filterComplex).toContain("loudnorm=I=-14");
  });
});

// ---------------------------------------------------------------------------------------------
// AC7 — real-FFmpeg ducking level check, gated on a real `ffmpeg` binary being on PATH (mirrors
// pipe.live.test.ts's probe-once/skip-gracefully pattern rather than duplicating a new one).
// ---------------------------------------------------------------------------------------------

function probeFfmpegAvailable(): boolean {
  try {
    const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}

const ffmpegAvailable = probeFfmpegAvailable();
if (!ffmpegAvailable) {
  console.warn(
    "[graph.test.ts] Skipping AC7's real-FFmpeg ducking level check: no working `ffmpeg` binary " +
      "found on PATH in this environment. This does not indicate a defect in graph.ts — run this " +
      "file on a machine with a real FFmpeg install to actually exercise AC7's measured-level " +
      "assertion.",
  );
}

const tmpFiles: string[] = [];
afterAll(() => {
  for (const p of tmpFiles.splice(0)) {
    fs.rmSync(p, { force: true });
  }
});

function tmpPath(label: string): string {
  const p = path.join(os.tmpdir(), `claudevid-graph-live-${label}-${randomUUID()}.wav`);
  tmpFiles.push(p);
  return p;
}

/** Extracts `mean_volume` (dB) from `ffmpeg ... -af volumedetect -f null -`'s stderr. */
function parseMeanVolume(stderr: string): number {
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  if (!match) throw new Error(`could not parse mean_volume from ffmpeg stderr: ${stderr}`);
  return Number(match[1]);
}

async function measureMeanVolume(filePath: string, startSeconds: number, endSeconds: number): Promise<number> {
  const { stderr } = await execFileAsync("ffmpeg", [
    "-i",
    filePath,
    "-ss",
    String(startSeconds),
    "-to",
    String(endSeconds),
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  return parseMeanVolume(stderr);
}

describe.skipIf(!ffmpegAvailable)("buildAudioGraphArgv (AC7) — real FFmpeg ducking level check", () => {
  it(
    "the music track's post-graph level under the voice window is measurably reduced when duck: true, vs. an identical graph with duck: false",
    async () => {
      // Fixture geometry: a 6s bed. The voice tone is active only from 1s-5s (a 4s window),
      // silent (padded) elsewhere. The music tone runs the full 6s at a constant synthesized
      // level, so any level change in the *music* track's own processed output must come from
      // the graph's ducking stage, not from the fixture itself.
      const totalDuration = 6;
      const voiceStart = 1;
      const voiceEnd = 5;

      const voicePath = tmpPath("voice");
      const musicPath = tmpPath("music");

      await execFileAsync("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=300:duration=${voiceEnd - voiceStart}`,
        "-af",
        `adelay=${voiceStart * 1000}|${voiceStart * 1000},apad=whole_dur=${totalDuration}`,
        voicePath,
      ]);
      await execFileAsync("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=100:duration=${totalDuration}`,
        musicPath,
      ]);

      const voiceIndex = 0;
      const musicIndex = 1;

      async function measureMusicWindow(duck: boolean, startSeconds: number, endSeconds: number): Promise<number> {
        const argv = buildAudioGraphArgv({
          tracks: [
            { filePath: voicePath, role: "voice" },
            { filePath: musicPath, role: "music", duck },
          ],
          outputDurationSeconds: totalDuration,
        });
        const filterComplexIndex = argv.indexOf("-filter_complex");
        const filterComplex = argv[filterComplexIndex + 1]!;

        // Measure the music track's own intermediate node — "d<index>" once ducked,
        // "t<index>" pre-duck — rather than the graph's final `[out]` (see file header: the
        // final `loudnorm` stage's own dynamic gain smoothing otherwise re-flattens the level
        // difference this test needs to observe). An FFmpeg filtergraph label can only be
        // consumed once, and `buildAudioGraphArgv`'s own `amix` stage already consumes it — so
        // this re-uses only the specific real (verbatim, not rewritten) stage strings the target
        // label transitively depends on, dropping the later mix/loudnorm stages that would
        // otherwise be its sole consumer, and dropping the *other* track's own stage in the
        // non-ducked case (it would otherwise be defined but never consumed, which FFmpeg
        // rejects as an unconnected filtergraph output).
        const measureLabel = duck ? `d${musicIndex}` : `t${musicIndex}`;
        const stages = filterComplex.split(";");
        const musicOwnStage = stages.find((stage) => stage.startsWith(`[${musicIndex}:a]`))!;
        const voiceOwnStage = stages.find((stage) => stage.startsWith(`[${voiceIndex}:a]`))!;
        const duckStage = stages.find(
          (stage) => stage.includes("sidechaincompress") && stage.endsWith(`[${measureLabel}]`),
        );
        expect(musicOwnStage).toBeDefined();
        const requiredStages = duck ? [voiceOwnStage, musicOwnStage, duckStage!] : [musicOwnStage];
        expect(requiredStages.every(Boolean)).toBe(true);
        const isolatedFilterComplex = requiredStages.join(";");
        const outputPath = tmpPath(`measure-${duck ? "ducked" : "plain"}`);
        await execFileAsync("ffmpeg", [
          "-y",
          "-i",
          voicePath,
          "-i",
          musicPath,
          "-filter_complex",
          isolatedFilterComplex,
          "-map",
          `[${measureLabel}]`,
          outputPath,
        ]);

        return measureMeanVolume(outputPath, startSeconds, endSeconds);
      }

      // Pre-voice window: voice is silent (0s-0.9s), so both duck:true and duck:false graphs
      // should show the music at essentially its natural level here.
      const duckedPre = await measureMusicWindow(true, 0, 0.9);
      const plainPre = await measureMusicWindow(false, 0, 0.9);

      // Tail-of-overlap window (4.0s-4.9s): well into the voice-active window, giving the
      // compressor's attack time to have fully settled (measured empirically during test
      // development: the compressor's effective ramp for these fixture levels takes a couple of
      // seconds to reach steady state).
      const duckedDuringVoice = await measureMusicWindow(true, 4.0, 4.9);
      const plainDuringVoice = await measureMusicWindow(false, 4.0, 4.9);

      const DUCK_REDUCTION_THRESHOLD_DB = 3;

      // The unducked reference should be roughly stable across both windows (same constant
      // source, no sidechain applied) — generous tolerance since this is a sanity check, not the
      // AC7 assertion itself.
      expect(Math.abs(plainDuringVoice - plainPre)).toBeLessThan(2);

      // The actual AC7 assertion: with duck: true, the music's own level during the voice window
      // is at least DUCK_REDUCTION_THRESHOLD_DB quieter than its own pre-voice level.
      const duckedReductionDb = duckedPre - duckedDuringVoice;
      expect(duckedReductionDb).toBeGreaterThanOrEqual(DUCK_REDUCTION_THRESHOLD_DB);
    },
    30000,
  );
});
