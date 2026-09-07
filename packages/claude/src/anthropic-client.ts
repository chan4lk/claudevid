import Anthropic from "@anthropic-ai/sdk";

export interface ClientMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CreateStructuredMessageOptions {
  system: string;
  schema: object;
  messages: ClientMessage[];
  model: string;
  apiKey: string;
}

const TOOL_NAME = "emit_video_spec";

/** Injection seam for change 007's repair loop (see generate.ts) — swap via CreateStructuredMessageOptions.createMessage in tests. */
export async function createStructuredMessage(opts: CreateStructuredMessageOptions): Promise<unknown> {
  const client = new Anthropic({ apiKey: opts.apiKey });

  const response = await client.messages.create({
    model: opts.model,
    max_tokens: 16000,
    system: opts.system,
    messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
    tools: [
      {
        name: TOOL_NAME,
        description: "Emit a VideoSpec JSON object",
        input_schema: opts.schema as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: "tool", name: TOOL_NAME },
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("createStructuredMessage: no tool_use block found in Claude's response");
  }

  return toolUse.input;
}
