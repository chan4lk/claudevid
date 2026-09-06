import type { Coordinate } from "./layers.js";

/** Resolves `"center"` and `"<number>%"` against a pixel dimension. Runs once at compile time. */
export function resolveAxis(value: Coordinate | undefined, dimension: number): number {
  if (value === undefined || value === "center") return dimension / 2;
  if (typeof value === "string") {
    return (parseFloat(value) / 100) * dimension;
  }
  return value;
}

/** A scene without its own background falls back to the spec-level background. */
export function resolveSceneBackground(sceneBackground: string | undefined, specBackground: string | undefined): string | undefined {
  return sceneBackground ?? specBackground;
}
