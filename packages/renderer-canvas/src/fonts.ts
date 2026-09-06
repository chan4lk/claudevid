import { GlobalFonts } from "@napi-rs/canvas";
import { createRequire } from "node:module";

// `import.meta.resolve` isn't implemented by vite-node (vitest's module runner), which
// would make this function throw under this package's own test suite. `createRequire`
// resolves the same package-relative paths and works under both plain Node and vite-node.
const resolve = createRequire(import.meta.url).resolve;

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
    GlobalFonts.registerFromPath(resolve(specifier), family);
  }
  registered = true;
}
