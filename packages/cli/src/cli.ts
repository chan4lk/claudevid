#!/usr/bin/env node
// `claudevid` CLI entry point (spec.md NFR5). Unconditionally imports `@claudevid/layer-code` and
// `@claudevid/layer-captions` for their `registerLayer`/`registerPainter` side effects *before*
// dispatching any command — without this, `code`/`captions` layers would schema-validate but
// silently fail to render (see each package's own `src/index.ts` header comment).
import "@claudevid/layer-code";
import "@claudevid/layer-captions";

import { ArgError } from "./args.js";
import { runInitFromCli } from "./commands/init.js";
import { runValidateFromCli } from "./commands/validate.js";
import { runPreviewFromCli } from "./commands/preview.js";
import { runRenderFromCli } from "./commands/render.js";
import { runGenerateFromCli } from "./commands/generate.js";
import { runBatchFromCli } from "./commands/batch.js";
import { runModelsInstallFromCli } from "./commands/models.js";
import { runBenchFromCli } from "./commands/bench.js";

const USAGE = `Usage: claudevid <command> [options]

Commands:
  init                          scaffold a new claudevid project
  validate <spec>                validate a VideoSpec JSON file
  preview <spec>                 render a contact-sheet preview
  render <spec> --out <file>     render a spec to a video file
  generate <prompt>              generate a VideoSpec from a prompt
  batch <dir>                    render every spec in a directory
  models install                 install local TTS/ASR models
  bench                          run the render/encode benchmark`;

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case "init":
      runInitFromCli(process.argv.slice(3));
      return;
    case "validate":
      runValidateFromCli(process.argv.slice(3));
      return;
    case "preview":
      await runPreviewFromCli(process.argv.slice(3));
      return;
    case "render":
      await runRenderFromCli(process.argv.slice(3));
      return;
    case "generate":
      await runGenerateFromCli(process.argv.slice(3));
      return;
    case "batch":
      await runBatchFromCli(process.argv.slice(3));
      return;
    case "models":
      if (process.argv[3] === "install") {
        await runModelsInstallFromCli(process.argv.slice(4));
        return;
      }
      break;
    case "bench":
      await runBenchFromCli(process.argv.slice(3));
      return;
    default:
      break;
  }

  console.error(USAGE);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof ArgError ? err.message : err);
  process.exitCode = 1;
});
