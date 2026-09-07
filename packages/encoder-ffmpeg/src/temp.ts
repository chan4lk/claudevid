// Filesystem/process-hygiene lifecycle only (spec.md FR10, design.md's `temp.ts` section).
// `temp.ts` owns the on-disk directory an encode writes into and the SIGINT/SIGTERM handling
// that guarantees no orphaned FFmpeg process survives a killed parent (NFR1) — it never touches
// FFmpeg flags or stdin (that's `argv.ts`/`pipe.ts`).
//
// Sole ownership statement (spec.md FR10 / design.md Grounding sources): there is no `cache.ts`
// in this change — content-addressed chunk resume is explicitly deferred to a future follow-on
// (spec.md Notes' "Deferred to follow-on" list). `temp.ts` is therefore the ONLY module in this
// package that ever owns an encode's on-disk artifacts, and it always deletes them on cleanup.
// This resolves the party-architect panel's BLOCK finding about `temp.ts`/`cache.ts` having a
// contradictory lifecycle over the same files by construction: that finding is moot because
// `cache.ts` doesn't exist in v1.

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A single encode's temp-directory + process-hygiene handle (spec.md FR10). `dir` is created
 * synchronously before `createTempRun` returns, so callers can rely on it existing immediately.
 * `registerChild` lets a caller (e.g. `pipe.ts`'s `createEncodePipe`, or `tools/bench`) hand
 * over its spawned FFmpeg child so a SIGINT/SIGTERM can SIGTERM it before the directory is
 * removed (NFR1). `cleanup()` is idempotent — safe to call more than once, including from both
 * a normal exit path and the signal handler racing it. */
export interface TempRun {
  dir: string;
  cleanup(): Promise<void>;
  registerChild(child: ChildProcess): void;
}

/** Creates a fresh, uniquely-named temp directory — `<root>/claudevid-encode-<uuid>` where
 * `root` defaults to `os.tmpdir()` unless `baseDir` is passed (spec.md FR10) — and installs a
 * one-shot SIGINT/SIGTERM handler for this run. "Deterministic" per FR10 means the *naming
 * scheme* is predictable and documented, not that the path is fixed: a literal fixed path would
 * collide across concurrent encodes, which this package must not preclude, so each call mints a
 * fresh `randomUUID()`.
 *
 * The directory is created synchronously (`fs.mkdirSync`) so `dir` is guaranteed to exist on
 * disk by the time this function returns — no caller has to await anything before writing into
 * it (AC10).
 *
 * On SIGINT/SIGTERM, this run's handler SIGTERMs every registered child, then awaits
 * `cleanup()` (which removes the directory), then calls `process.exit(0)` — this package installs
 * the handler, so it also owns bringing the process down once its own cleanup has finished, per
 * design.md's `temp.ts` section. The handler is registered with `process.once` per signal, so it
 * fires exactly once and does not accumulate across multiple `createTempRun` calls; `cleanup()`
 * also removes the listeners so a normal (non-signal) cleanup doesn't leave a dangling handler
 * behind that could double-fire this run's logic on a later, unrelated signal.
 */
export function createTempRun(baseDir: string = os.tmpdir()): TempRun {
  const dir = path.join(baseDir, `claudevid-encode-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });

  const children: ChildProcess[] = [];
  // `cleanupPromise` is the idempotency mechanism: a second `cleanup()` call (whether from a
  // normal exit path racing the signal handler, or a caller invoking it twice deliberately)
  // returns the same in-flight/settled promise instead of re-running `fs.promises.rm`.
  let cleanupPromise: Promise<void> | undefined;

  const onSignal = () => {
    void cleanup().then(() => {
      process.exit(0);
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  function cleanup(): Promise<void> {
    if (cleanupPromise) return cleanupPromise;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    for (const child of children) {
      if (!child.killed) child.kill("SIGTERM");
    }
    cleanupPromise = fs.promises.rm(dir, { recursive: true, force: true });
    return cleanupPromise;
  }

  return {
    dir,
    cleanup,
    registerChild(child: ChildProcess) {
      children.push(child);
    },
  };
}
