import { describe, expect, it } from "vitest";
import { parseArgs, ArgError } from "../src/args.js";

// Mirrors tools/motion-preview/test/args.test.ts's precedent (tasks.md T10): covers only this
// tool's own CLI-argument parsing — no rendering, no FFmpeg, no live process — so this stays
// fast and out of the workspace's "needs a real render/encode" tier.
describe("parseArgs", () => {
  it("defaults to the final profile and cpuEncode: false", () => {
    const parsed = parseArgs([]);
    expect(parsed.profile).toBe("final");
    expect(parsed.cpuEncode).toBe(false);
  });

  it("accepts --profile preview", () => {
    const parsed = parseArgs(["--profile", "preview"]);
    expect(parsed.profile).toBe("preview");
  });

  it("accepts --profile final", () => {
    const parsed = parseArgs(["--profile", "final"]);
    expect(parsed.profile).toBe("final");
  });

  it("rejects an invalid --profile value", () => {
    expect(() => parseArgs(["--profile", "bogus"])).toThrow(ArgError);
  });

  it("rejects a missing --profile value", () => {
    expect(() => parseArgs(["--profile"])).toThrow(ArgError);
  });

  it("accepts --cpu-encode", () => {
    const parsed = parseArgs(["--cpu-encode"]);
    expect(parsed.cpuEncode).toBe(true);
  });

  it("accepts --profile and --cpu-encode together", () => {
    const parsed = parseArgs(["--profile", "preview", "--cpu-encode"]);
    expect(parsed.profile).toBe("preview");
    expect(parsed.cpuEncode).toBe(true);
  });

  it("rejects an unrecognized flag", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(ArgError);
  });
});
