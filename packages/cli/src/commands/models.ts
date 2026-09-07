// `claudevid models install` (spec.md FR13/AC9, design.md D6: "thin wrapper, not a
// reimplementation"). `installModels` itself (fetch, digest verification, cache write) already
// exists and is already tested in `@claudevid/audio` (change 006's AC10) — this file adds only
// the CLI-facing success/failure framing and exit code, per Rule 2 (Simplicity First).

import { installModels as installModelsReal } from "@claudevid/audio";

export interface ModelsInstallDeps {
  installModels: typeof installModelsReal;
}

/**
 * Pure command logic, testable with an injected `installModels` fake (NFR3) — no real network
 * access or filesystem writes. Never lets a rejection propagate: catches it and turns it into
 * `{ ok: false, message }` so the CLI wrapper below can print and exit cleanly.
 */
export async function runModelsInstall(
  deps: ModelsInstallDeps,
): Promise<{ ok: boolean; message: string }> {
  try {
    await deps.installModels();
    return { ok: true, message: "models installed successfully" };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/**
 * Real (non-DI) entry point. Wires up the real `@claudevid/audio` `installModels`, prints the
 * result message, and sets `process.exitCode` — called by `cli.ts`'s command dispatch.
 */
export async function runModelsInstallFromCli(_argv: string[]): Promise<void> {
  const { ok, message } = await runModelsInstall({ installModels: installModelsReal });
  console.log(message);
  process.exitCode = ok ? 0 : 1;
}
