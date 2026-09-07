// Compile-time-only Shiki bridge (spec.md FR2/FR3/FR4). This is the *one* file in
// `@claudevid/layer-code` allowed to import `shiki` — `render.ts`/`animations.ts`/`diff.ts`/
// `annotate.ts` never do (spec.md NFR2, enforced by a grep-based test in a later task).
//
// Fine-grained bundle (`shiki/core` + `shiki/engine/javascript`, per spec.md FR2's "fine-grained
// bundling decision"): statically imports exactly the 8 langs / 3 themes named there, via
// Shiki's own per-lang/per-theme dist subpaths (`shiki/langs/<id>.mjs`, `shiki/themes/<id>.mjs`)
// rather than `shiki/langs`/`shiki/themes` (which bundle Shiki's *entire* grammar/theme
// library). No dynamic `import()` at tokenize time and no network/disk fetch (design.md NFR5) —
// every lang/theme module below is a static `import` resolved once at this module's own load.
import { createHighlighterCore, type HighlighterCore, type ThemeRegistrationAny } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import typescriptLang from "shiki/langs/typescript.mjs";
import javascriptLang from "shiki/langs/javascript.mjs";
import tsxLang from "shiki/langs/tsx.mjs";
import jsxLang from "shiki/langs/jsx.mjs";
import pythonLang from "shiki/langs/python.mjs";
import bashLang from "shiki/langs/bash.mjs";
import jsonLang from "shiki/langs/json.mjs";
import yamlLang from "shiki/langs/yaml.mjs";

import githubDarkTheme from "shiki/themes/github-dark.mjs";
import githubLightTheme from "shiki/themes/github-light.mjs";
// Shiki has no theme literally named "high-contrast" — `themes.ts`'s own doc comment documents
// reusing Shiki's `github-dark-high-contrast` (GitHub's own accessibility-reviewed palette)
// under this package's `"high-contrast"` id. The theme's internal `name` is overridden below (at
// registration, not by mutating the imported module) so `codeToTokensBase({ theme: "high-contrast" })`
// resolves it the same way it resolves the other two.
import githubDarkHighContrastTheme from "shiki/themes/github-dark-high-contrast.mjs";

import type { Diagnostic, Timeline, VideoSpec } from "@claudevid/core";
import { BUNDLED_LANGS, BUNDLED_THEMES, type CodeLayer } from "./schema.js";

export interface Token {
  text: string;
  color: string;
  fontStyle: number;
}

export interface TokenizedCodeLine {
  tokens: Token[];
}

/** FR4's IR: a plain, serializable object — no class instances, no functions, no Shiki types.
 * `JSON.parse(JSON.stringify(ir))` must deep-equal `ir` (AC1); every field below is always a
 * concrete `string`/`number`, never `undefined`, so nothing is dropped in that round-trip. */
export interface TokenizedCode {
  lines: TokenizedCodeLine[];
}

// Shiki's raw grammar registration for the bundled "bash" id is named "shellscript" (its
// TextMate grammar's own internal `name`, not aliased at the grammar-file level) — `langAlias`
// maps the spec-facing id this package advertises (`BUNDLED_LANGS`'s "bash") onto it, the same
// way a caller of `createHighlighterCore` would for any grammar whose file-level name differs
// from its public id.
const LANG_ALIAS: Record<string, string> = { bash: "shellscript" };

// Module-level singleton (spec.md FR2): `createHighlighterCore` is called at most once per
// process, lazily, on first use — never at module load (no top-level `await`) and never more
// than once even if multiple `compileCodeLayers` calls race, since the in-flight `Promise` is
// itself cached before it settles.
let highlighterPromise: Promise<HighlighterCore> | undefined;

function createHighlighter(): Promise<HighlighterCore> {
  const highContrastTheme: ThemeRegistrationAny = { ...githubDarkHighContrastTheme, name: "high-contrast" };
  return createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    langs: [typescriptLang, javascriptLang, tsxLang, jsxLang, pythonLang, bashLang, jsonLang, yamlLang],
    themes: [githubDarkTheme, githubLightTheme, highContrastTheme],
    langAlias: LANG_ALIAS,
  });
}

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) highlighterPromise = createHighlighter();
  return highlighterPromise;
}

/** Test-only introspection — lets a later test (T12, AC2's dedupe spy) get at the same
 * singleton instance `compileCodeLayers` uses, mirroring this codebase's existing
 * underscore-prefixed test-hook convention (`text.ts`'s `_layoutCacheSizeForTests`,
 * `compile.ts`'s test-only export). */
export function _getHighlighterCoreForTests(): Promise<HighlighterCore> {
  return getHighlighter();
}

// Plain string-join "hash" (mirrors `renderer-canvas/src/text.ts`'s `contentHash`) — a `Map`
// key only needs to be unique/stable across a single `compileCodeLayers` call, not
// cryptographic.
function contentHash(code: string, lang: string, theme: string): string {
  return [lang, theme, code].join("|");
}

function isBundledLang(lang: string): lang is (typeof BUNDLED_LANGS)[number] {
  return (BUNDLED_LANGS as readonly string[]).includes(lang);
}

function isBundledTheme(theme: string): theme is (typeof BUNDLED_THEMES)[number] {
  return (BUNDLED_THEMES as readonly string[]).includes(theme);
}

function unsupportedLangDiagnostic(layerKey: string, lang: string): Diagnostic {
  return {
    path: `/${layerKey}/lang`,
    message: `unsupported language "${lang}"`,
    suggestion: `use one of the bundled languages: ${BUNDLED_LANGS.join(", ")}`,
  };
}

function unsupportedThemeDiagnostic(layerKey: string, theme: string): Diagnostic {
  return {
    path: `/${layerKey}/theme`,
    message: `unsupported theme "${theme}"`,
    suggestion: `use one of the bundled themes: ${BUNDLED_THEMES.join(", ")}`,
  };
}

// `core.Layer` (`packages/core/src/layers.ts`) is a closed static union with no "code" member —
// `registerLayer` only extends the *runtime* Zod union (design.md's "`TimelineLayer.layer`
// narrowing" section). Comparing `tl.layer.type` against the literal `"code"` directly would be
// a `string`-literal-union-has-no-overlap type error, so the check goes through a
// structurally-typed guard (`{ type: string }`, not `core.Layer`) instead — the same pattern
// design.md documents for this gap.
function isCodeLayer(layer: { type: string }): layer is CodeLayer {
  return layer.type === "code";
}

function toTokenizedCode(themedLines: { content: string; color?: string; fontStyle?: number }[][]): TokenizedCode {
  return {
    lines: themedLines.map((lineTokens) => ({
      tokens: lineTokens.map((t) => ({ text: t.content, color: t.color ?? "", fontStyle: t.fontStyle ?? 0 })),
    })),
  };
}

export interface CompileCodeLayersResult {
  compiled: Map<string, TokenizedCode>;
  diagnostics: Diagnostic[];
}

/**
 * The compile-time entry point (spec.md FR3, design.md's Technical Approach diagram) — same
 * two-argument `(spec, timeline)` shape as `@claudevid/motion`'s `compileMotion`. Walks every
 * `code`-typed layer in `timeline.layers` (already flattened by `compileTimeline`), tokenizes
 * each exactly once (deduped across layers by a `(code, lang, theme)` content hash — FR3/AC2),
 * and returns a plain `Map<layerKey, TokenizedCode>` plus any diagnostics.
 *
 * An unknown `lang` or `theme` never throws (AC3): it produces a diagnostic and that layer is
 * simply absent from `compiled` — the same "diagnostic pushed, entry skipped" disposition
 * `compileMotion` already uses for an unknown animation preset name.
 *
 * Layout (measure/wrap/fit-to-width) and overflow diagnostics are a later task's concern
 * (`layout.ts`/`diagnostics.ts`, T4/T5) — this function's `compiled` values are exactly FR4's
 * `TokenizedCode`, not yet the `{ ir, layout, blocked }`-shaped entry `render.ts` eventually
 * consumes; a later task extends this compiled map with that layout/overflow information.
 */
export async function compileCodeLayers(spec: VideoSpec, timeline: Timeline): Promise<CompileCodeLayersResult> {
  void spec; // no field of `spec` itself is needed yet — kept for signature parity with `compileMotion(spec, timeline)`.

  const diagnostics: Diagnostic[] = [];
  const compiled = new Map<string, TokenizedCode>();
  const tokenizeCache = new Map<string, TokenizedCode>();
  let highlighter: HighlighterCore | undefined;

  for (const tl of timeline.layers) {
    if (!isCodeLayer(tl.layer)) continue;
    // `Layer`'s union members each pin `type` to their own literal, so plain control-flow
    // narrowing collapses to `never` here rather than `CodeLayer` — the explicit cast is the
    // one place this file crosses that static-type gap (design.md's documented disposition,
    // not an accidental unsoundness: `isCodeLayer` above is the actual runtime check).
    const layer = tl.layer as CodeLayer;
    const lang = layer.lang;
    const theme = layer.theme ?? "github-dark";

    let ok = true;
    if (!isBundledLang(lang)) {
      diagnostics.push(unsupportedLangDiagnostic(tl.layerKey, lang));
      ok = false;
    }
    if (!isBundledTheme(theme)) {
      diagnostics.push(unsupportedThemeDiagnostic(tl.layerKey, theme));
      ok = false;
    }
    if (!ok) continue;

    const key = contentHash(layer.code, lang, theme);
    let tokenized = tokenizeCache.get(key);
    if (!tokenized) {
      if (!highlighter) highlighter = await getHighlighter();
      const themedLines = highlighter.codeToTokensBase(layer.code, { lang, theme });
      tokenized = toTokenizedCode(themedLines);
      tokenizeCache.set(key, tokenized);
    }
    compiled.set(tl.layerKey, tokenized);
  }

  return { compiled, diagnostics };
}
