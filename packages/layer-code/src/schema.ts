import { z } from "zod";
import { registerLayer } from "@claudevid/core";

export const BUNDLED_LANGS = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "python",
  "bash",
  "json",
  "yaml",
] as const;

export const BUNDLED_THEMES = ["github-dark", "github-light", "high-contrast"] as const;

// `baseLayerShape`/`coordinateSchema`/`staggerSchema`/`animationSchema` are module-private in
// `@claudevid/core` (`packages/core/src/layers.ts`), so the four shared fields (`x`, `y`,
// `start`, `duration`, `animation`) are restated here using the same Zod primitives `core`
// exports publicly (`Coordinate`/`Animation` types) rather than reopening a sealed package's
// export surface for six lines of Zod — see design.md's `schema.ts` section.
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

const revealSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("typewriter"),
    unit: z.enum(["char", "token", "line"]).optional(),
    rate: z.number().positive().optional(),
    startDelay: z.number().min(0).optional(),
    caret: z.boolean().optional(),
  }),
  z.object({
    mode: z.literal("line-stagger"),
    each: z.number().positive(),
    from: z.enum(["first", "center", "last", "random"]).optional(),
  }),
]);
export type CodeReveal = z.infer<typeof revealSchema>;

const focusSchema = z.object({
  lines: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  dimOpacity: z.number().min(0).max(1).optional(),
  animate: z
    .object({
      from: z.tuple([z.number().int().positive(), z.number().int().positive()]),
      duration: z.number().positive(),
      delay: z.number().min(0).optional(),
      easing: z.string().optional(),
    })
    .optional(),
});
export type CodeFocus = z.infer<typeof focusSchema>;

const diffSchema = z.object({
  before: z.string().min(1),
  addedBg: z.string().optional(),
  removedBg: z.string().optional(),
  revealDelay: z.number().min(0).optional(),
  duration: z.number().positive().optional(),
});
export type CodeDiff = z.infer<typeof diffSchema>;

const scrollSchema = z.object({
  toLine: z.number().int().positive(),
  fromLine: z.number().int().positive().optional(),
  duration: z.number().positive(),
  delay: z.number().min(0).optional(),
  easing: z.string().optional(),
});
export type CodeScroll = z.infer<typeof scrollSchema>;

const annotationSchema = z.object({
  line: z.number().int().positive(),
  text: z.string().min(1),
  side: z.enum(["left", "right"]).optional(),
  color: z.string().optional(),
  delay: z.number().min(0).optional(),
});
export type CodeAnnotation = z.infer<typeof annotationSchema>;

// `width`/`height` are required (not optional), matching `rectLayerSchema`'s convention
// (`packages/core/src/schema.ts`'s `rectLayerSchema`) rather than `imageLayerSchema`'s optional
// pair — a code window's chrome box is fundamental to its legibility guardrails (spec.md FR1/FR6).
export const codeLayerSchema = z.object({
  ...baseLayerShape,
  type: z.literal("code"),
  code: z.string().min(1).max(20000),
  lang: z.string().min(1),
  theme: z.string().min(1).optional(),
  width: z.number().positive(),
  height: z.number().positive(),
  title: z.string().optional(),
  showLineNumbers: z.boolean().optional(),
  fontSize: z.number().min(12).optional(),
  tabSize: z.number().int().positive().optional(),
  wrap: z.enum(["none", "soft"]).optional(),
  maxLines: z.number().int().positive().optional(),
  reveal: revealSchema.optional(),
  focus: focusSchema.optional(),
  diff: diffSchema.optional(),
  scroll: scrollSchema.optional(),
  annotations: z.array(annotationSchema).optional(),
});
export type CodeLayer = z.infer<typeof codeLayerSchema>;

// Side effect: importing this module (or `index.ts`, which re-exports it) registers the "code"
// layer type into `@claudevid/core`'s runtime layer union (spec.md FR1).
registerLayer("code", codeLayerSchema);
