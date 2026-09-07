// Bundled Shiki theme data (spec.md FR2) plus a compile-time-only, WCAG contrast auditor for
// each bundled theme's token palette (spec.md FR15 / AC12).
//
// `BUNDLED_THEMES` (the id list) is defined once, in `schema.ts` (the Zod schema needs the
// literal tuple for its own validation), and re-exported here rather than duplicated — this
// file supplies the theme *content* `schema.ts`'s id list refers to, per design.md's
// Architecture note describing `themes.ts` as holding "BUNDLED_THEMES data,
// checkThemeContrast()".

import { BUNDLED_THEMES } from "./schema.js";

export { BUNDLED_THEMES };
export type BundledTheme = (typeof BUNDLED_THEMES)[number];

/**
 * Background colour and distinct token foreground palette for each bundled theme, copied
 * verbatim from Shiki's own first-party theme JSON (`@shikijs/themes@4.4.3` — an existing
 * transitive dependency of this package's `shiki` dependency; the values below are not
 * invented). `github-dark`/`github-light` are Shiki's own themes of those names.
 * `"high-contrast"` is not one of Shiki's own theme ids — rather than hand-authoring a palette
 * this package could not otherwise verify, it reuses Shiki's `github-dark-high-contrast` theme
 * verbatim (GitHub's own accessibility-reviewed high-contrast palette), under this package's
 * `"high-contrast"` id.
 *
 * Each `tokenColors` list excludes token rules that carry their own `settings.background`
 * override in the source theme (e.g. carriage-return glyphs, git conflict-marker chips): those
 * foregrounds are never composited against the theme's plain editor background, so comparing
 * them to it would be a category error, not a real contrast measurement. `highlight.ts` (which
 * builds the actual Shiki highlighter, per spec.md FR2) is the source of truth for the theme
 * *registrations* passed to `createHighlighterCore`; this table only needs the subset of theme
 * content this module's own contrast check depends on.
 */
const THEME_PALETTES: Record<BundledTheme, { background: string; tokenColors: readonly string[] }> = {
  "github-dark": {
    background: "#24292e",
    tokenColors: [
      "#6a737d",
      "#79b8ff",
      "#85e89d",
      "#9ecbff",
      "#b392f0",
      "#d1d5da",
      "#dbedff",
      "#e1e4e8",
      "#f97583",
      "#fdaeb7",
      "#ffab70",
    ],
  },
  "github-light": {
    background: "#ffffff",
    tokenColors: [
      "#005cc5",
      "#032f62",
      "#22863a",
      "#24292e",
      "#586069",
      "#6a737d",
      "#6f42c1",
      "#b31d28",
      "#d73a49",
      "#e36209",
    ],
  },
  "high-contrast": {
    background: "#0a0c10",
    tokenColors: [
      "#72f088",
      "#91cbff",
      "#addcff",
      "#bdc4cc",
      "#dbb7ff",
      "#f0f3f6",
      "#ff9492",
      "#ffb1af",
      "#ffb757",
    ],
  },
};

// --- WCAG 2.1 relative luminance / contrast ratio ---
// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
// https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
// Pure numeric functions — no canvas/DOM dependency.

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean.slice(0, 6);
  const r = parseInt(expanded.slice(0, 2), 16);
  const g = parseInt(expanded.slice(2, 4), 16);
  const b = parseInt(expanded.slice(4, 6), 16);
  return [r, g, b];
}

function srgbChannelToLinear(channel8bit: number): number {
  const c = channel8bit / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}

/** WCAG contrast ratio between two colours — always in `[1, 21]`. */
export function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface ThemeContrastEntry {
  colorHex: string;
  ratio: number;
}

/**
 * Computes the WCAG contrast ratio between every distinct token colour a bundled theme's
 * palette defines and that theme's own background colour (spec.md FR15). Pure and synchronous
 * — reads this module's own declared theme colours, never invokes Shiki's tokenizer. Runs as a
 * test-time check (AC12), not a runtime gate: bundled themes are first-party, reviewed content,
 * not spec-authored input.
 */
export function checkThemeContrast(theme: BundledTheme): ThemeContrastEntry[] {
  const palette = THEME_PALETTES[theme];
  return palette.tokenColors.map((colorHex) => ({
    colorHex,
    ratio: contrastRatio(colorHex, palette.background),
  }));
}
