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
export type { PropertyBag } from "./property-bag.js";

export interface SceneTransition {
  kind: "cut" | "cross-fade";
  duration?: number;
}

export interface NarrationBlock {
  text: string;
  voice?: string;
  speed?: number;
}

export interface Scene {
  id: string;
  duration: number | "auto";
  background?: string;
  layers: Layer[];
  /** Transition into this scene from the previous one. Absent = `{ kind: "cut", duration: 0 }`. */
  transition?: SceneTransition;
  /**
   * Narration for this scene. Accepts a bare string, a single NarrationBlock, or an array of
   * NarrationBlock at the schema boundary (see schema.ts); always resolved to NarrationBlock[]
   * here.
   */
  narration?: NarrationBlock[];
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
