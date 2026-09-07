// `claudevid init` scaffolding tests (spec.md FR1/AC1). No filesystem access — exists/readFile/
// writeFile/mkdir are injected fakes backed by in-memory maps, following tools/motion-preview's
// dependency-injection test style (see test/config.test.ts).

import { describe, expect, it } from "vitest";

import { ArgError } from "../src/args.js";
import { runInit, type InitDeps } from "../src/commands/init.js";

const TEMPLATE_CONTENT: Record<string, string> = {
  "claudevid.config.json": JSON.stringify({ brand: { palette: ["#111111", "#f5f5f5"] } }),
  "example-spec.json": JSON.stringify({ version: 1, scenes: [] }),
};

function makeDeps(existingFiles: Set<string> = new Set()): InitDeps & {
  writes: Map<string, string>;
  dirs: Set<string>;
} {
  const writes = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    cwd: "/project",
    exists: (path) => existingFiles.has(path),
    readFile: (path) => TEMPLATE_CONTENT[path] ?? "",
    writeFile: (path, content) => writes.set(path, content),
    mkdir: (path) => dirs.add(path),
    writes,
    dirs,
  };
}

describe("runInit (FR1/AC1)", () => {
  it("scaffolds config, .claudevid/.gitignore, and specs/example.json in a fresh directory", () => {
    const deps = makeDeps();

    runInit({}, deps);

    expect(deps.writes.get("/project/claudevid.config.json")).toBe(
      TEMPLATE_CONTENT["claudevid.config.json"],
    );
    expect(deps.writes.get("/project/.claudevid/.gitignore")).toBe("*\n");
    expect(deps.writes.get("/project/specs/example.json")).toBe(
      TEMPLATE_CONTENT["example-spec.json"],
    );
    expect(deps.dirs.has("/project/.claudevid")).toBe(true);
    expect(deps.dirs.has("/project/specs")).toBe(true);
  });

  it("refuses to overwrite an existing claudevid.config.json without --force", () => {
    const deps = makeDeps(new Set(["/project/claudevid.config.json"]));

    expect(() => runInit({}, deps)).toThrow(ArgError);
    expect(deps.writes.size).toBe(0);
  });

  it("overwrites an existing claudevid.config.json when --force is set", () => {
    const deps = makeDeps(new Set(["/project/claudevid.config.json"]));

    runInit({ force: true }, deps);

    expect(deps.writes.get("/project/claudevid.config.json")).toBe(
      TEMPLATE_CONTENT["claudevid.config.json"],
    );
    expect(deps.writes.get("/project/.claudevid/.gitignore")).toBe("*\n");
    expect(deps.writes.get("/project/specs/example.json")).toBe(
      TEMPLATE_CONTENT["example-spec.json"],
    );
  });
});
