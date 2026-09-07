import type { Channel } from "./properties.js";
import type { Track } from "./track.js";

export type PresetParams = Record<string, number>;
type PresetFn = (params?: PresetParams) => Track[];

const registry = new Map<string, PresetFn>();

/** Registers a preset, asserting (dev-time only — this registry is first-party code, never
 * spec-authored, so this is a build-time invariant, not a runtime schema check) that its
 * default-params track list never targets the same channel twice (spec.md FR2). */
function definePreset(name: string, fn: PresetFn): void {
  const tracks = fn();
  const seen = new Set<Channel>();
  for (const track of tracks) {
    if (seen.has(track.property)) {
      throw new Error(`preset "${name}" declares two tracks for channel "${track.property}"`);
    }
    seen.add(track.property);
  }
  registry.set(name, fn);
}

definePreset("fade", (p = {}) => [
  { property: "opacity", from: 0, to: 1, duration: p.duration ?? 0.4, easing: "ease-out-cubic" },
]);

definePreset("fade-up", (p = {}) => [
  { property: "opacity", from: 0, to: 1, duration: p.duration ?? 0.4, easing: "ease-out-cubic" },
  { property: "y", from: p.distance ?? 48, to: 0, duration: p.duration ?? 0.4, easing: "ease-out-cubic" },
]);

definePreset("fade-down", (p = {}) => [
  { property: "opacity", from: 0, to: 1, duration: p.duration ?? 0.4, easing: "ease-out-cubic" },
  { property: "y", from: -(p.distance ?? 48), to: 0, duration: p.duration ?? 0.4, easing: "ease-out-cubic" },
]);

definePreset("slide-left", (p = {}) => [
  { property: "x", from: p.distance ?? 100, to: 0, duration: p.duration ?? 0.5, easing: "ease-out-cubic" },
]);

definePreset("slide-right", (p = {}) => [
  { property: "x", from: -(p.distance ?? 100), to: 0, duration: p.duration ?? 0.5, easing: "ease-out-cubic" },
]);

definePreset("slide-up", (p = {}) => [
  { property: "y", from: p.distance ?? 100, to: 0, duration: p.duration ?? 0.5, easing: "ease-out-cubic" },
]);

definePreset("slide-down", (p = {}) => [
  { property: "y", from: -(p.distance ?? 100), to: 0, duration: p.duration ?? 0.5, easing: "ease-out-cubic" },
]);

definePreset("scale-fade", (p = {}) => [
  { property: "opacity", from: 0, to: 1, duration: p.duration ?? 0.4, easing: "ease-out-cubic" },
  { property: "scaleX", from: p.scale ?? 0.8, to: 1, duration: p.duration ?? 0.4, easing: "ease-out-cubic" },
  { property: "scaleY", from: p.scale ?? 0.8, to: 1, duration: p.duration ?? 0.4, easing: "ease-out-cubic" },
]);

definePreset("pop", (p = {}) => [
  { property: "scaleX", from: 0, to: 1, duration: p.duration ?? 0.5, easing: "ease-out-back" },
  { property: "scaleY", from: 0, to: 1, duration: p.duration ?? 0.5, easing: "ease-out-back" },
]);

/** Resolves a shipped preset by name. `undefined` for an unknown name — `compileMotion`
 * treats that as a diagnostic, never a silent no-op (spec.md Edge Cases). */
export function resolvePreset(name: string, params?: PresetParams): Track[] | undefined {
  return registry.get(name)?.(params);
}

export interface CatalogueEntry {
  name: string;
  channels: Channel[];
}

/** Structurally safe catalogue export for change 007's director prompt (spec.md FR7): only
 * the preset name and the channels it touches — no free-form prose field exists anywhere in
 * this registry's data shape, so there is nothing else for it to carry. */
export function exportCatalogue(): CatalogueEntry[] {
  return [...registry.keys()].map((name) => ({
    name,
    channels: [...new Set(registry.get(name)!().map((t) => t.property))],
  }));
}
