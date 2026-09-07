// Drift check (spec.md AC7, design.md D4). Regenerates the committed prompt/schema/skill-sync
// content in-memory via generate-assets.ts's exported pure functions and compares it against what
// is actually committed on disk. Never writes to disk — a failure here means someone edited a
// dependency (or a committed artifact) without re-running `pnpm --filter @claudevid/claude run
// generate-assets`.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatePromptContent, generateSchemaContent } from "../scripts/generate-assets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const repoRoot = join(packageRoot, "..", "..");

const PROMPT_PATH = join(packageRoot, "prompts", "video-director.md");
const SCHEMA_PATH = join(packageRoot, "schemas", "video-spec.schema.json");
const SKILL_SCHEMA_PATH = join(
  repoRoot,
  ".claude",
  "skills",
  "video-generator",
  "schemas",
  "video-spec.schema.json",
);
const EXAMPLES_DIR = join(packageRoot, "examples");
const SKILL_EXAMPLES_DIR = join(repoRoot, ".claude", "skills", "video-generator", "examples");

describe("generated assets drift check (AC7)", () => {
  it("generatePromptContent() matches the committed packages/claude/prompts/video-director.md", () => {
    const committed = readFileSync(PROMPT_PATH, "utf-8");
    expect(generatePromptContent()).toBe(committed);
  });

  it("generateSchemaContent() matches the committed packages/claude/schemas/video-spec.schema.json", () => {
    const committed = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));
    expect(generateSchemaContent()).toEqual(committed);
  });

  it(".claude/skills/video-generator/schemas/video-spec.schema.json is byte-identical to packages/claude/schemas/video-spec.schema.json", () => {
    const source = readFileSync(SCHEMA_PATH, "utf-8");
    const synced = readFileSync(SKILL_SCHEMA_PATH, "utf-8");
    expect(synced).toBe(source);
  });

  it("every packages/claude/examples/*.json file is byte-identical to its synced copy under .claude/skills/video-generator/examples/", () => {
    const files = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(join(EXAMPLES_DIR, file), "utf-8");
      const synced = readFileSync(join(SKILL_EXAMPLES_DIR, file), "utf-8");
      expect(synced).toBe(source);
    }
  });
});
