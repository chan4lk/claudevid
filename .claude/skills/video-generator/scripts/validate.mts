#!/usr/bin/env node
// Thin wrapper: forwards argv verbatim to the built CLI's `validate` command and exits with its
// exit code. Deliberately not a reimplementation of validate logic.
//
// The CLI is located in whichever of two layouts this skill is installed in: inside the
// claudevid monorepo it lives at `packages/cli/dist/cli.js` relative to the repo root; in a
// consumer project the skill is copied into `.claude/skills/video-generator/` and the CLI comes
// from the installed `claudevid` package. Node resolution is tried first (it works from any
// depth and survives pnpm's symlinked store), then the monorepo path.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function resolveCli() {
  try {
    return createRequire(path.join(here, "noop.js")).resolve("claudevid/cli");
  } catch {
    // Not installed as a dependency — fall through to the in-monorepo location.
  }
  const local = path.resolve(here, "../../../../packages/cli/dist/cli.js");
  if (existsSync(local)) return local;
  throw new Error(
    "Could not locate the claudevid CLI. Install it in this project (`npm install claudevid`), " +
      "or run this script from inside the claudevid monorepo after `pnpm build`.",
  );
}

const result = spawnSync("node", [resolveCli(), "validate", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
