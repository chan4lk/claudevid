import { GlobalFonts } from "@napi-rs/canvas";
import { fileURLToPath } from "node:url";

export const SANS_FONT_FAMILY = "Inter, sans-serif";
export const MONO_FONT_FAMILY = "JetBrains Mono, monospace";

const FONTS: Array<[specifier: string, family: string]> = [
  ["@fontsource/inter/files/inter-latin-400-normal.woff2", "Inter"],
  ["@fontsource/inter/files/inter-latin-700-normal.woff2", "Inter"],
  ["@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2", "JetBrains Mono"],
];

let registered = false;

export function registerBundledFonts(): void {
  if (registered) return;
  for (const [specifier, family] of FONTS) {
    const path = fileURLToPath(import.meta.resolve(specifier));
    GlobalFonts.registerFromPath(path, family);
  }
  registered = true;
}
