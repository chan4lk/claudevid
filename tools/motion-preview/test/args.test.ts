import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, assertOutputWritable, ArgError, MAX_FRAMES } from "../src/args.js";

describe("parseArgs", () => {
  it("requires --spec", () => {
    expect(() => parseArgs(["--out", "x.png"])).toThrow(ArgError);
  });

  it("requires --out — never derived from spec content (FR17)", () => {
    expect(() => parseArgs(["--spec", "x.json"])).toThrow(ArgError);
  });

  it("rejects --frames above the cap (AC11)", () => {
    expect(() => parseArgs(["--spec", "s.json", "--out", "o.png", "--frames", String(MAX_FRAMES + 1)])).toThrow(
      ArgError
    );
  });

  it("accepts --frames at the cap", () => {
    const parsed = parseArgs(["--spec", "s.json", "--out", "o.png", "--frames", String(MAX_FRAMES)]);
    expect(parsed.frames).toBe(MAX_FRAMES);
  });

  it("defaults --force to false and --frames to a positive default", () => {
    const parsed = parseArgs(["--spec", "s.json", "--out", "o.png"]);
    expect(parsed.force).toBe(false);
    expect(parsed.frames).toBeGreaterThan(0);
  });

  it("rejects an unrecognized flag", () => {
    expect(() => parseArgs(["--spec", "s.json", "--out", "o.png", "--bogus"])).toThrow(ArgError);
  });
});

describe("assertOutputWritable (AC11 — no-clobber)", () => {
  it("refuses to overwrite an existing file without --force", () => {
    const dir = mkdtempSync(join(tmpdir(), "motion-preview-"));
    const outPath = join(dir, "out.png");
    writeFileSync(outPath, "existing");

    expect(() => assertOutputWritable(outPath, false, existsSync)).toThrow(ArgError);
    expect(() => assertOutputWritable(outPath, true, existsSync)).not.toThrow();
  });

  it("allows writing to a path that doesn't exist yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "motion-preview-"));
    const outPath = join(dir, "new.png");
    expect(() => assertOutputWritable(outPath, false, existsSync)).not.toThrow();
  });
});
