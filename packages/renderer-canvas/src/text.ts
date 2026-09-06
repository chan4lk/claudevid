import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import type { TextLayer } from "@claudevid/core";
import type { RasterCache } from "./raster-cache.js";
import { SANS_FONT_FAMILY } from "./fonts.js";

export interface TextLayoutResult {
  lines: string[];
  lineHeightPx: number;
  totalWidth: number;
  totalHeight: number;
}

// Only used to call ctx.font/measureText before the final (correctly-sized) canvas exists.
const measureCanvas = createCanvas(1, 1);
const measureCtx = measureCanvas.getContext("2d");

function fontString(layer: TextLayer): string {
  const fontSize = layer.fontSize ?? 64;
  const fontWeight = layer.fontWeight ?? 600;
  const fontFamily = layer.fontFamily ?? SANS_FONT_FAMILY;
  return `${fontWeight} ${fontSize}px ${fontFamily}`;
}

function wrapWords(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function measureAndWrap(ctx: SKRSContext2D, layer: TextLayer): TextLayoutResult {
  ctx.font = fontString(layer);
  const fontSize = layer.fontSize ?? 64;
  const lineHeightPx = fontSize * (layer.lineHeight ?? 1.2);
  const lines = layer.maxWidth ? wrapWords(ctx, layer.text, layer.maxWidth) : [layer.text];
  const totalWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
  const totalHeight = lines.length * lineHeightPx;
  return { lines, lineHeightPx, totalWidth, totalHeight };
}

// Plain string-join "hash": Map keys only need to be unique+stable, not cryptographic,
// so avoid pulling in node:crypto for something concatenation already solves.
function contentHash(parts: (string | number | undefined)[]): string {
  return parts.map((p) => String(p)).join("|");
}

// `cacheKeyPrefix` (the caller's layerKey) is accepted for signature symmetry with sibling
// paint*Layer functions but deliberately NOT hashed in: per FR4, two layers with identical
// text/font/color should share one cached bitmap rather than duplicating it per layer.
export function paintTextLayer(cache: RasterCache, layer: TextLayer, _cacheKeyPrefix: string): Canvas {
  const { lines, lineHeightPx, totalWidth, totalHeight } = measureAndWrap(measureCtx, layer);
  const key = contentHash([
    layer.text,
    layer.fontSize,
    layer.fontWeight,
    layer.color,
    layer.fontFamily,
    layer.maxWidth,
    layer.lineHeight,
    layer.align,
  ]);
  return cache.getOrRender(key, Math.ceil(totalWidth), Math.ceil(totalHeight), (ctx) => {
    ctx.font = fontString(layer);
    ctx.textBaseline = "top";
    ctx.fillStyle = layer.color ?? "#ffffff";
    const align = layer.align ?? "left";
    ctx.textAlign = align;
    for (const [i, line] of lines.entries()) {
      const x = align === "left" ? 0 : align === "center" ? totalWidth / 2 : totalWidth;
      ctx.fillText(line, x, i * lineHeightPx);
    }
  });
}
