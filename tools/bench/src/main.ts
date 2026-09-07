// Entry point for running the bench harness directly — `pnpm --filter @claudevid/bench bench`
// (design.md D7). This file exists only to be an entry: it is never imported by another module,
// so running it can safely be an unconditional side effect. That is the whole point of the
// split — `bench.ts` stays importable and inert, and no `isDirectRun` guard is needed here (see
// `bench.ts`'s header for why such a guard cannot survive bundling).
import { runBench } from "./bench.js";
import { ArgError } from "./args.js";

runBench(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof ArgError ? `bench: ${err.message}` : err);
  process.exitCode = 1;
});
