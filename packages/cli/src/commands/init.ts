// `claudevid init` (spec.md FR1/AC1). Scaffolds claudevid.config.json, .claudevid/.gitignore, and
// specs/example.json in the current directory. Refuses to overwrite an existing
// claudevid.config.json unless --force (mirrors tools/motion-preview's no-clobber pattern).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { ArgError, hasFlag } from "../args.js";

export interface InitOptions {
  force?: boolean;
}

export interface InitDeps {
  cwd: string;
  exists: (path: string) => boolean;
  readFile: (path: string) => string; // reads the template source files
  writeFile: (path: string, content: string) => void;
  mkdir: (path: string) => void; // recursive mkdir
}

// Logical names for the two repo-root `templates/` source files this command copies. These are
// not real filesystem paths — `deps.readFile` is responsible for resolving them (the real
// resolution, relative to this package's own installed location, happens in `runInitFromCli`
// below; tests supply their own fakes keyed by these same names).
const CONFIG_TEMPLATE = "claudevid.config.json";
const EXAMPLE_SPEC_TEMPLATE = "example-spec.json";

/**
 * Pure scaffolding logic, testable with fully injected fakes (no real disk I/O). Throws an
 * `ArgError` and writes nothing if `claudevid.config.json` already exists under `deps.cwd` and
 * `opts.force` is not set.
 */
export function runInit(opts: InitOptions, deps: InitDeps): void {
  const configPath = join(deps.cwd, "claudevid.config.json");
  if (!opts.force && deps.exists(configPath)) {
    throw new ArgError(`refusing to overwrite existing "${configPath}" without --force`);
  }

  const configContent = deps.readFile(CONFIG_TEMPLATE);
  const exampleSpecContent = deps.readFile(EXAMPLE_SPEC_TEMPLATE);

  deps.writeFile(configPath, configContent);

  deps.mkdir(join(deps.cwd, ".claudevid"));
  deps.writeFile(join(deps.cwd, ".claudevid", ".gitignore"), "*\n");

  deps.mkdir(join(deps.cwd, "specs"));
  deps.writeFile(join(deps.cwd, "specs", "example.json"), exampleSpecContent);
}

/**
 * Real (non-DI) entry point. Resolves the actual `templates/` source paths relative to this
 * package's own installed location (via `import.meta.url` — never `process.cwd()`, since the CLI
 * runs from an arbitrary user project directory, not this repo), wires up real fs functions, and
 * runs `runInit`. Called by `cli.ts`'s command dispatch.
 */
export function runInitFromCli(argv: string[]): void {
  const force = hasFlag(argv, "--force");
  // packages/cli/dist/cli.js -> repo-root/templates (tsup bundles this package to a single
  // dist/cli.js, so import.meta.url here resolves to that bundled file's location at runtime).
  const templatesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../templates");

  const deps: InitDeps = {
    cwd: process.cwd(),
    exists: existsSync,
    readFile: (path) => readFileSync(join(templatesDir, path), "utf-8"),
    writeFile: (path, content) => writeFileSync(path, content, "utf-8"),
    mkdir: (path) => mkdirSync(path, { recursive: true }),
  };

  runInit({ force }, deps);
}
