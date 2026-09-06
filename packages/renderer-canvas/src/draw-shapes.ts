import type { Canvas } from "@napi-rs/canvas";
import type { RectLayer } from "@claudevid/core";
import type { RasterCache } from "./raster-cache.js";

// Plain string-join "hash": Map keys only need to be unique+stable, not cryptographic,
// so avoid pulling in node:crypto for something concatenation already solves.
function contentHash(parts: (string | number | undefined)[]): string {
  return parts.map((p) => String(p)).join("|");
}

export function paintRectLayer(cache: RasterCache, layer: RectLayer): Canvas {
  const key = contentHash([layer.width, layer.height, layer.fill, layer.stroke, layer.strokeWidth, layer.radius]);
  return cache.getOrRender(key, layer.width, layer.height, (ctx) => {
    if (layer.radius) {
      ctx.beginPath();
      ctx.roundRect(0, 0, layer.width, layer.height, layer.radius);
    } else {
      ctx.beginPath();
      ctx.rect(0, 0, layer.width, layer.height);
    }
    if (layer.fill) {
      ctx.fillStyle = layer.fill;
      ctx.fill();
    }
    if (layer.stroke) {
      ctx.strokeStyle = layer.stroke;
      ctx.lineWidth = layer.strokeWidth ?? 1;
      ctx.stroke();
    }
  });
}
