// `claudevid models install` (spec.md FR13/AC9, design.md D6: "thin wrapper, not a
// reimplementation"). `installModels` itself (fetch, digest verification, cache write) already
// exists and is already tested in `@claudevid/audio` (change 006's AC10) — this file adds only
// the CLI-facing success/failure framing and exit code, per Rule 2 (Simplicity First).
//
// Since change 012 the success message also names the resolved install path (012 spec.md FR6).
// Models are now cached machine-wide rather than per-project, so "where did my ~330 MB go" is a
// question a user can reasonably have, and the answer should not require reading source or
// guessing at an OS cache convention. GOALS.md makes `models install` the sanctioned way to
// pre-fetch ("No implicit network fetch during an ordinary render — gate it behind `claudevid
// models install`"), which makes this the right place to say where things landed.

import { installModels as installModelsReal, resolveModelsRoot as resolveModelsRootReal } from "@claudevid/audio";

export interface ModelsInstallDeps {
  installModels: typeof installModelsReal;
  resolveModelsRoot: typeof resolveModelsRootReal;
}

/**
 * Pure command logic, testable with injected `installModels`/`resolveModelsRoot` fakes (NFR3) — no
 * real network access or filesystem writes. Never lets a rejection propagate: catches it and turns
 * it into `{ ok: false, message }` so the CLI wrapper below can print and exit cleanly.
 */
export async function runModelsInstall(
  deps: ModelsInstallDeps,
): Promise<{ ok: boolean; message: string }> {
  try {
    await deps.installModels();
    return { ok: true, message: `models installed successfully → ${deps.resolveModelsRoot()}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/**
 * Real (non-DI) entry point. Wires up the real `@claudevid/audio` `installModels`, prints the
 * result message, and sets `process.exitCode` — called by `cli.ts`'s command dispatch.
 */
export async function runModelsInstallFromCli(_argv: string[]): Promise<void> {
  const { ok, message } = await runModelsInstall({
    installModels: installModelsReal,
    resolveModelsRoot: resolveModelsRootReal,
  });
  console.log(message);
  process.exitCode = ok ? 0 : 1;
}
