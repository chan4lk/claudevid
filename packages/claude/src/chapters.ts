import type { VideoSpec } from "@claudevid/core";
import { createStructuredMessage } from "./anthropic-client.js";
import type { ClientMessage } from "./anthropic-client.js";
import type { ChapterOutline } from "./types.js";

const OUTLINE_SCHEMA = {
  type: "object",
  properties: {
    chapters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
        },
        required: ["title", "summary"],
      },
    },
  },
  required: ["chapters"],
};

export interface OutlineOptions {
  model: string;
  apiKey: string;
  /** Injectable seam, defaults to the real Anthropic call. */
  createMessage?: typeof createStructuredMessage;
}

function isChapterOutline(value: unknown): value is ChapterOutline {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).title === "string" &&
    typeof (value as Record<string, unknown>).summary === "string"
  );
}

/** One Anthropic call producing a chapter outline — no full VideoSpec schema needed. */
export async function outline(prompt: string, opts: OutlineOptions): Promise<ChapterOutline[]> {
  const createMessage = opts.createMessage ?? createStructuredMessage;
  const messages: ClientMessage[] = [{ role: "user", content: prompt }];

  const raw = await createMessage({
    system:
      "You are a technical video director. Break the requested video into a short list of chapters, " +
      "each with a concise title and a one- or two-sentence summary of what it covers.",
    schema: OUTLINE_SCHEMA,
    messages,
    model: opts.model,
    apiKey: opts.apiKey,
  });

  if (typeof raw !== "object" || raw === null || !("chapters" in raw)) {
    throw new Error("outline: response is missing a \"chapters\" array");
  }

  const chapters = (raw as Record<string, unknown>).chapters;
  if (!Array.isArray(chapters)) {
    throw new Error("outline: \"chapters\" is not an array");
  }

  chapters.forEach((chapter, i) => {
    if (!isChapterOutline(chapter)) {
      throw new Error(`outline: chapter at index ${i} is missing a string "title" or "summary"`);
    }
  });

  return chapters as ChapterOutline[];
}

/** Thrown by mergeChapters when the same scene id appears in more than one chapter. */
export class SceneIdCollisionError extends Error {
  constructor(public readonly collidingIds: string[]) {
    super(`scene id collision across chapters: ${collidingIds.join(", ")}`);
    this.name = "SceneIdCollisionError";
  }
}

/**
 * Concatenates every chapter's scenes, in order, into one VideoSpec. Top-level fields
 * (width, height, fps, meta) come from the first spec — per the style contract, chapters
 * already share those. Throws SceneIdCollisionError (naming every colliding id) rather than
 * returning a partially-merged spec if any scene id repeats across chapters (see D5).
 */
export function mergeChapters(specs: VideoSpec[]): VideoSpec {
  const seen = new Set<string>();
  const colliding = new Set<string>();

  for (const spec of specs) {
    for (const scene of spec.scenes) {
      if (seen.has(scene.id)) {
        colliding.add(scene.id);
      } else {
        seen.add(scene.id);
      }
    }
  }

  if (colliding.size > 0) {
    throw new SceneIdCollisionError([...colliding]);
  }

  const first = specs[0];
  if (!first) {
    throw new Error("mergeChapters: no chapters to merge");
  }

  return {
    ...first,
    scenes: specs.flatMap((spec) => spec.scenes),
  };
}
