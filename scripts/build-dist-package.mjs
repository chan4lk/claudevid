#!/usr/bin/env node
// Assembles the distributable `claudevid` npm package from this monorepo, and packs it into a
// tarball you can install anywhere: `npm install /path/to/claudevid-<version>.tgz`.
//
// Why a build step rather than plain `npm publish` of the workspace: every `@claudevid/*`
// package is `private: true` and they reference each other with `workspace:*`, so none of them
// is independently installable. `packages/cli` is therefore the single distributable facade —
// its tsup config inlines all of them into `dist/cli.js` (the bin) and `dist/index.js` (the
// library entry), leaving only genuine third-party packages as external `dependencies`.
//
// The one thing tsup cannot do here is the type story: rollup-dts treats workspace symlinks as
// external no matter what `dts.resolve` is set to, so the emitted `index.d.ts` still says
// `from '@claudevid/core'` — an import that resolves to nothing on a consumer's machine. This
// script copies each workspace package's own `.d.ts` into `dist/types/` and rewrites those
// specifiers to relative paths, recursively (the workspace type files reference each other too).
//
// Usage: node scripts/build-dist-package.mjs [--skip-build]

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist-package");
const SKILL_SRC = path.join(ROOT, ".claude/skills/video-generator");

// Workspace packages whose types are reachable from the library facade's `index.d.ts`.
// `@claudevid/claude` and `@claudevid/bench` are bundled into the CLI but not re-exported, so
// they contribute no types a consumer can name.
const TYPED_PACKAGES = [
  "core",
  "motion",
  "renderer-canvas",
  "encoder-ffmpeg",
  "audio",
  "layer-code",
  "layer-captions",
];

const PKG_VERSION = "0.1.0";

function run(cmd, args, cwd = ROOT) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

/** Rewrites `@claudevid/<name>` specifiers to `<prefix><name>.js`. Applied to the facade's
 * `index.d.ts` (prefix `./types/`) and to each copied workspace `.d.ts` (prefix `./`, since they
 * all land in the same directory).
 *
 * The `.js` extension is required, not cosmetic: under `moduleResolution: "nodenext"` TypeScript
 * rejects an extensionless relative import in a declaration file (TS2834), and it maps the `.js`
 * specifier back to the sibling `.d.ts` itself. Emitting `./types/core` instead makes the
 * package fail to typecheck for any consumer on nodenext. */
function rewriteSpecifiers(source, prefix) {
  return source.replace(
    /(['"])@claudevid\/([a-z-]+)\1/g,
    (_match, quote, name) => `${quote}${prefix}${name}.js${quote}`,
  );
}

// --- 1. Build ---------------------------------------------------------------------------------

if (!process.argv.includes("--skip-build")) {
  console.log("building workspace...");
  run("pnpm", ["-r", "run", "build"]);
}

const cliDist = path.join(ROOT, "packages/cli/dist");
if (!fs.existsSync(path.join(cliDist, "cli.js"))) {
  throw new Error(`packages/cli/dist/cli.js missing — run \`pnpm build\` first (looked in ${cliDist})`);
}

// --- 2. Assemble ------------------------------------------------------------------------------

console.log(`assembling ${path.relative(ROOT, OUT)}/ ...`);
rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

// The bundled runtime: cli.js (bin), index.js (library), their shared chunks, and sourcemaps.
copyDir(cliDist, path.join(OUT, "dist"));

// Types: copy each workspace package's declarations in, then rewrite every cross-reference.
const typesDir = path.join(OUT, "dist/types");
fs.mkdirSync(typesDir, { recursive: true });
for (const name of TYPED_PACKAGES) {
  const src = path.join(ROOT, "packages", name, "dist/index.d.ts");
  if (!fs.existsSync(src)) throw new Error(`missing types for @claudevid/${name} at ${src}`);
  fs.writeFileSync(path.join(typesDir, `${name}.d.ts`), rewriteSpecifiers(fs.readFileSync(src, "utf8"), "./"));
}
const facade = path.join(OUT, "dist/index.d.ts");
fs.writeFileSync(facade, rewriteSpecifiers(fs.readFileSync(facade, "utf8"), "./types/"));

// `claudevid init` scaffolds from these; init.ts probes `<pkg>/templates` first.
copyDir(path.join(ROOT, "templates"), path.join(OUT, "templates"));

// The Claude Code skill, copied verbatim — its scripts already resolve the CLI through Node
// resolution, so they work unchanged once this package is a dependency of the host project.
copyDir(SKILL_SRC, path.join(OUT, "skill"));

// --- 3. package.json --------------------------------------------------------------------------

const cliPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/cli/package.json"), "utf8"));
const dependencies = Object.fromEntries(
  Object.entries(cliPkg.dependencies).filter(([name]) => !name.startsWith("@claudevid/")),
);

fs.writeFileSync(
  path.join(OUT, "package.json"),
  JSON.stringify(
    {
      name: "claudevid",
      version: PKG_VERSION,
      description: "Render a JSON VideoSpec into an MP4 — canvas renderer, motion system, code layers, local TTS.",
      type: "module",
      bin: { claudevid: "./dist/cli.js" },
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./cli": "./dist/cli.js",
        "./skill": "./skill/SKILL.md",
        "./package.json": "./package.json",
      },
      files: ["dist", "templates", "skill", "README.md"],
      engines: { node: ">=22" },
      dependencies,
    },
    null,
    2,
  ) + "\n",
);

// --- 4. README --------------------------------------------------------------------------------

fs.writeFileSync(
  path.join(OUT, "README.md"),
  `# claudevid

Author a video as JSON (a \`VideoSpec\`), render it to MP4. Canvas renderer, motion system,
Shiki code layers, local Kokoro TTS narration, FFmpeg encode.

## Install

\`\`\`bash
npm install /path/to/claudevid-${PKG_VERSION}.tgz
\`\`\`

## Requirements

- **Node >= 22**
- **FFmpeg on \`PATH\`** — not bundled. \`brew install ffmpeg\`, or your platform's equivalent.
- **Native build scripts must be allowed.** \`@napi-rs/canvas\` and \`onnxruntime-node\` ship
  native binaries. pnpm blocks their install scripts by default; if rendering fails at load with
  \`listSupportedBackends is not a function\` or a missing \`.node\` binding, run:

  \`\`\`bash
  pnpm approve-builds        # or: pnpm rebuild @napi-rs/canvas onnxruntime-node
  \`\`\`

- **Narration downloads a model on first use.** Kokoro (~330 MB) is fetched from Hugging Face by
  \`@huggingface/transformers\` the first time a spec with \`narration\` is rendered, and cached
  under \`.claudevid/\` in your project. Specs without \`narration\` need no model and no network.

## CLI

\`\`\`bash
npx claudevid init                                   # scaffold config + example spec
npx claudevid validate spec.json                     # JSON-pointer diagnostics, exit 1 on failure
npx claudevid preview spec.json --sheet sheet.png    # contact sheet of N frames
npx claudevid render spec.json --out video.mp4       # full render (add --captions for subtitles)
\`\`\`

\`render\` prints nothing until it finishes — see Known issues.

## Library

\`\`\`js
import { parseSpec, compileTimeline, renderVideo } from "claudevid";

const parsed = parseSpec(JSON.parse(fs.readFileSync("spec.json", "utf8")));
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics, null, 2));

await renderVideo(parsed.spec, { profileName: "final", outputPath: "video.mp4" });
\`\`\`

\`@claudevid/core\`'s API is re-exported flat; the other packages are namespaced to avoid
collisions (\`motion\`, \`renderer\`, \`encoder\`, \`audio\`, \`layerCode\`, \`layerCaptions\`).

## Claude Code skill

This package ships the \`video-generator\` skill, which lets Claude author and render specs
directly. Copy it into your project:

\`\`\`bash
mkdir -p .claude/skills
cp -R node_modules/claudevid/skill .claude/skills/video-generator
\`\`\`

Its \`scripts/validate.ts\` and \`scripts/render.ts\` locate the CLI through Node resolution, so
they work from any directory depth once \`claudevid\` is installed.

## Known issues

- \`render\` emits no progress output at all until it completes. On a two-minute 1080p video
  that is several minutes of silence. \`pipe.onProgress\` exists internally but is not wired to
  the CLI.
- If a layer fails mid-render (for example a \`code\` block too tall for its \`height\`), the
  FFmpeg child is left alive and blocked on \`read()\` rather than the process failing loudly.
  Validate first, and check for \`code block has N lines, but only M fit\` diagnostics.
`,
);

// --- 5. Pack ----------------------------------------------------------------------------------

console.log("packing...");
run("npm", ["pack", "--pack-destination", ROOT], OUT);

const tarball = path.join(ROOT, `claudevid-${PKG_VERSION}.tgz`);
const sizeMb = (fs.statSync(tarball).size / 1024 / 1024).toFixed(1);
console.log(`\n${path.relative(ROOT, tarball)}  (${sizeMb} MB)`);
console.log(`\nInstall elsewhere with:\n  npm install ${tarball}`);
