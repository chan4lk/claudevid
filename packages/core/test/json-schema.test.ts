import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { generateJsonSchema } from "../src/json-schema.js";

describe("generateJsonSchema (AC10)", () => {
  it("validates a minimal spec when checked with a real JSON Schema validator", () => {
    const schema = generateJsonSchema();
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(schema as any);

    const minimalSpec = {
      version: 1,
      width: 1920,
      height: 1080,
      fps: 30,
      scenes: [{ id: "intro", duration: 3, layers: [{ type: "text", text: "Hello" }] }],
    };

    const valid = validate(minimalSpec);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a spec missing the required scenes array", () => {
    const schema = generateJsonSchema();
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(schema as any);

    expect(validate({ version: 1 })).toBe(false);
  });

  it("places scene.audio under scenes.items.properties and drops the top-level audio field (AC5)", () => {
    const schema = generateJsonSchema() as {
      definitions: {
        VideoSpec: {
          properties: {
            audio?: unknown;
            scenes: { items: { properties: { audio?: unknown } } };
          };
        };
      };
    };
    const videoSpec = schema.definitions.VideoSpec;

    expect(videoSpec.properties.scenes.items.properties.audio).toBeDefined();
    expect(videoSpec.properties.audio).toBeUndefined();
  });
});
