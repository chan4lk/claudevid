import { zodToJsonSchema } from "zod-to-json-schema";
import { videoSpecSchema } from "./schema.js";

/** JSON Schema for Claude's structured output (change 007) — generated, never hand-maintained. */
export function generateJsonSchema(): object {
  return zodToJsonSchema(videoSpecSchema, "VideoSpec");
}
