import type { Meta, AudioTrack } from "./schema.js";
import type { Layer } from "./layers.js";

export type {
  Layer,
  TextLayer,
  RectLayer,
  ImageLayer,
  GroupLayer,
  Coordinate,
  Animation,
} from "./layers.js";
export type { Meta, AudioTrack } from "./schema.js";

export interface Scene {
  id: string;
  duration: number | "auto";
  background?: string;
  layers: Layer[];
}

export interface VideoSpec {
  version: 1;
  width: number;
  height: number;
  fps: number;
  background?: string;
  meta?: Meta;
  audio?: AudioTrack;
  scenes: Scene[];
}
