import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Mirrors packages/claude's brandKitConfigSchema shape (design.md Data Model Changes) —
 * validated here with a plain structural check, since packages/claude/src/config-schema.ts's
 * Zod schema is not a dependency of this package. */
export interface CliConfig {
  model?: string;
  repairAttempts?: number;
  voice?: string;
  brand?: {
    palette?: string[];
    fontFamily?: string;
    logoPath?: string;
  };
}

export class ConfigError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateShape(value: unknown): CliConfig {
  if (!isPlainObject(value)) throw new ConfigError("claudevid.config.json must be a JSON object");

  const { model, repairAttempts, voice, brand } = value;
  if (model !== undefined && typeof model !== "string") {
    throw new ConfigError("config.model must be a string");
  }
  if (
    repairAttempts !== undefined &&
    (typeof repairAttempts !== "number" || !Number.isInteger(repairAttempts) || repairAttempts <= 0)
  ) {
    throw new ConfigError("config.repairAttempts must be a positive integer");
  }
  if (voice !== undefined && typeof voice !== "string") {
    throw new ConfigError("config.voice must be a string");
  }
  if (brand !== undefined) {
    if (!isPlainObject(brand)) throw new ConfigError("config.brand must be an object");
    const { palette, fontFamily, logoPath } = brand;
    if (palette !== undefined && (!Array.isArray(palette) || !palette.every((p) => typeof p === "string"))) {
      throw new ConfigError("config.brand.palette must be an array of strings");
    }
    if (fontFamily !== undefined && typeof fontFamily !== "string") {
      throw new ConfigError("config.brand.fontFamily must be a string");
    }
    if (logoPath !== undefined && typeof logoPath !== "string") {
      throw new ConfigError("config.brand.logoPath must be a string");
    }
  }

  return value as CliConfig;
}

export interface LoadConfigOptions {
  cwd?: string;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
}

/**
 * Loads `./claudevid.config.json` from `opts.cwd` (default process.cwd()) if present, then
 * merges `overrides` on top — override wins per field (spec.md FR7: explicit `--flag` beats the
 * config file). Returns `{}` merged with `overrides` when no config file exists.
 * `exists`/`readFile` are injected so this stays testable without touching real disk.
 */
export function loadConfig(overrides: Partial<CliConfig> = {}, opts: LoadConfigOptions = {}): CliConfig {
  const cwd = opts.cwd ?? process.cwd();
  const exists = opts.exists ?? existsSync;
  const readFile = opts.readFile ?? ((path: string) => readFileSync(path, "utf-8"));

  const configPath = join(cwd, "claudevid.config.json");
  let fileConfig: CliConfig = {};

  if (exists(configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFile(configPath));
    } catch (err) {
      throw new ConfigError(`failed to parse ${configPath}: ${(err as Error).message}`);
    }
    fileConfig = validateShape(parsed);
  }

  return { ...fileConfig, ...overrides };
}
