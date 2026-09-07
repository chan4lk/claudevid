import { z } from "zod";
import { layerUnion, checkNestingDepth, MAX_GROUP_NESTING_DEPTH } from "./layers.js";
import type { Scene as SceneType, VideoSpec as VideoSpecType } from "./types.js";

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

// Annotated against the hand-written Scene interface (types.ts) for the same reason
// GroupLayer is in layers.ts: `layers` recurses through the dynamic registerLayer()
// union, which Zod can't infer statically. The annotation still forces agreement —
// tsc rejects this schema the moment its shape stops matching Scene.
export const sceneSchema: z.ZodType<SceneType> = z
  .object({
    id: z.string().min(1),
    duration: z.union([z.number().min(0), z.literal("auto")]),
    background: z.string().optional(),
    layers: z.array(z.lazy(() => layerUnion())),
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
type VideoSpecInput = Omit<VideoSpecType, "width" | "height" | "fps"> & {
  width?: number;
  height?: number;
  fps?: number;
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
