// NFR2 — "Tokenization is compile-time-only. No file under
// packages/layer-code/src/render.ts, animations.ts, diff.ts, or annotate.ts imports shiki or
// highlight.ts." `highlight.ts` is the one file in this package allowed to import `shiki` (its
// own header comment says as much); everything downstream of `compileCodeLayers` must consume
// only its plain-data `TokenizedCode` output (FR4/NFR1), never a live highlighter instance or
// Shiki's own types.
//
// A grep-based test on the raw source text (not a module-graph/bundler analysis) is deliberately
// simple and hard to defeat by accident: it catches the two ways this constraint could regress —
// `import ... from "shiki"` (or any `shiki/...` subpath), and `import ... from "./highlight.js"`
// (or `.ts`) — without needing to actually resolve/execute the module graph.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "..", "src");

const GUARDED_FILES = ["render.ts", "animations.ts", "diff.ts", "annotate.ts"];

const SHIKI_IMPORT_RE = /from\s+["']shiki(\/[^"']*)?["']|require\(\s*["']shiki(\/[^"']*)?["']\s*\)/;
const HIGHLIGHT_JS_IMPORT_RE = /from\s+["']highlight\.js["']|require\(\s*["']highlight\.js["']\s*\)/;
const HIGHLIGHT_TS_MODULE_IMPORT_RE = /from\s+["']\.\/highlight\.(js|ts)["']/;

describe("NFR2 — no shiki/highlight.js/highlight.ts import outside highlight.ts", () => {
  for (const file of GUARDED_FILES) {
    it(`${file} does not import "shiki" (or any shiki/* subpath)`, () => {
      const source = readFileSync(join(SRC_DIR, file), "utf8");
      expect(source).not.toMatch(SHIKI_IMPORT_RE);
    });

    it(`${file} does not import the "highlight.js" package`, () => {
      const source = readFileSync(join(SRC_DIR, file), "utf8");
      expect(source).not.toMatch(HIGHLIGHT_JS_IMPORT_RE);
    });

    it(`${file} does not import this package's own ./highlight.ts (the one file allowed to hold a live Shiki instance)`, () => {
      const source = readFileSync(join(SRC_DIR, file), "utf8");
      expect(source).not.toMatch(HIGHLIGHT_TS_MODULE_IMPORT_RE);
    });
  }

  // Sanity check on the guard itself: highlight.ts legitimately imports "shiki" — if this ever
  // stopped matching, the regexes above would be silently testing nothing.
  it("sanity: the shiki-import regex does match highlight.ts's own real imports", () => {
    const source = readFileSync(join(SRC_DIR, "highlight.ts"), "utf8");
    expect(source).toMatch(SHIKI_IMPORT_RE);
  });
});
