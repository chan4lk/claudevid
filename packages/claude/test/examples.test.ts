import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSpec } from "@claudevid/core";
// Registers the "code" layer renderer so example specs using it parse/validate cleanly.
import "@claudevid/layer-code";

const EXAMPLES_DIR = join(__dirname, "..", "examples");

const exampleFiles = readdirSync(EXAMPLES_DIR).filter((name) => name.endsWith(".json"));

describe("example specs", () => {
  it("found the expected example files", () => {
    expect(exampleFiles.length).toBeGreaterThan(0);
  });

  for (const file of exampleFiles) {
    it(`${file} parses as a valid VideoSpec`, () => {
      const raw = readFileSync(join(EXAMPLES_DIR, file), "utf-8");
      const json = JSON.parse(raw);
      const result = parseSpec(json);

      const message = result.ok
        ? undefined
        : `${file} failed to parse:\n` +
          result.diagnostics.map((d) => `  ${d.path}: ${d.message}${d.suggestion ? ` (${d.suggestion})` : ""}`).join("\n");

      expect(result.ok, message).toBe(true);
    });
  }
});
