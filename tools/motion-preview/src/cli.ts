#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs, assertOutputWritable, ArgError } from "./args.js";
import { renderPreview } from "./render-preview.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertOutputWritable(args.outPath, args.force, existsSync);
  await renderPreview(args);
  console.log(`wrote ${args.frames}-frame contact sheet to ${args.outPath}`);
}

main().catch((err) => {
  console.error(err instanceof ArgError ? `motion-preview: ${err.message}` : err);
  process.exitCode = 1;
});
