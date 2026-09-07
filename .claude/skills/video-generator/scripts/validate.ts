#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../../../../packages/cli/dist/cli.js");
const result = spawnSync("node", [cliPath, "validate", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
