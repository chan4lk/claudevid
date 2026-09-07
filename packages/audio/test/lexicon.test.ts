// AC10, spec.md FR10, Edge Cases ("Lexicon entry covers a word that never appears in a given
// scene's narration"). No real synthesis/inference involved — pure text/hash functions.

import { describe, expect, it } from "vitest";

import { applyLexicon, resolveLexiconDigest, type Lexicon } from "../src/lexicon.js";

describe("applyLexicon", () => {
  it("replaces a term that appears in the text", () => {
    const lexicon: Lexicon = [{ term: "kubectl", replacement: "kube cuttle" }];
    const { text, appliedEntries } = applyLexicon("Run kubectl apply now.", lexicon);

    expect(text).toBe("Run kube cuttle apply now.");
    expect(appliedEntries).toEqual([{ term: "kubectl", replacement: "kube cuttle" }]);
  });

  it("leaves text unchanged when no lexicon entry matches", () => {
    const lexicon: Lexicon = [{ term: "kubectl", replacement: "kube cuttle" }];
    const { text, appliedEntries } = applyLexicon("Nothing to see here.", lexicon);

    expect(text).toBe("Nothing to see here.");
    expect(appliedEntries).toEqual([]);
  });

  it("returns only the entries that actually matched in appliedEntries (absent-word edge case)", () => {
    const lexicon: Lexicon = [
      { term: "kubectl", replacement: "kube cuttle" },
      { term: "nginx", replacement: "engine-x" },
    ];
    // Only "kubectl" appears in this text — "nginx" is absent and must not show up as applied.
    const { text, appliedEntries } = applyLexicon("Run kubectl apply now.", lexicon);

    expect(text).toBe("Run kube cuttle apply now.");
    expect(appliedEntries).toEqual([{ term: "kubectl", replacement: "kube cuttle" }]);
  });

  it("matches whole words case-insensitively, not substrings", () => {
    const lexicon: Lexicon = [{ term: "cat", replacement: "kitty" }];
    const { text, appliedEntries } = applyLexicon("The Cat sat on the concatenation.", lexicon);

    expect(text).toBe("The kitty sat on the concatenation.");
    expect(appliedEntries).toEqual([{ term: "cat", replacement: "kitty" }]);
  });
});

describe("resolveLexiconDigest", () => {
  it("produces different digests for two different appliedEntries sets", () => {
    const digestA = resolveLexiconDigest([{ term: "kubectl", replacement: "kube cuttle" }]);
    const digestB = resolveLexiconDigest([{ term: "kubectl", replacement: "cube control" }]);

    expect(digestA).not.toBe(digestB);
  });

  it("produces the same digest for the same set regardless of input order", () => {
    const entriesA = [
      { term: "kubectl", replacement: "kube cuttle" },
      { term: "nginx", replacement: "engine-x" },
    ];
    const entriesB = [
      { term: "nginx", replacement: "engine-x" },
      { term: "kubectl", replacement: "kube cuttle" },
    ];

    expect(resolveLexiconDigest(entriesA)).toBe(resolveLexiconDigest(entriesB));
  });

  it("changing a lexicon entry that affects a given text changes the text's resulting digest (AC10)", () => {
    const text = "Run kubectl apply now.";
    const lexiconV1: Lexicon = [{ term: "kubectl", replacement: "kube cuttle" }];
    const lexiconV2: Lexicon = [{ term: "kubectl", replacement: "cube control" }];

    const appliedV1 = applyLexicon(text, lexiconV1).appliedEntries;
    const appliedV2 = applyLexicon(text, lexiconV2).appliedEntries;

    expect(resolveLexiconDigest(appliedV1)).not.toBe(resolveLexiconDigest(appliedV2));
  });

  it("a lexicon entry for a word absent from the text does not affect the digest", () => {
    const text = "Nothing relevant here.";
    const lexiconWithout: Lexicon = [];
    const lexiconWithAbsentEntry: Lexicon = [{ term: "kubectl", replacement: "kube cuttle" }];

    const appliedWithout = applyLexicon(text, lexiconWithout).appliedEntries;
    const appliedWithAbsent = applyLexicon(text, lexiconWithAbsentEntry).appliedEntries;

    expect(resolveLexiconDigest(appliedWithout)).toBe(resolveLexiconDigest(appliedWithAbsent));
  });

  it("returns '' for empty appliedEntries, stably and deterministically", () => {
    expect(resolveLexiconDigest([])).toBe("");
    expect(resolveLexiconDigest([])).toBe(resolveLexiconDigest([]));
  });
});
