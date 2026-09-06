import { loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import type { ImageLayer } from "@claudevid/core";

const decodeCache = new Map<string, Image>();

export async function loadAndCacheImage(src: string): Promise<Image> {
  const cached = decodeCache.get(src);
  if (cached) return cached;
  const image = await loadImage(src);
  decodeCache.set(src, image);
  return image;
}

export function computeFitRect(
  imgWidth: number,
  imgHeight: number,
  boxWidth: number,
  boxHeight: number,
  fit: "cover" | "contain" | "fill"
): { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } {
  if (fit === "fill") {
    return { sx: 0, sy: 0, sw: imgWidth, sh: imgHeight, dx: 0, dy: 0, dw: boxWidth, dh: boxHeight };
  }

  const scale =
    fit === "contain"
      ? Math.min(boxWidth / imgWidth, boxHeight / imgHeight)
      : Math.max(boxWidth / imgWidth, boxHeight / imgHeight);

  if (fit === "contain") {
    const dw = imgWidth * scale;
    const dh = imgHeight * scale;
    return { sx: 0, sy: 0, sw: imgWidth, sh: imgHeight, dx: (boxWidth - dw) / 2, dy: (boxHeight - dh) / 2, dw, dh };
  }

  // cover: crop the source to the box's aspect ratio, fill the whole box
  const sw = boxWidth / scale;
  const sh = boxHeight / scale;
  return { sx: (imgWidth - sw) / 2, sy: (imgHeight - sh) / 2, sw, sh, dx: 0, dy: 0, dw: boxWidth, dh: boxHeight };
}

export async function paintImageLayer(
  ctx: SKRSContext2D,
  layer: ImageLayer,
  resolvedX: number,
  resolvedY: number
): Promise<void> {
  const image = await loadAndCacheImage(layer.src);
  const boxWidth = layer.width ?? image.naturalWidth;
  const boxHeight = layer.height ?? image.naturalHeight;
  const { sx, sy, sw, sh, dx, dy, dw, dh } = computeFitRect(
    image.naturalWidth,
    image.naturalHeight,
    boxWidth,
    boxHeight,
    layer.fit ?? "fill"
  );
  ctx.drawImage(image, sx, sy, sw, sh, resolvedX + dx, resolvedY + dy, dw, dh);
}
