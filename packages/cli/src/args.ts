export class ArgError extends Error {}

/** Scans argv for `--flag <value>` and returns the value, or undefined if the flag is absent.
 * Each command writes its own `parseArgs` (per tools/motion-preview/src/args.ts's pattern) —
 * this helper is the one piece truly shared across those parsers. */
export function findFlagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined) throw new ArgError(`${flag} requires a value`);
  return value;
}

/** Scans argv for a boolean flag (e.g. `--watch`, `--force`) — present or absent, no value. */
export function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}
