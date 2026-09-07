export { parseSpec } from "./diagnostics.js";
export type { Diagnostic, ParseResult } from "./diagnostics.js";

export { compileTimeline, MissingAudioDurationError } from "./timeline.js";
export type { Timeline, TimelineLayer, SceneWindow, CompileTimelineOptions, TransitionFrame } from "./timeline.js";

export { registerLayer } from "./layers.js";

export { generateJsonSchema } from "./json-schema.js";

export {
  linear,
  easeInQuad,
  easeOutQuad,
  easeInOutQuad,
  easeInCubic,
  easeOutCubic,
  easeInOutCubic,
  easeInExpo,
  easeOutExpo,
  easeInOutExpo,
  easeInBack,
  easeOutBack,
  easeInOutBack,
  cubicBezier,
  steps,
} from "./easing.js";
export type { EasingFn, StepDirection } from "./easing.js";

export type {
  VideoSpec,
  Scene,
  SceneTransition,
  Layer,
  TextLayer,
  RectLayer,
  ImageLayer,
  GroupLayer,
  Coordinate,
  Animation,
  Meta,
  AudioTrack,
  PropertyBag,
} from "./types.js";
