import type { VideoSpec } from "@claudevid/core";
import type { CatalogueEntry } from "@claudevid/motion";
import type { BrandKitConfig } from "./config-schema.js";

export interface StyleContract {
  brand: BrandKitConfig["brand"];
  presetCatalogue: CatalogueEntry[];
  priorChapters: { title: string; summary: string }[];
}
export interface ChapterOutline { title: string; summary: string; }
export interface GenerateResult { spec: VideoSpec; attempts: number; }
