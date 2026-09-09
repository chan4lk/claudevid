import { describe, expect, it } from "vitest";
import { chunkNarrationText, MAX_SAFE_NARRATION_WORDS } from "../src/narration-chunking.js";

describe("chunkNarrationText", () => {
  it("returns a single chunk equal to the input when under the threshold (AC2)", () => {
    const text = "This is a short narration block. It has two sentences.";
    const result = chunkNarrationText(text);
    expect(result).toEqual([text]);
  });

  it("exports MAX_SAFE_NARRATION_WORDS as the default threshold", () => {
    expect(typeof MAX_SAFE_NARRATION_WORDS).toBe("number");
    expect(MAX_SAFE_NARRATION_WORDS).toBeGreaterThan(0);
  });

  it("splits over-threshold text into multiple chunks whose concatenation reproduces the input (AC1)", () => {
    const sentences = [
      "One two three four five six seven eight nine ten.",
      "Eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.",
      "Twenty one twenty two twenty three twenty four twenty five twenty six twenty seven twenty eight.",
    ];
    const text = sentences.join(" ");
    const result = chunkNarrationText(text, 20);

    expect(result.length).toBeGreaterThan(1);
    expect(result.join(" ")).toBe(text);
  });

  it("does not split immediately after a single-capital-letter-plus-period initial (AC3)", () => {
    const text = "Our analyst D. Wickramasinghe reviewed the filing and found no discrepancies.";
    const result = chunkNarrationText(text);
    expect(result).toEqual([text]);
  });

  it("returns a single run-on sentence with no internal sentence boundary as one still-over-length chunk", () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`);
    const text = `${words.join(" ")}.`;
    const result = chunkNarrationText(text, 20);

    expect(result).toEqual([text]);
    expect(result).toHaveLength(1);
  });
});
