// Tests for resolveSceneAudioPaths (spec.md FR6/AC6). Every fs touch is faked — `realpathFn`/
// `statFn` are simple in-memory lookups, no real disk I/O — following this workspace's
// dependency-injection test style (see cli/test/validate.test.ts, cli/test/config.test.ts).

import { describe, expect, it } from "vitest";

import type { VideoSpec } from "@claudevid/core";

import { resolveSceneAudioPaths, type RealpathFn, type StatFn } from "../src/scene-audio-paths.js";

function makeSpec(scenes: VideoSpec["scenes"]): VideoSpec {
  return { version: 1, width: 1920, height: 1080, fps: 30, scenes };
}

function audioScene(id: string, src: string): VideoSpec["scenes"][number] {
  return { id, duration: "auto", layers: [], audio: { src } };
}

/**
 * A minimal fake filesystem: `realpaths` maps a candidate path to the real path it resolves to
 * (an entry standing in for both "the file/dir exists" and, when the mapped value differs from
 * the key, "this is a symlink pointing elsewhere" — spec.md edge case 5). A candidate path with
 * no entry throws, standing in for `ENOENT` ("not found"). `files`/`dirs` classify each *real*
 * path so `statFn` can distinguish a regular file from a directory.
 */
function makeFakeFs(opts: { realpaths: Record<string, string>; files?: Set<string>; dirs?: Set<string> }): {
  realpathFn: RealpathFn;
  statFn: StatFn;
} {
  const files = opts.files ?? new Set<string>();
  const dirs = opts.dirs ?? new Set<string>();

  const realpathFn: RealpathFn = (path) => {
    const real = opts.realpaths[path];
    if (real === undefined) {
      throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
    }
    return real;
  };

  const statFn: StatFn = (path) => ({
    isFile: () => files.has(path) && !dirs.has(path),
  });

  return { realpathFn, statFn };
}

describe("resolveSceneAudioPaths (FR6/AC6)", () => {
  it("resolves a relative src against specDir", () => {
    const spec = makeSpec([audioScene("intro", "audio/a.wav")]);
    const { realpathFn, statFn } = makeFakeFs({
      realpaths: { "/deck": "/deck", "/deck/audio/a.wav": "/deck/audio/a.wav" },
      files: new Set(["/deck/audio/a.wav"]),
    });

    const result = resolveSceneAudioPaths(spec, { specDir: "/deck", realpathFn, statFn });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.scenes[0]?.audio?.src).toBe("/deck/audio/a.wav");
    }
  });

  it("keeps an absolute src as given (not joined with specDir)", () => {
    const spec = makeSpec([audioScene("intro", "/shared/audio/a.wav")]);
    const { realpathFn, statFn } = makeFakeFs({
      realpaths: {
        "/deck": "/deck",
        "/shared/audio": "/shared/audio",
        "/shared/audio/a.wav": "/shared/audio/a.wav",
      },
      files: new Set(["/shared/audio/a.wav"]),
    });

    const result = resolveSceneAudioPaths(spec, {
      specDir: "/deck",
      audioRoot: "/shared/audio",
      realpathFn,
      statFn,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.scenes[0]?.audio?.src).toBe("/shared/audio/a.wav");
    }
  });

  it("reports a not-found diagnostic for a missing file", () => {
    const spec = makeSpec([audioScene("intro", "audio/missing.wav")]);
    const { realpathFn, statFn } = makeFakeFs({ realpaths: { "/deck": "/deck" } });

    const result = resolveSceneAudioPaths(spec, { specDir: "/deck", realpathFn, statFn });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.path).toBe("/scenes/0/audio/src");
      expect(result.diagnostics[0]?.message).toContain("not found");
    }
  });

  it("reports a not-a-regular-file diagnostic for a directory", () => {
    const spec = makeSpec([audioScene("intro", "audio")]);
    const { realpathFn, statFn } = makeFakeFs({
      realpaths: { "/deck": "/deck", "/deck/audio": "/deck/audio" },
      dirs: new Set(["/deck/audio"]),
    });

    const result = resolveSceneAudioPaths(spec, { specDir: "/deck", realpathFn, statFn });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.message).toContain("not a regular file");
    }
  });

  it("reports an outside-the-allowed-root diagnostic when a real path escapes specDir", () => {
    const spec = makeSpec([audioScene("intro", "link.wav")]);
    // link.wav's *real* path (after following the symlink) is outside /deck entirely.
    const { realpathFn, statFn } = makeFakeFs({
      realpaths: { "/deck": "/deck", "/deck/link.wav": "/outside/a.wav" },
      files: new Set(["/outside/a.wav"]),
    });

    const result = resolveSceneAudioPaths(spec, { specDir: "/deck", realpathFn, statFn });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.message).toContain("outside the allowed root");
      expect(result.diagnostics[0]?.message).toContain("/deck");
      expect(result.diagnostics[0]?.suggestion).toContain("--audio-root");
    }
  });

  it("widens the allowed root when audioRoot is given", () => {
    const spec = makeSpec([audioScene("intro", "/shared/audio/a.wav")]);
    const { realpathFn, statFn } = makeFakeFs({
      realpaths: {
        "/deck": "/deck",
        "/shared/audio": "/shared/audio",
        "/shared/audio/a.wav": "/shared/audio/a.wav",
      },
      files: new Set(["/shared/audio/a.wav"]),
    });

    // Without --audio-root this would be outside /deck; with it, /shared/audio is the root.
    const result = resolveSceneAudioPaths(spec, {
      specDir: "/deck",
      audioRoot: "/shared/audio",
      realpathFn,
      statFn,
    });

    expect(result.ok).toBe(true);
  });

  it("does not treat /deck/audio-evil as inside root /deck/audio (trailing-separator containment)", () => {
    const spec = makeSpec([audioScene("intro", "/deck/audio-evil/a.wav")]);
    const { realpathFn, statFn } = makeFakeFs({
      realpaths: {
        "/deck/audio": "/deck/audio",
        "/deck/audio-evil/a.wav": "/deck/audio-evil/a.wav",
      },
      files: new Set(["/deck/audio-evil/a.wav"]),
    });

    const result = resolveSceneAudioPaths(spec, { specDir: "/deck/audio", realpathFn, statFn });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.message).toContain("outside the allowed root");
    }
  });

  it("returns a new spec object and leaves the input spec unmodified", () => {
    const spec = makeSpec([audioScene("intro", "audio/a.wav")]);
    const { realpathFn, statFn } = makeFakeFs({
      realpaths: { "/deck": "/deck", "/deck/audio/a.wav": "/deck/audio/a.wav" },
      files: new Set(["/deck/audio/a.wav"]),
    });

    const result = resolveSceneAudioPaths(spec, { specDir: "/deck", realpathFn, statFn });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec).not.toBe(spec);
      expect(spec.scenes[0]?.audio?.src).toBe("audio/a.wav");
    }
  });

  it("collects one diagnostic per failing scene in a single pass", () => {
    const spec = makeSpec([audioScene("a", "missing-a.wav"), audioScene("b", "missing-b.wav")]);
    const { realpathFn, statFn } = makeFakeFs({ realpaths: { "/deck": "/deck" } });

    const result = resolveSceneAudioPaths(spec, { specDir: "/deck", realpathFn, statFn });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(2);
      expect(result.diagnostics[0]?.path).toBe("/scenes/0/audio/src");
      expect(result.diagnostics[1]?.path).toBe("/scenes/1/audio/src");
    }
  });

  it("passes through a spec with no audio scenes unchanged (but as a new object)", () => {
    const spec = makeSpec([{ id: "intro", duration: 3, layers: [] }]);
    const { realpathFn, statFn } = makeFakeFs({ realpaths: { "/deck": "/deck" } });

    const result = resolveSceneAudioPaths(spec, { specDir: "/deck", realpathFn, statFn });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec).not.toBe(spec);
      expect(result.spec).toEqual(spec);
    }
  });
});
