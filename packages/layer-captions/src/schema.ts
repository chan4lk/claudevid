import { z } from "zod";
import { registerLayer } from "@claudevid/core";
import type { WordTiming } from "@claudevid/audio";

// `baseLayerShape`/`coordinateSchema`/`staggerSchema`/`animationSchema` are module-private in
// `@claudevid/core` (`packages/core/src/layers.ts`), so the four shared fields (`x`, `y`,
// `start`, `duration`, `animation`) are restated here using the same Zod primitives, following
// `packages/layer-code/src/schema.ts`'s exact precedent (its own header comment explains why:
// core exports the `Coordinate`/`Animation` *types* publicly but not the Zod schemas that
// produce them, and reopening a sealed package's export surface for six lines of Zod isn't
// worth it — see design.md's `schema.ts` section / spec.md FR6).
const coordinateSchema = z.union([
  z.number(),
  z.literal("center"),
  z.string().regex(/^-?\d+(\.\d+)?%$/, 'expected a percentage string like "50%"'),
]);

const staggerSchema = z.object({
  each: z.number().positive(),
  from: z.enum(["first", "center", "last", "random"]).optional(),
});

const animationSchema = z.object({
  enter: z.string().optional(),
  exit: z.string().optional(),
  duration: z.number().min(0).optional(),
  delay: z.number().min(0).optional(),
  easing: z.string().optional(),
  stagger: staggerSchema.optional(),
});

const baseLayerShape = {
  x: coordinateSchema.optional(),
  y: coordinateSchema.optional(),
  start: z.number().min(0).optional(),
  duration: z.number().min(0).optional(),
  animation: animationSchema.optional(),
};

// `WordTiming` (spec.md FR5, `packages/audio/src/word-timing-types.ts`) is a plain TS interface,
// not a Zod schema — `@claudevid/audio` has no Zod dependency to begin with, and a `VideoSpec`'s
// `captions` layer is what actually gets serialized/parsed as JSON, so the wire shape is declared
// here as its own schema rather than trying to derive Zod from a plain interface. The
// `z.ZodType<WordTiming>` annotation (mirroring `packages/core/src/layers.ts`'s
// `groupLayerSchema` pattern) makes tsc reject this schema the instant its fields drift from the
// imported type, so the two can't silently diverge.
const wordTimingSchema: z.ZodType<WordTiming> = z.object({
  word: z.string().min(1),
  start: z.number().min(0),
  end: z.number().min(0),
  estimated: z.boolean(),
  confidence: z.number().min(0).max(1).optional(),
});

// A `captions` layer's timeline-absolute `start`/`end` per word (offset applied exactly once, by
// whoever assembles the `VideoSpec` from 006's scene-window data — see design.md's Architecture
// diagram and spec.md's Edge Cases; `align.ts`/`layer-captions` never recompute the offset).
export const captionsLayerSchema = z.object({
  ...baseLayerShape,
  type: z.literal("captions"),
  words: z.array(wordTimingSchema).min(1),
});
export type CaptionsLayer = z.infer<typeof captionsLayerSchema>;

// Side effect: importing this module (or `index.ts`, which re-exports it) registers the
// "captions" layer type into `@claudevid/core`'s runtime layer union (spec.md FR6).
registerLayer("captions", captionsLayerSchema);
