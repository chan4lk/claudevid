// Single place every `Diagnostic` in this package is constructed (spec.md FR13, design.md
// Architecture: "diagnostics.ts — all Diagnostic construction for this package"). Reuses
// `@claudevid/core`'s `Diagnostic` type directly — `{ path, message, suggestion }`, no local
// redefinition (spec.md FR13's explicit instruction; `packages/core/src/diagnostics.ts:5-9`).
import type { Diagnostic } from "@claudevid/core";
import { BUNDLED_LANGS, BUNDLED_THEMES } from "./schema.js";
import type { LayoutResult } from "./layout.js";

// --- Unsupported lang/theme (spec.md FR2/FR13, AC3) ------------------------------------------
//
// `lang`/`theme` are free strings validated here rather than a Zod enum (design.md Key Decision
// D5 — a Zod enum violation would route through `parseSpec`'s generic `suggestionFor`, which has
// no case for `invalid_enum_value` and would leave `suggestion: undefined`; hand-authoring the
// message/suggestion here is what lets AC3 require "lists all 8 bundled langs by name"). Byte-
// identical in shape to what `highlight.ts` constructed inline before this task — `highlight.ts`
// now imports these two builders instead of duplicating them (single mental model, FR13).

export function unsupportedLangDiagnostic(layerKey: string, lang: string): Diagnostic {
  return {
    path: `/${layerKey}/lang`,
    message: `unsupported language "${lang}"`,
    suggestion: `use one of the bundled languages: ${BUNDLED_LANGS.join(", ")}`,
  };
}

export function unsupportedThemeDiagnostic(layerKey: string, theme: string): Diagnostic {
  return {
    path: `/${layerKey}/theme`,
    message: `unsupported theme "${theme}"`,
    suggestion: `use one of the bundled themes: ${BUNDLED_THEMES.join(", ")}`,
  };
}

// --- Line-overflow / line-too-long-to-fit (spec.md FR6/FR7/FR13, AC5/AC6) --------------------

/** FR6: the effective line count (after wrap expansion) exceeding `min(maxLines ?? Infinity,
 * availableLines)` with no `scroll` config present — "a diagnostic naming the actual line count
 * and the max that fits, with a suggestion listing all three fixes (shorten the snippet,
 * increase `height`, or add a `scroll` config)". */
export function lineOverflowDiagnostic(layerKey: string, actualLines: number, maxLines: number): Diagnostic {
  return {
    path: `/${layerKey}`,
    message: `code block has ${actualLines} lines, but only ${maxLines} fit`,
    suggestion: `shorten the snippet to ${maxLines} lines or fewer, increase height, or add a scroll config`,
  };
}

/** FR6: `wrap: "none"` and no font size down to the floor (`layout.ts`'s `AUTO_FIT_FLOOR_PX`)
 * makes the longest line fit — "a diagnostic naming the longest line's character count and the
 * fitting fontSize gap". `layoutCode` pins `LayoutResult.fontSize` at the floor when
 * `widthFits` is `false` (its own comment: "stays at the floor ... even though it doesn't
 * fit"), so that pinned value *is* the fontSize the retry gave up at — named here directly
 * rather than re-derived. */
export function lineTooLongDiagnostic(layerKey: string, longestLineCharCount: number, flooredFontSize: number): Diagnostic {
  return {
    path: `/${layerKey}`,
    message: `longest line is ${longestLineCharCount} characters and does not fit within the available width even at the minimum font size (${flooredFontSize}px)`,
    suggestion: `shorten the longest line, increase width, or set wrap: "soft" to wrap it instead of failing to fit`,
  };
}

/** Runs both of FR6's compile-time layout guardrails against an already-computed `LayoutResult`
 * (`layout.ts`'s `layoutCode`, T4) and returns the small `{ diagnostics, blocked }` shape a
 * later task (T7's `paintCodeLayer`, via the compiled entry's own `blocked` field — design.md's
 * `CompiledCodeLayer { ir, layout, blocked }`) consumes to decide whether to throw
 * `CodeOverflowError` before painting anything (spec.md FR7 — the second guardrail; this
 * function is the first). A `scroll` config exempts only the line-overflow check (FR6's scroll
 * exemption, AC6) — the width-fit check always applies, scroll or not, since it fits the
 * visible window independently. */
export function checkLayoutDiagnostics(
  layerKey: string,
  layout: LayoutResult,
  options: { maxLines?: number; hasScroll: boolean },
): { diagnostics: Diagnostic[]; blocked: boolean } {
  const diagnostics: Diagnostic[] = [];
  let blocked = false;

  if (!layout.widthFits) {
    diagnostics.push(lineTooLongDiagnostic(layerKey, layout.longestLineCharCount, layout.fontSize));
    blocked = true;
  }

  if (!options.hasScroll) {
    const maxAllowed = Math.min(options.maxLines ?? Infinity, layout.availableLines);
    if (layout.totalRows > maxAllowed) {
      diagnostics.push(lineOverflowDiagnostic(layerKey, layout.totalRows, maxAllowed));
      blocked = true;
    }
  }

  return { diagnostics, blocked };
}

// --- Out-of-range line references (spec.md FR12/FR13, Edge Cases) ----------------------------
//
// `focus.lines`, `scroll.toLine`, or any `annotations[].line` referencing a line number outside
// `[1, codeLineCount]`: a diagnostic, never silently clamped — the authored-content-mistake
// precedent (Edge Cases), distinct from 002/003's separate "clamp, don't diagnose" precedent for
// *rendering-time* frame overflow (design.md's Grounding explains why this case is the former).

function outOfRangeLineDiagnostic(layerKey: string, field: string, line: number, codeLineCount: number): Diagnostic {
  return {
    path: `/${layerKey}/${field}`,
    message: `line ${line} is outside the valid range of this code block's ${codeLineCount} line${codeLineCount === 1 ? "" : "s"} ([1, ${codeLineCount}])`,
    suggestion: `use a line number between 1 and ${codeLineCount}`,
  };
}

export function focusLinesOutOfRangeDiagnostic(layerKey: string, line: number, codeLineCount: number): Diagnostic {
  return outOfRangeLineDiagnostic(layerKey, "focus/lines", line, codeLineCount);
}

export function scrollToLineOutOfRangeDiagnostic(layerKey: string, line: number, codeLineCount: number): Diagnostic {
  return outOfRangeLineDiagnostic(layerKey, "scroll/toLine", line, codeLineCount);
}

export function annotationLineOutOfRangeDiagnostic(
  layerKey: string,
  index: number,
  line: number,
  codeLineCount: number,
): Diagnostic {
  return outOfRangeLineDiagnostic(layerKey, `annotations/${index}/line`, line, codeLineCount);
}
