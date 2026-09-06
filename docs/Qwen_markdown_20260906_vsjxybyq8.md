# ClaudeVid / Fast Claude Video Generator Plan

## Goal

Build a JavaScript/TypeScript library that generates high-quality tech videos quickly on Apple Silicon, especially M3 Macs, using Claude as the content director.

The library should be optimized for:

- tech explainer videos
- code walkthrough videos
- tutorial videos
- social clips
- long-form YouTube videos
- batch generation
- Claude-generated structured output

The core idea:

```text
Claude generates a validated VideoSpec JSON
→ the library compiles it into a timeline
→ Canvas/Skia renders frames
→ FFmpeg VideoToolbox encodes MP4 quickly
```

This is faster than building a full browser/React-based Remotion clone.

---

## Recommended Architecture

```text
User prompt
   ↓
Claude
   ↓
Validated JSON VideoSpec
   ↓
Timeline compiler
   ↓
Canvas / Skia / WebGL renderer
   ↓
Raw frames or image pipe
   ↓
FFmpeg VideoToolbox encoder
   ↓
MP4 / ProRes / WebM output
```

### Main principle

Claude should not directly render video.

Claude should generate a safe, structured description of the video.

```text
Claude = director / writer / scene planner
Library = renderer / animator / encoder
```

This gives better speed, reliability, and reproducibility.

---

## What the Library Should Be

A Claude-first video generation library.

Example name ideas:

```text
claudevid
fastmotion
vidkit
techvideo
scenejs
```

Example CLI usage:

```bash
npx claudevid render video.json --out output.mp4
```

Example programmatic usage:

```ts
import { renderVideo } from "claudevid";

await renderVideo(spec, {
  output: "out.mp4",
  encoder: "videotoolbox",
  quality: "high",
});
```

---

## Core Concept: VideoSpec

Do not let Claude generate arbitrary rendering code at first.

Instead, Claude generates a strict JSON schema.

Example:

```json
{
  "version": 1,
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "background": "#0b0f17",
  "audio": {
    "voiceover": "voiceover.mp3",
    "music": "music.mp3",
    "musicVolume": 0.18
  },
  "scenes": [
    {
      "id": "intro",
      "duration": 3,
      "layers": [
        {
          "type": "text",
          "text": "Build Faster Videos with Claude",
          "x": "center",
          "y": 420,
          "fontSize": 88,
          "fontWeight": 700,
          "color": "#ffffff",
          "animation": {
            "enter": "fade-up",
            "duration": 0.7
          }
        }
      ]
    },
    {
      "id": "code",
      "duration": 6,
      "layers": [
        {
          "type": "code",
          "language": "ts",
          "title": "render.ts",
          "code": "await renderVideo(spec, { encoder: 'videotoolbox' });",
          "theme": "github-dark",
          "x": "center",
          "y": "center",
          "width": 1400,
          "animation": {
            "enter": "scale-fade",
            "duration": 0.5
          }
        }
      ]
    }
  ]
}
```

This is easier for Claude to generate reliably.

---

## Best Tech Stack for M3 Mac

### Rendering engine

For fast 2D motion graphics, use one of these:

```text
@napi-rs/canvas
skia-canvas
```

These provide native Canvas/Skia rendering in Node.

Use them for:

- text
- code blocks
- rectangles
- arrows
- diagrams
- images
- simple transitions
- captions
- charts

If you later need advanced GPU effects:

```text
WebGL2
PixiJS
Three.js
```

But for most tech videos, Canvas/Skia is enough and much simpler.

---

### Encoding

Use FFmpeg with Apple hardware acceleration.

Check VideoToolbox support:

```bash
ffmpeg -hide_banner -encoders | grep videotoolbox
```

You should see encoders like:

```text
h264_videotoolbox
hevc_videotoolbox
prores_videotoolbox
```

Fast MP4 encode:

```bash
ffmpeg -y \
  -f rawvideo \
  -pix_fmt rgba \
  -s 1920x1080 \
  -r 30 \
  -i pipe:0 \
  -c:v h264_videotoolbox \
  -b:v 12M \
  -pix_fmt yuv420p \
  -color_primaries bt709 \
  -color_trc bt709 \
  -colorspace bt709 \
  output.mp4
```

Higher-quality editing intermediate:

```bash
ffmpeg -y \
  -f rawvideo \
  -pix_fmt rgba \
  -s 1920x1080 \
  -r 30 \
  -i pipe:0 \
  -c:v prores_ks \
  -profile:v 3 \
  output.mov
```

For final delivery, H.264 or HEVC is usually best.

---

## Fast Rendering Strategy

Avoid this slow path:

```text
React component
→ browser
→ screenshot per frame
→ encode
```

That is similar to what makes Remotion powerful but can be heavier.

Instead use:

```text
Scene JSON
→ immediate-mode canvas draw
→ raw frame pipe
→ FFmpeg
```

This is much faster for templated tech videos.

---

## Example Renderer Design

### Install dependencies

```bash
npm i @napi-rs/canvas zod execa
```

---

## Basic TypeScript Types

```ts
export type AnimationPreset =
  | "fade"
  | "fade-up"
  | "fade-down"
  | "scale-fade"
  | "slide-left"
  | "slide-right"
  | "typewriter";

export type Layer =
  | {
      type: "text";
      text: string;
      x?: number | "center";
      y?: number | "center";
      fontSize?: number;
      fontWeight?: number;
      color?: string;
      fontFamily?: string;
      animation?: {
        enter?: AnimationPreset;
        exit?: AnimationPreset;
        duration?: number;
        delay?: number;
      };
    }
  | {
      type: "code";
      code: string;
      language?: string;
      title?: string;
      theme?: string;
      x?: number | "center";
      y?: number | "center";
      width?: number;
      animation?: {
        enter?: AnimationPreset;
        exit?: AnimationPreset;
        duration?: number;
        delay?: number;
      };
    }
  | {
      type: "image";
      src: string;
      x?: number | "center";
      y?: number | "center";
      width?: number;
      height?: number;
      animation?: {
        enter?: AnimationPreset;
        exit?: AnimationPreset;
        duration?: number;
        delay?: number;
      };
    };

export type Scene = {
  id: string;
  duration: number;
  background?: string;
  layers: Layer[];
};

export type VideoSpec = {
  version: number;
  width: number;
  height: number;
  fps: number;
  background?: string;
  scenes: Scene[];
};
```

---

## Simple Render Loop

```ts
import { createCanvas } from "@napi-rs/canvas";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { VideoSpec } from "./types";

async function writeFrame(
  stream: NodeJS.WritableStream,
  buffer: Buffer
) {
  if (!stream.write(buffer)) {
    await once(stream, "drain");
  }
}

export async function renderVideo(
  spec: VideoSpec,
  outputPath: string
) {
  const canvas = createCanvas(spec.width, spec.height);
  const ctx = canvas.getContext("2d");

  const totalDuration = spec.scenes.reduce(
    (sum, scene) => sum + scene.duration,
    0
  );

  const totalFrames = Math.ceil(totalDuration * spec.fps);

  const ffmpeg = spawn("ffmpeg", [
    "-y",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${spec.width}x${spec.height}`,
    "-r",
    String(spec.fps),
    "-i",
    "pipe:0",
    "-c:v",
    "h264_videotoolbox",
    "-b:v",
    "12M",
    "-pix_fmt",
    "yuv420p",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    outputPath,
  ]);

  ffmpeg.stderr?.on("data", (data) => {
    console.error(data.toString());
  });

  for (let frame = 0; frame < totalFrames; frame++) {
    const time = frame / spec.fps;

    drawFrame(ctx, spec, time);

    const imageData = ctx.getImageData(
      0,
      0,
      spec.width,
      spec.height
    );

    await writeFrame(
      ffmpeg.stdin!,
      Buffer.from(imageData.data.buffer)
    );
  }

  ffmpeg.stdin?.end();

  await new Promise((resolve, reject) => {
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
  });
}
```

Implement frame drawing:

```ts
function drawFrame(
  ctx: any,
  spec: VideoSpec,
  time: number
) {
  ctx.fillStyle = spec.background ?? "#000000";
  ctx.fillRect(0, 0, spec.width, spec.height);

  let sceneStart = 0;

  for (const scene of spec.scenes) {
    const sceneEnd = sceneStart + scene.duration;

    if (time >= sceneStart && time < sceneEnd) {
      const localTime = time - sceneStart;

      if (scene.background) {
        ctx.fillStyle = scene.background;
        ctx.fillRect(0, 0, spec.width, spec.height);
      }

      for (const layer of scene.layers) {
        drawLayer(ctx, spec, layer, localTime);
      }

      break;
    }

    sceneStart = sceneEnd;
  }
}
```

Simple text layer:

```ts
function drawLayer(
  ctx: any,
  spec: VideoSpec,
  layer: any,
  localTime: number
) {
  if (layer.type === "text") {
    const opacity = getEnterOpacity(layer, localTime);

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = layer.color ?? "#ffffff";
    ctx.font = `${layer.fontWeight ?? 600} ${layer.fontSize ?? 64}px Inter, SF Pro Display, system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const x =
      layer.x === "center"
        ? spec.width / 2
        : layer.x ?? spec.width / 2;

    const y =
      layer.y === "center"
        ? spec.height / 2
        : layer.y ?? spec.height / 2;

    ctx.fillText(layer.text, x, y);
    ctx.restore();
  }
}
```

Simple fade helper:

```ts
function getEnterOpacity(layer: any, localTime: number) {
  const duration = layer.animation?.duration ?? 0.5;
  const delay = layer.animation?.delay ?? 0;

  if (localTime < delay) return 0;
  if (localTime >= delay + duration) return 1;

  return (localTime - delay) / duration;
}
```

This is a starting point, not the final production renderer.

---

## Claude Integration

The best pattern is:

```text
Claude generates JSON
→ your CLI validates it
→ your renderer renders it
```

Do not ask Claude to write arbitrary canvas code every time unless necessary.

---

## Claude System Prompt

Example:

```text
You are a technical video director.

Your job is to generate a valid VideoSpec JSON object for a high-quality tech video.

Rules:
- Output only valid JSON.
- Do not include comments.
- Do not include markdown.
- Use 1920x1080 unless asked otherwise.
- Use 30fps unless asked otherwise.
- Keep scenes short, usually 2 to 7 seconds.
- Use concise on-screen text.
- Prefer clear technical explanations.
- Use code scenes for code examples.
- Use text scenes for titles and bullet points.
- Do not invent unsupported layer types.
```

---

## Structured Output Validation

Use Zod or JSON Schema.

Example Zod schema:

```ts
import { z } from "zod";

const animationSchema = z.object({
  enter: z
    .enum([
      "fade",
      "fade-up",
      "fade-down",
      "scale-fade",
      "slide-left",
      "slide-right",
      "typewriter",
    ])
    .optional(),
  exit: z
    .enum([
      "fade",
      "fade-up",
      "fade-down",
      "scale-fade",
      "slide-left",
      "slide-right",
    ])
    .optional(),
  duration: z.number().min(0).max(3).optional(),
  delay: z.number().min(0).max(10).optional(),
});

const textLayerSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(300),
  x: z.union([z.number(), z.literal("center")]).optional(),
  y: z.union([z.number(), z.literal("center")]).optional(),
  fontSize: z.number().min(12).max(300).optional(),
  fontWeight: z.number().min(100).max(900).optional(),
  color: z.string().optional(),
  fontFamily: z.string().optional(),
  animation: animationSchema.optional(),
});

const codeLayerSchema = z.object({
  type: z.literal("code"),
  code: z.string().min(1),
  language: z.string().optional(),
  title: z.string().optional(),
  theme: z.string().optional(),
  x: z.union([z.number(), z.literal("center")]).optional(),
  y: z.union([z.number(), z.literal("center")]).optional(),
  width: z.number().optional(),
  animation: animationSchema.optional(),
});

const sceneSchema = z.object({
  id: z.string(),
  duration: z.number().min(0.25).max(30),
  background: z.string().optional(),
  layers: z.array(
    z.discriminatedUnion("type", [
      textLayerSchema,
      codeLayerSchema,
    ])
  ),
});

export const videoSpecSchema = z.object({
  version: z.literal(1),
  width: z.number().default(1920),
  height: z.number().default(1080),
  fps: z.number().default(30),
  background: z.string().optional(),
  scenes: z.array(sceneSchema).min(1),
});
```

Then validate:

```ts
const spec = videoSpecSchema.parse(claudeJson);
```

---

## Claude Code Skill

If you are using Claude Code, create a skill folder:

```text
.claude/skills/video-generator/
  SKILL.md
  examples/
    simple-title.json
    code-demo.json
    tutorial.json
  schemas/
    video-spec.schema.json
  scripts/
    validate.ts
    render.ts
```

Example `SKILL.md`:

```md
---
name: video-generator
description: Generate high-quality tech videos using the claudevid JSON spec.
---

Use this skill when the user asks to create, edit, render, or preview tech videos.

Rules:
1. Always generate valid VideoSpec JSON.
2. Prefer 1920x1080 and 30fps unless the user requests otherwise.
3. Keep scenes concise and visually clear.
4. Use code layers for code snippets.
5. Use text layers for titles, bullets, and explanations.
6. Validate the JSON before rendering.
7. Use the render script to produce MP4 output.

Commands:
- Validate: `bun scripts/validate.ts video.json`
- Render: `bun scripts/render.ts video.json out.mp4`
```

This makes Claude much better at using your library.

---

## MVP Feature List

Build in this order.

### Phase 1: Basic video generation

Support:

```text
width
height
fps
background
scenes
duration
text layers
rectangle layers
image layers
```

Output:

```text
MP4 using FFmpeg VideoToolbox
```

---

### Phase 2: Animation

Support:

```text
fade
fade-up
fade-down
scale-fade
slide-left
slide-right
progress bars
typewriter text
```

Use easing:

```ts
function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutCubic(t: number) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
```

---

### Phase 3: Code blocks

Important for tech videos.

Support:

```text
language
theme
title
line numbers
highlighted lines
typing animation
line reveal animation
```

For syntax highlighting, use:

```text
shiki
```

or:

```text
prismjs
```

Shiki is high quality but can be heavy.

Pre-render code blocks to an offscreen canvas or image cache.

Example:

```ts
const codeCache = new Map<string, RenderedCodeBlock>();
```

Do not re-highlight code every frame if it does not change.

---

### Phase 4: Captions

Very useful for tech videos.

Support:

```json
{
  "type": "captions",
  "style": "bottom",
  "words": [
    { "text": "This", "start": 0.0, "end": 0.2 },
    { "text": "is", "start": 0.2, "end": 0.35 },
    { "text": "a", "start": 0.35, "end": 0.45 },
    { "text": "caption", "start": 0.45, "end": 0.9 }
  ]
}
```

Claude can generate caption timing from a transcript.

---

### Phase 5: Audio

Support:

```text
voiceover
background music
sound effects
```

Mux with FFmpeg:

```bash
ffmpeg -i video.mp4 -i voiceover.mp3 \
  -c:v copy \
  -c:a aac \
  -shortest \
  final.mp4
```

For music ducking, use FFmpeg filters or a proper audio engine later.

---

## Performance Tips for M3

### 1. Use 1080p30 for most videos

For many tech videos:

```text
1920x1080 @ 30fps
```

is enough.

Only use:

```text
3840x2160 @ 60fps
```

if the platform really needs it.

4K60 dramatically increases render time.

---

### 2. Use hardware encoding

Prefer:

```text
h264_videotoolbox
hevc_videotoolbox
```

For editing quality:

```text
prores_ks
```

---

### 3. Cache static layers

If a layer does not change, render it once to an offscreen canvas.

Examples:

```text
title text → cached canvas
code block → cached canvas
diagram background → cached canvas
```

Then per frame you only draw:

```text
transform + opacity
```

instead of re-laying out text.

---

### 4. Avoid expensive effects per frame

Expensive:

```text
blur
shadow
glassmorphism
large gradients
complex SVG filters
```

Better:

```text
pre-render effect once
reuse bitmap
```

---

### 5. Use scene-level rendering

Only render active scene layers.

Do not draw hidden scenes.

---

### 6. Use raw frame pipe carefully

Piping raw RGBA frames to FFmpeg can be fast, but it creates huge bandwidth.

For 1080p30 RGBA:

```text
1920 * 1080 * 4 bytes * 30 fps
= about 249 MB per second
```

For a 30-minute video:

```text
249 MB/s * 1800 seconds
= about 448 GB of raw frame data
```

This is possible but heavy.

Use backpressure:

```ts
if (!ffmpeg.stdin.write(buffer)) {
  await once(ffmpeg.stdin, "drain");
}
```

For long videos, scene chunking and caching are very important.

---

### 7. Use lower-resolution previews

For fast preview:

```text
1280x720 @ 30fps
```

Final render:

```text
1920x1080 @ 30fps
```

---

## Recommended Folder Structure

```text
claudevid/
  packages/
    core/
      src/
        types.ts
        schema.ts
        timeline.ts
        easing.ts
    renderer-canvas/
      src/
        index.ts
        draw-text.ts
        draw-code.ts
        draw-image.ts
        draw-shapes.ts
    encoder-ffmpeg/
      src/
        index.ts
        videotoolbox.ts
        prores.ts
    cli/
      src/
        index.ts
        render.ts
        validate.ts
        preview.ts
    claude/
      prompts/
        video-director.md
      skills/
        SKILL.md
      schemas/
        video-spec.schema.json
      examples/
        intro.json
        code-demo.json
        tutorial.json
  examples/
  scripts/
  package.json
```

---

## Suggested CLI

```bash
claudevid init
claudevid validate video.json
claudevid preview video.json
claudevid render video.json --out output.mp4
```

Optional flags:

```bash
--width 1920
--height 1080
--fps 30
--encoder videotoolbox
--quality high
--format mp4
--vertical
```

Example vertical short:

```bash
claudevid render video.json \
  --width 1080 \
  --height 1920 \
  --out short.mp4
```

---

## When You Should Still Use Remotion

Use Remotion if you need:

- complex React components
- rich HTML/CSS layouts
- lots of existing React code
- advanced community components
- browser-accurate rendering

Use your custom library if you need:

- very fast templated videos
- Claude-generated JSON scenes
- code explainer videos
- simple motion graphics
- batch video generation
- lower render overhead
- M3-optimized FFmpeg pipeline

You can also make your library output Remotion projects for complex scenes while using the fast canvas renderer for simple scenes.

---

## Best Product Direction

Position the library like this:

```text
A Claude-native TypeScript library for generating fast, high-quality tech explainer videos.
```

Not:

```text
A full Remotion replacement.
```

Instead:

```text
Claude writes the video script and scene graph.
Your library turns that into polished MP4s quickly.
```

That is the fastest path to something genuinely useful.

---

## Minimum Version to Build First

Build this first:

```text
1. JSON VideoSpec schema
2. Canvas renderer
3. Text layers
4. Code layers
5. Image layers
6. Basic fade/slide animations
7. FFmpeg VideoToolbox MP4 export
8. CLI render command
9. Claude prompt + schema
10. Claude Code skill
```

That gives you a complete workflow:

```bash
claudevid generate "Explain how React Server Components work"
claudevid render output.json --out video.mp4
```

---

# 30-Minute Video Generation and Render Time Estimate

## Frame count

For a 30-minute video:

```text
30 minutes = 1800 seconds
```

At 30fps:

```text
1800 * 30 = 54,000 frames
```

At 60fps:

```text
1800 * 60 = 108,000 frames
```

For 4K30:

```text
3840 * 2160 * 30fps * 1800 seconds
= 216,000 frames
```

That is a lot of frames.

---

## Render time formula

```text
render_time_seconds = total_frames / render_fps
```

For 30 minutes at 1080p30:

```text
total_frames = 54,000
```

Examples:

| Render speed | Time to render 54,000 frames |
|---:|---:|
| 5 fps | 180 minutes |
| 10 fps | 90 minutes |
| 20 fps | 45 minutes |
| 30 fps | 30 minutes |
| 60 fps | 15 minutes |
| 120 fps | 7.5 minutes |
| 240 fps | 3.75 minutes |

The encoder may be faster than this, but frame generation is usually the bottleneck.

---

## Expected render times on M3

These are rough estimates. You must benchmark your exact scenes.

### 1080p30, 30-minute video

| Implementation quality | Estimated render time |
|---|---:|
| Very simple slides, heavily cached | 3 to 10 minutes |
| Simple motion graphics, optimized | 8 to 20 minutes |
| Moderate code animations | 15 to 35 minutes |
| Unoptimized canvas `getImageData` path | 30 to 120+ minutes |
| Complex WebGL/effects | 1 to 4+ hours |

### 1080p60, 30-minute video

Double the frames:

```text
108,000 frames
```

Expect roughly:

```text
2x the render time of 1080p30
```

### 4K30, 30-minute video

Four times the pixels of 1080p30:

```text
Much slower
```

Expect roughly:

```text
3x to 6x the render time of 1080p30
```

depending on effects and memory bandwidth.

---

## Claude generation time for a 30-minute video

A 30-minute spoken video is roughly:

```text
3,900 to 4,800 words of narration
```

depending on speaking speed.

The VideoSpec may contain:

```text
100 to 500 scenes
```

depending on scene length.

If each scene is 5 seconds:

```text
1800 / 5 = 360 scenes
```

That is too much for one Claude response.

You should generate in chunks.

Example chunking:

```text
10 scenes per request
or
1 minute of video per request
or
1 chapter per request
```

### Typical Claude generation time

| Task | Estimated time |
|---|---:|
| Outline | 1 to 3 minutes |
| Full script | 2 to 8 minutes |
| Scene JSON chunks | 5 to 25 minutes |
| Validation and retries | 2 to 15 minutes |
| Asset selection/code examples | 0 to 30 minutes |
| Total automated generation | 5 to 45 minutes typical |

If you manually review and edit, it can take hours.

---

## Realistic End-to-End Time for a 30-Minute Video

### Fully automated, simple template

```text
Claude generation: 5 to 20 minutes
Rendering: 5 to 15 minutes
Audio muxing: 1 to 3 minutes
Total: 10 to 40 minutes
```

### Moderate quality tech tutorial

```text
Claude generation: 15 to 45 minutes
Rendering: 15 to 35 minutes
Audio muxing: 1 to 5 minutes
Validation/fixes: 10 to 30 minutes
Total: 40 minutes to 2 hours
```

### High-quality polished video

```text
Scripting and scene generation: 30 to 120 minutes
Human review: 1 to 4 hours
Rendering: 15 to 60 minutes
Final export: 1 to 10 minutes
Total: 2 to 8 hours
```

---

## Why Long Videos Are Hard

A 30-minute video is not just 30 minutes of playback.

It is:

```text
54,000 frames at 30fps
```

Every frame must be:

```text
drawn
encoded
written to disk or piped to FFmpeg
```

If each frame takes 50ms:

```text
54,000 * 0.05 = 2,700 seconds
= 45 minutes
```

If each frame takes 20ms:

```text
54,000 * 0.02 = 1,080 seconds
= 18 minutes
```

If each frame takes 10ms:

```text
54,000 * 0.01 = 540 seconds
= 9 minutes
```

So your target should be:

```text
10ms to 20ms per frame
```

for fast 1080p30 rendering.

---

## How to Make 30-Minute Renders Faster

### 1. Render scenes in parallel

Instead of rendering one 30-minute timeline sequentially:

```text
Scene 1 → scene1.mp4
Scene 2 → scene2.mp4
Scene 3 → scene3.mp4
...
Final concat → final.mp4
```

Use FFmpeg concat:

```bash
ffmpeg -f concat -safe 0 -i list.txt -c copy final.mp4
```

Where `list.txt` contains:

```text
file 'scene1.mp4'
file 'scene2.mp4'
file 'scene3.mp4'
```

This can greatly speed up long renders on M3.

---

### 2. Cache static content

Cache:

```text
code blocks
titles
backgrounds
diagrams
logos
```

Do not re-render them every frame.

---

### 3. Avoid per-frame text layout

Text layout is expensive.

For each text layer:

```text
measure once
render once to offscreen canvas
draw bitmap each frame
```

---

### 4. Use 30fps, not 60fps, unless required

For most tech videos:

```text
30fps is enough
```

60fps doubles the frame count.

---

### 5. Use 1080p for first render

Do not preview in 4K.

Use:

```text
1080p30 for drafts
1080p30 or 4K30 for final export
```

---

### 6. Use VideoToolbox

Prefer:

```text
h264_videotoolbox
hevc_videotoolbox
```

Avoid relying only on CPU `libx264` for long videos unless you need maximum compatibility.

---

### 7. Use chapter-based generation

Do not ask Claude to generate 30 minutes in one response.

Generate:

```text
Chapter 1
Chapter 2
Chapter 3
...
```

Then combine.

---

## Practical Target for Your Framework

For a well-optimized M3 pipeline, aim for:

```text
30-minute 1080p30 video rendered in under 15 minutes
```

Very good target:

```text
30-minute 1080p30 video rendered in under 10 minutes
```

Aggressive target:

```text
30-minute 1080p30 video rendered in under 5 minutes
```

To hit under 5 minutes, you likely need:

```text
native rendering
scene caching
parallel scene rendering
optimized frame transfer to FFmpeg
minimal per-frame effects
```

---

## Final Recommendation

Start with:

```text
TypeScript
@napi-rs/canvas
Zod
FFmpeg VideoToolbox
Claude structured JSON output
```

Your first version should be:

```text
JSON in → beautiful MP4 out
```

Do not start with:

```text
React
DOM
headless browser
full Remotion replacement
```

Build the fast path first:

```text
Claude generates scene JSON
Library renders simple high-quality tech scenes
FFmpeg encodes quickly on Apple Silicon
```

Then add:

```text
code highlighting
captions
audio
parallel rendering
scene caching
WebGL effects
```

This gives you the best chance of generating and rendering long tech videos quickly on an M3 Mac.