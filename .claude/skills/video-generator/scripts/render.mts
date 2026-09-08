#!/usr/bin/env node
// Thin wrapper: forwards argv verbatim to the built CLI's `render` command and exits with its
// exit code. Deliberately not a reimplementation of render logic.
//
// The CLI is found in whichever of three layouts this skill is installed in, tried in order:
//   1. `claudevid` installed as a dependency of the host project (Node resolution — works from
//      any directory depth and survives pnpm's symlinked store).
//   2. `claudevid` installed globally (`npm i -g`), so its bin is on PATH. This is the layout
//      that suits a non-Node host project: a Python or Go repo gets the skill folder alone,
//      with no package.json or node_modules of its own.
//   3. Inside the claudevid monorepo, at `packages/cli/dist/cli.js` relative to the repo root.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Returns `{ command, prefixArgs }` — a global install is invoked through its own bin (which
 * carries the right shebang), while a resolved module path is handed to `node` explicitly. */
function resolveCli() {
  try {
    return { command: "node", prefixArgs: [createRequire(path.join(here, "noop.js")).resolve("claudevid/cli")] };
  } catch {
    // Not a dependency of this project — try a global install next.
  }

  const onPath = spawnSync("claudevid", ["--version"], { stdio: "ignore" });
  if (!onPath.error) return { command: "claudevid", prefixArgs: [] };

  const inMonorepo = path.resolve(here, "../../../../packages/cli/dist/cli.js");
  if (existsSync(inMonorepo)) return { command: "node", prefixArgs: [inMonorepo] };

  throw new Error(
    "Could not locate the claudevid CLI. Install it in this project (`npm install claudevid`), " +
      "install it globally (`npm install -g claudevid`), or run this script from inside the " +
      "claudevid monorepo after `pnpm build`.",
  );
}

const { command, prefixArgs } = resolveCli();
const result = spawnSync(command, [...prefixArgs, "render", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
