import type { ZodIssue } from "zod";
import { videoSpecSchema } from "./schema.js";
import type { VideoSpec } from "./types.js";

export interface Diagnostic {
  path: string;
  message: string;
  suggestion?: string;
}

export type ParseResult = { ok: true; spec: VideoSpec } | { ok: false; diagnostics: Diagnostic[] };

function toJsonPointer(path: (string | number)[]): string {
  if (path.length === 0) return "/";
  return "/" + path.map((segment) => String(segment).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
}

function suggestionFor(issue: ZodIssue): string | undefined {
  switch (issue.code) {
    case "too_big":
      return `reduce the value to ${issue.inclusive ? "at most" : "less than"} ${issue.maximum}`;
    case "too_small":
      return `increase the value to ${issue.inclusive ? "at least" : "more than"} ${issue.minimum}`;
    case "invalid_type":
      return `expected ${issue.expected}, received ${issue.received}`;
    case "invalid_literal":
      return `expected the literal value ${JSON.stringify(issue.expected)}`;
    default:
      return undefined;
  }
}

/** Never throws a raw ZodError — every failure is a JSON-pointer diagnostic Claude's repair loop (change 007) can act on. */
export function parseSpec(json: unknown): ParseResult {
  const result = videoSpecSchema.safeParse(json);
  if (result.success) {
    return { ok: true, spec: result.data };
  }

  const diagnostics: Diagnostic[] = result.error.issues.map((issue) => ({
    path: toJsonPointer(issue.path),
    message: issue.message,
    suggestion: suggestionFor(issue),
  }));
  return { ok: false, diagnostics };
}
