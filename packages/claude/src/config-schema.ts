import { z } from "zod";

export const brandKitConfigSchema = z.object({
  model: z.string().optional(),
  repairAttempts: z.number().int().positive().optional(),
  voice: z.string().optional(),
  brand: z.object({
    palette: z.array(z.string()).optional(),
    fontFamily: z.string().optional(),
    logoPath: z.string().optional(),
  }).optional(),
});
export type BrandKitConfig = z.infer<typeof brandKitConfigSchema>;
