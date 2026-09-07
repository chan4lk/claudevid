// Pronunciation lexicon: term -> replacement text, applied to narration before synthesis (spec.md
// FR10, design.md D6, Key Decision D6). Deliberately literal text substitution/respelling, not a
// phonetic-alphabet system (Rule 2, Simplicity First) — e.g. `{ term: "kubectl", replacement:
// "kube cuttle" }`, so 006's TTS model reads it the way a narrator would say it aloud.
//
// The digest this module computes becomes `SynthesisRequest.lexiconDigest` (types.ts) — part of
// the full object cache.ts's `hashSynthesisRequest` hashes, so a lexicon change changes the cache
// key automatically (design.md D1, D6; spec.md AC10). Only entries that actually matched
// something in the given text are included in the digest (spec.md Edge Cases: "Lexicon entry
// covers a word that never appears in a given scene's narration — no-op for that scene, does not
// affect its cache key").

import { createHash } from "node:crypto";

/** A single lexicon entry: a `term` (matched whole-word, case-insensitively) and the literal
 * `replacement` text substituted in its place. No phonetic alphabet, no per-language variants —
 * just text-in/text-out respelling (Rule 2, Simplicity First). */
export interface LexiconEntry {
  term: string;
  replacement: string;
}

/** A project pronunciation lexicon: an ordered list of entries. Order only matters in that
 * entries are applied in list order; applying two entries whose terms overlap is a lexicon-
 * authoring concern, not something this module resolves. */
export type Lexicon = LexiconEntry[];

/** Escapes `value` for safe interpolation into a `RegExp` source string (i.e. every regex
 * metacharacter is escaped) — a lexicon `term` is arbitrary text, not a regex pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Applies every entry in `lexicon` to `text` in list order: each entry's `term` is matched whole-
 * word (`\b`-delimited), case-insensitively, and every match is replaced with `replacement`
 * (spec.md FR10). Returns both the resulting `text` and `appliedEntries` — the subset of
 * `lexicon` whose `term` actually matched at least once in the *original* `text` (spec.md Edge
 * Cases: an entry for a word absent from the given text must not appear in `appliedEntries`, so
 * it never influences that text's `resolveLexiconDigest`/cache key). */
export function applyLexicon(
  text: string,
  lexicon: Lexicon,
): { text: string; appliedEntries: LexiconEntry[] } {
  let result = text;
  const appliedEntries: LexiconEntry[] = [];

  for (const entry of lexicon) {
    const pattern = new RegExp(`\\b${escapeRegExp(entry.term)}\\b`, "i");
    if (pattern.test(text)) {
      appliedEntries.push(entry);
      result = result.replace(new RegExp(`\\b${escapeRegExp(entry.term)}\\b`, "gi"), entry.replacement);
    }
  }

  return { text: result, appliedEntries };
}

/** SHA-256 hex digest of `appliedEntries`' canonical (sorted-by-`term`) JSON serialization —
 * `SynthesisRequest.lexiconDigest` (types.ts, spec.md FR10). Sorting by `term` first makes the
 * digest independent of the order `applyLexicon` happened to encounter entries in (same
 * "canonical ordering before hashing" discipline as cache.ts's `canonicalize`).
 *
 * Empty-array convention: an empty `appliedEntries` returns `""` directly rather than hashing
 * `"[]"` — this matches the `""` sentinel `types.ts` documents on `SynthesisRequest.lexiconDigest`
 * ("`""` when lexicon unused"/no entry applies), so "lexicon not used for this text" and "lexicon
 * used but produced this particular hash" are never confusable via a coincidental hash value. */
export function resolveLexiconDigest(appliedEntries: LexiconEntry[]): string {
  if (appliedEntries.length === 0) return "";

  const canonical = [...appliedEntries].sort((a, b) => a.term.localeCompare(b.term));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
