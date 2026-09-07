import { defineConfig } from "tsup";

// Two entries, two audiences: `cli.ts` is the `bin`, `index.ts` is the library facade the
// published package exposes via `import`. `dts` is on only for `index.ts` — the bin has no
// importable surface. The emitted `.d.ts` still imports `@claudevid/*` (rollup-dts treats
// workspace symlinks as external whatever `dts.resolve` says); `scripts/build-dist-package.mjs`
// rewrites those to bundled relative paths.
//
// `noExternal` inlines every workspace package, since they are all `private: true` and
// unresolvable outside this monorepo. `external` then pins back every third-party package they
// depend on: inlining a workspace package moves its imports into *this* bundle, and esbuild
// only treats an import as external by default when it appears in this package's own
// `dependencies`. Without these patterns `onnxruntime-node` gets bundled and its native binding
// breaks at load ("listSupportedBackends is not a function"). Every name below is therefore also
// a real dependency in this package's `package.json`.
const THIRD_PARTY = [
  /^onnxruntime-node(\/|$)/,
  /^kokoro-js(\/|$)/,
  /^@huggingface\/transformers(\/|$)/,
  /^@napi-rs\/canvas(\/|$)/,
  /^@fontsource\//,
  /^shiki(\/|$)/, // subpath imports (shiki/langs/*.mjs, shiki/themes/*.mjs) must stay external too
  /^zod(-to-json-schema)?(\/|$)/,
  /^@anthropic-ai\/sdk(\/|$)/,
];

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  sourcemap: true,
  clean: true,
  noExternal: [/^@claudevid\//],
  external: THIRD_PARTY,
});
