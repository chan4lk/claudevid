import type { Diagnostic } from "@claudevid/core";
import { generateJsonSchema, parseSpec } from "@claudevid/core";
import { createStructuredMessage } from "./anthropic-client.js";
import type { ClientMessage } from "./anthropic-client.js";
import type { GenerateResult } from "./types.js";

const DEFAULT_REPAIR_ATTEMPTS = 3;

export interface GenerateSpecOptions {
  model: string;
  apiKey: string;
  /** Total attempts, counting the first — default 3. */
  repairAttempts?: number;
  /** The director prompt, caller-supplied (built via buildDirectorPrompt elsewhere). */
  systemPrompt: string;
  /** Injectable seam, defaults to the real Anthropic call. */
  createMessage?: typeof createStructuredMessage;
}

/** Raised when the repair loop exhausts its attempts — carries only the last attempt's diagnostics. */
export class GenerationFailedError extends Error {
  diagnostics: Diagnostic[];

  constructor(attempts: number, diagnostics: Diagnostic[]) {
    super(`generation failed after ${attempts} attempts: ${JSON.stringify(diagnostics)}`);
    this.diagnostics = diagnostics;
    this.name = "GenerationFailedError";
  }
}

export async function generateSpec(prompt: string, opts: GenerateSpecOptions): Promise<GenerateResult> {
  const repairAttempts = opts.repairAttempts ?? DEFAULT_REPAIR_ATTEMPTS;
  const createMessage = opts.createMessage ?? createStructuredMessage;
  const schema = generateJsonSchema();

  const messages: ClientMessage[] = [{ role: "user", content: prompt }];

  let lastDiagnostics: Diagnostic[] = [];

  for (let attempt = 1; attempt <= repairAttempts; attempt++) {
    const rawResult = await createMessage({
      system: opts.systemPrompt,
      schema,
      messages,
      model: opts.model,
      apiKey: opts.apiKey,
    });

    const result = parseSpec(rawResult);
    if (result.ok) {
      return { spec: result.spec, attempts: attempt };
    }

    lastDiagnostics = result.diagnostics;

    if (attempt < repairAttempts) {
      messages.push({ role: "assistant", content: JSON.stringify(rawResult) });
      messages.push({
        role: "user",
        content: `The spec you emitted is invalid. Fix these specific issues and re-emit the full spec: ${JSON.stringify(result.diagnostics)}`,
      });
    }
  }

  throw new GenerationFailedError(repairAttempts, lastDiagnostics);
}
