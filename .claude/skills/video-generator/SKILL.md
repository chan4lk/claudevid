---
name: video-generator
description: Generate, validate, and render claudevid VideoSpec videos (JSON scene graphs compiled to MP4 by the claudevid pipeline).
---

# video-generator

This skill helps produce **claudevid** tech videos: you author a `VideoSpec` JSON document
(scenes, layers, animation, audio) and the claudevid CLI validates and renders it into an MP4.
Claude only ever produces the structured JSON — rendering, encoding, and audio muxing are handled
entirely by the pipeline.

## Prerequisite

`scripts/validate.mts` and `scripts/render.mts` are thin wrappers — they shell out to the
claudevid CLI rather than reimplementing validate/render logic — so the CLI has to be reachable
first. They locate it in one of three ways, in this order:

1. **Inside the claudevid monorepo**: `packages/cli/dist/cli.js`, which exists only after
   `pnpm build` at the repo root. This is checked first and wins unconditionally whenever that
   path exists relative to the script — i.e. whenever it's running from inside, or alongside, a
   claudevid monorepo checkout — even if a local dependency or global install is also present.
2. **Installed as a dependency** (a consumer project): `claudevid` resolved from `node_modules`.
   Install it with `npm install claudevid`. Only checked when no monorepo checkout is present.
3. **Installed globally** (`npm install -g claudevid`), so its bin is on `PATH`. This is the
   layout that suits a non-Node host project — a Python or Go repo gets the skill folder alone,
   with no `package.json` or `node_modules` of its own. Also only checked when no monorepo
   checkout is present.

If none is present the wrapper fails with a message naming all three options.

Rendering also needs **FFmpeg on `PATH`**, and a spec containing `narration` downloads the Kokoro
TTS model (~330 MB) on first use. Specs without narration need neither a model nor network.

## Schema

`schemas/video-spec.schema.json` is the full JSON Schema for `VideoSpec` — a byte-identical,
generated copy of `packages/claude/schemas/video-spec.schema.json`. Use it as the source of truth
for field names, types, and constraints when authoring a spec.

## Examples

`examples/` contains four worked specs (byte-identical copies of `packages/claude/examples/`):

- `simple-title.json` — minimal two-scene spec: a title card followed by a bullet-point scene,
  using only `text` and `rect` layers. Good starting point for a short, text-only clip.
- `code-demo.json` — a two-scene spec pairing a `text` intro with a `code` layer, showing how to
  present a real code snippet with language/theme.
- `tutorial.json` — a longer, four-scene walkthrough built from `text` and `rect` layers, showing
  how to pace a multi-step explanation across several scenes.
- `vertical-short.json` — a `1080x1920` portrait spec (same layer types as `simple-title.json`),
  showing how to target a vertical/social-clip aspect ratio.

## Validating and rendering

Both scripts are plain Node ESM scripts (no build step of their own needed) — the workspace
requires Node >=22, which runs TypeScript directly. The `.mts` extension is deliberate: it marks
these as ESM regardless of the host project's `package.json` `type` field, so they work both in
this repo and in a consumer project installed from the published package:

```bash
node scripts/validate.mts <spec-file>
node scripts/render.mts <spec-file> --out <output.mp4>
```

Each script forwards its argv verbatim to the built CLI's `validate`/`render` command and exits
with that command's exit code. Always validate a spec before rendering it.

## Captions are never hand-authored

Do not emit a layer with `"type": "captions"` when writing a `VideoSpec` by hand or via Claude
generation. Captions require frame-accurate word-level timings that only exist after narration
audio has been synthesized and forced-aligned — the render pipeline inserts the `captions` layer
itself (opt-in via `--captions`) once those timings are available. Authoring one directly will
fail schema validation (it requires a non-empty `words` array) or, if faked, produce fake timing
data.
