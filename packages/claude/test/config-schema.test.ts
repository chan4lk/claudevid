import { describe, expect, it } from "vitest";
import { brandKitConfigSchema } from "../src/config-schema.js";

describe("brandKitConfigSchema", () => {
  it("accepts an empty object", () => {
    const result = brandKitConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a fully populated valid object", () => {
    const result = brandKitConfigSchema.safeParse({
      model: "claude-opus-4-8",
      repairAttempts: 3,
      voice: "af_heart",
      brand: {
        palette: ["#000000", "#ffffff"],
        fontFamily: "Inter",
        logoPath: "/assets/logo.png",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a wrong-typed field", () => {
    const result = brandKitConfigSchema.safeParse({ model: 123 });
    expect(result.success).toBe(false);
  });
});
