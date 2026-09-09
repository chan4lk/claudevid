// Unit tests for pickCli() (spec.md 010-cli-resolution-freshness, Acceptance Criteria 1-3).
// Pure function under test: no filesystem, no PATH lookup, no process spawning here — candidates
// are passed in as plain data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCli } from "./resolve-cli.mts";

test("monorepo dist path wins even when a local dependency and a global install are both also present", () => {
  const result = pickCli({
    monorepoDistPath: "/repo/packages/cli/dist/cli.js",
    localDepResolve: () => "/repo/node_modules/claudevid/cli.js",
    globalOnPath: true,
  });

  assert.deepEqual(result, {
    command: "node",
    prefixArgs: ["/repo/packages/cli/dist/cli.js"],
  });
});

test("local dependency wins when no monorepo dist is present, even with a global install present", () => {
  const result = pickCli({
    monorepoDistPath: null,
    localDepResolve: () => "/repo/node_modules/claudevid/cli.js",
    globalOnPath: true,
  });

  assert.deepEqual(result, {
    command: "node",
    prefixArgs: ["/repo/node_modules/claudevid/cli.js"],
  });
});

test("global install wins when neither monorepo dist nor a local dependency is present", () => {
  const result = pickCli({
    monorepoDistPath: null,
    localDepResolve: null,
    globalOnPath: true,
  });

  assert.deepEqual(result, { command: "claudevid", prefixArgs: [] });
});

test("throws the three-option message when none of the three candidates is available", () => {
  assert.throws(
    () =>
      pickCli({
        monorepoDistPath: null,
        localDepResolve: null,
        globalOnPath: false,
      }),
    {
      message:
        "Could not locate the claudevid CLI. Install it in this project (`npm install claudevid`), " +
        "install it globally (`npm install -g claudevid`), or run this script from inside the " +
        "claudevid monorepo after `pnpm build`.",
    },
  );
});
