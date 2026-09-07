import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportCatalogue } from "@claudevid/motion";
import { BUNDLED_LANGS, BUNDLED_THEMES } from "@claudevid/layer-code";
import { generateJsonSchema } from "@claudevid/core";
import { buildDirectorPrompt } from "../src/prompts/build-director-prompt.js";
import type { BrandKitConfig } from "../src/config-schema.js";

// No brand kit is loaded here — this script generates the package's own committed, generic
// prompt (no project has been `init`'d yet at generation time). `buildDirectorPrompt` already
// renders a sensible "no brand kit configured" section when `brand` is undefined (see its
// `hasBrand` check), which is exactly what we want for this default artifact.
const DEFAULT_BRAND: BrandKitConfig["brand"] = undefined;

/**
 * Assembles the director system prompt from the current state of the packages it depends on.
 * Pure with respect to its inputs — no file I/O — so it can be called directly by a drift-check
 * test (T9) without shelling out to this script.
 */
export function generatePromptContent(): string {
  return buildDirectorPrompt(exportCatalogue(), BUNDLED_LANGS, BUNDLED_THEMES, DEFAULT_BRAND);
}

/**
 * Produces the VideoSpec JSON Schema object. Pure — no file I/O — for the same reason as
 * `generatePromptContent` above.
 */
export function generateSchemaContent(): object {
  return generateJsonSchema();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");

async function main() {
  const promptPath = path.join(packageRoot, "prompts", "video-director.md");
  const schemaPath = path.join(packageRoot, "schemas", "video-spec.schema.json");

  const promptContent = generatePromptContent();
  const schemaContent = generateSchemaContent();

  await mkdir(path.dirname(promptPath), { recursive: true });
  await mkdir(path.dirname(schemaPath), { recursive: true });

  await writeFile(promptPath, promptContent, "utf8");
  await writeFile(schemaPath, `${JSON.stringify(schemaContent, null, 2)}\n`, "utf8");

  console.log(`Wrote ${path.relative(packageRoot, promptPath)} (${promptContent.length} bytes)`);
  console.log(
    `Wrote ${path.relative(packageRoot, schemaPath)} (${JSON.stringify(schemaContent).length} bytes)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
