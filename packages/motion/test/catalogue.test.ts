import { describe, expect, it } from "vitest";
import { exportCatalogue } from "../src/presets.js";

describe("exportCatalogue (AC10, FR7)", () => {
  it("returns exactly the 9 shipped v1 presets", () => {
    expect(exportCatalogue().map((e) => e.name).sort()).toEqual(
      [
        "fade",
        "fade-down",
        "fade-up",
        "pop",
        "scale-fade",
        "slide-down",
        "slide-left",
        "slide-right",
        "slide-up",
      ].sort()
    );
  });

  it("every entry has exactly {name, channels} — no free-form field beyond the name itself", () => {
    for (const entry of exportCatalogue()) {
      expect(Object.keys(entry).sort()).toEqual(["channels", "name"]);
      expect(typeof entry.name).toBe("string");
      expect(Array.isArray(entry.channels)).toBe(true);
      expect(entry.channels.length).toBeGreaterThan(0);
    }
  });
});
