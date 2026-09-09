#!/usr/bin/env node
// Thin wrapper: forwards argv verbatim to the built CLI's `validate` command and exits with its
// exit code. Deliberately not a reimplementation of validate logic.
//
// The CLI is found in whichever of three layouts this skill is installed in, tried in order:
//   1. `claudevid` installed as a dependency of the host project (Node resolution — works from
//      any directory depth and survives pnpm's symlinked store).
//   2. `claudevid` installed globally (`npm i -g`), so its bin is on PATH. This is the layout
//      that suits a non-Node host project: a Python or Go repo gets the skill folder alone,
//      with no package.json or node_modules of its own.
//   3. Inside the claudevid monorepo, at `packages/cli/dist/cli.js` relative to the repo root.
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCli } from "./resolve-cli.mts";

const here = path.dirname(fileURLToPath(import.meta.url));

const { command, prefixArgs } = resolveCli(here);
const result = spawnSync(command, [...prefixArgs, "validate", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
