import { z } from "zod";
import { layerUnion, checkNestingDepth, MAX_GROUP_NESTING_DEPTH } from "./layers.js";
import type {
  Scene as SceneType,
  VideoSpec as VideoSpecType,
  NarrationBlock as NarrationBlockType,
} from "./types.js";

export const metaSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
});
export type Meta = z.infer<typeof metaSchema>;

export const audioSchema = z.object({
  track: z.string().optional(),
  volume: z.number().min(0).max(1).optional(),
});
export type AudioTrack = z.infer<typeof audioSchema>;

const sceneTransitionSchema = z.object({
  kind: z.enum(["cut", "cross-fade"]),
  duration: z.number().min(0).optional(),
});

export const narrationBlockSchema: z.ZodType<NarrationBlockType> = z.object({
  text: z.string(),
  voice: z.string().optional(),
  speed: z.number().optional(),
});

// Accepts a bare string ("hello"), a single NarrationBlock-shaped object, or an array of
// NarrationBlock, and normalizes all three shapes to NarrationBlock[] (FR1/AC1/AC2/D4).
// The preprocess step only wraps non-array input in an array; z.array(narrationBlockSchema)
// then validates every element uniformly, including the already-array case.
// z.preprocess's TS types always widen its _input to `unknown` (the preprocess function itself
// accepts unknown), so the cast below narrows it back to the shape we actually accept — the
// runtime behavior is unaffected, only the static type this schema presents to its callers.
const narrationSchema = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [{ text: value }];
  if (value && typeof value === "object") return [value];
  return value;
}, z.array(narrationBlockSchema)) as unknown as z.ZodType<
  NarrationBlockType[],
  z.ZodTypeDef,
  string | NarrationBlockType | NarrationBlockType[]
>;

// Annotated against the hand-written Scene interface (types.ts) for the same reason
// GroupLayer is in layers.ts: `layers` recurses through the dynamic registerLayer()
// union, which Zod can't infer statically. The annotation still forces agreement —
// tsc rejects this schema the moment its shape stops matching Scene.
//
// `narration` is the one field where the parsed *input* is intentionally wider than the
// resolved output (string | NarrationBlock | NarrationBlock[] in, NarrationBlock[] out), so
// the schema is annotated with a distinct SceneInput type the same way videoSpecSchema below
// diverges from VideoSpecInput for width/height/fps.
type SceneInput = Omit<SceneType, "narration"> & {
  narration?: string | NarrationBlockType | NarrationBlockType[];
};

export const sceneSchema: z.ZodType<SceneType, z.ZodTypeDef, SceneInput> = z
  .object({
    id: z.string().min(1),
    duration: z.union([z.number().min(0), z.literal("auto")]),
    background: z.string().optional(),
    layers: z.array(z.lazy(() => layerUnion())),
    transition: sceneTransitionSchema.optional(),
    narration: narrationSchema.optional(),
  })
  .superRefine((scene, ctx) => {
    const violation = checkNestingDepth(scene.layers);
    if (violation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["layers", ...violation.path],
        message: `Layer nesting exceeds the maximum depth of ${MAX_GROUP_NESTING_DEPTH} group levels`,
      });
    }
  });

// width/height/fps carry z.default(), so the parsed *input* allows them to be
// omitted even though the resolved VideoSpecType always has them defined.
type VideoSpecInput = Omit<VideoSpecType, "width" | "height" | "fps" | "scenes"> & {
  width?: number;
  height?: number;
  fps?: number;
  scenes: SceneInput[];
};

export const videoSpecSchema: z.ZodType<VideoSpecType, z.ZodTypeDef, VideoSpecInput> = z
  .object({
    version: z.literal(1),
    width: z.number().positive().default(1920),
    height: z.number().positive().default(1080),
    fps: z.number().positive().default(30),
    background: z.string().optional(),
    meta: metaSchema.optional(),
    audio: audioSchema.optional(),
    scenes: z.array(sceneSchema).min(1),
  })
  .superRefine((spec, ctx) => {
    const seen = new Set<string>();
    spec.scenes.forEach((scene, i) => {
      if (seen.has(scene.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scenes", i, "id"],
          message: `Duplicate scene id "${scene.id}" — scene ids must be unique within a spec`,
        });
      }
      seen.add(scene.id);
    });
  });
