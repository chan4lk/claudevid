import { z } from "zod";

export type Coordinate = number | "center" | `${number}%`;

export interface Animation {
  enter?: string;
  exit?: string;
  duration?: number;
  delay?: number;
  easing?: string;
}

const coordinateSchema = z.union([
  z.number(),
  z.literal("center"),
  z.string().regex(/^-?\d+(\.\d+)?%$/, 'expected a percentage string like "50%"'),
]) as z.ZodType<Coordinate>;

const animationSchema: z.ZodType<Animation> = z.object({
  enter: z.string().optional(),
  exit: z.string().optional(),
  duration: z.number().min(0).optional(),
  delay: z.number().min(0).optional(),
  easing: z.string().optional(),
});

const baseLayerShape = {
  x: coordinateSchema.optional(),
  y: coordinateSchema.optional(),
  start: z.number().min(0).optional(),
  duration: z.number().min(0).optional(),
  animation: animationSchema.optional(),
};

export const textLayerSchema = z.object({
  ...baseLayerShape,
  type: z.literal("text"),
  text: z.string().min(1).max(300),
  fontSize: z.number().min(1).optional(),
  fontWeight: z.number().min(100).max(900).optional(),
  color: z.string().optional(),
  fontFamily: z.string().optional(),
});
export type TextLayer = z.infer<typeof textLayerSchema>;

export const rectLayerSchema = z.object({
  ...baseLayerShape,
  type: z.literal("rect"),
  width: z.number().positive(),
  height: z.number().positive(),
  fill: z.string().optional(),
  stroke: z.string().optional(),
  strokeWidth: z.number().min(0).optional(),
  radius: z.number().min(0).optional(),
});
export type RectLayer = z.infer<typeof rectLayerSchema>;

export const imageLayerSchema = z.object({
  ...baseLayerShape,
  type: z.literal("image"),
  src: z.string().min(1),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  fit: z.enum(["cover", "contain", "fill"]).optional(),
});
export type ImageLayer = z.infer<typeof imageLayerSchema>;

export interface GroupLayer {
  type: "group";
  id: string;
  x?: Coordinate;
  y?: Coordinate;
  start?: number;
  duration?: number;
  animation?: Animation;
  children: Layer[];
}

export type Layer = TextLayer | RectLayer | ImageLayer | GroupLayer;

// Zod can't infer a self-referential object type. This is the one schema in the
// package annotated against a hand-written interface (GroupLayer) rather than the
// other way around — the z.ZodType<GroupLayer> annotation makes tsc reject the
// schema the moment its shape stops matching the interface, so they can't drift.
export const groupLayerSchema: z.ZodType<GroupLayer> = z.object({
  ...baseLayerShape,
  type: z.literal("group"),
  id: z.string().min(1),
  children: z.lazy(() => z.array(layerUnion())),
});

const registry = new Map<string, z.ZodTypeAny>([
  ["text", textLayerSchema],
  ["rect", rectLayerSchema],
  ["image", imageLayerSchema],
  ["group", groupLayerSchema],
]);

let cachedUnion: z.ZodTypeAny | null = null;

/** Extends the layer union without editing this file — used by 004 (`code`) and 006 (`captions`). */
export function registerLayer(type: string, schema: z.ZodTypeAny): void {
  registry.set(type, schema);
  cachedUnion = null;
}

export function layerUnion(): z.ZodTypeAny {
  if (!cachedUnion) {
    const options = [...registry.values()];
    cachedUnion = z.discriminatedUnion(
      "type",
      options as unknown as [z.ZodDiscriminatedUnionOption<"type">, ...z.ZodDiscriminatedUnionOption<"type">[]]
    );
  }
  return cachedUnion;
}

export const MAX_GROUP_NESTING_DEPTH = 2;

export interface NestingViolation {
  path: (string | number)[];
}

export function checkNestingDepth(
  layers: unknown[],
  depth = 0,
  path: (string | number)[] = []
): NestingViolation | null {
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i] as { type?: string; children?: unknown[] } | undefined;
    const layerPath = [...path, i];
    if (layer?.type === "group") {
      const groupDepth = depth + 1;
      if (groupDepth > MAX_GROUP_NESTING_DEPTH) {
        return { path: [...layerPath, "children"] };
      }
      const violation = checkNestingDepth(layer.children ?? [], groupDepth, [...layerPath, "children"]);
      if (violation) return violation;
    }
  }
  return null;
}
