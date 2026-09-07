import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";

export interface RasterCache {
  getOrRender(key: string, width: number, height: number, paint: (ctx: SKRSContext2D) => void): Canvas;
  stats(): { hits: number; misses: number; bytesUsed: number };
  dispose(): void;
}

export function createRasterCache(limitBytes: number): RasterCache {
  const entries = new Map<string, { canvas: Canvas; bytes: number }>(); // insertion order = LRU recency
  let bytesUsed = 0;
  let hits = 0, misses = 0;

  return {
    getOrRender(key, width, height, paint) {
      const existing = entries.get(key);
      if (existing) {
        hits++;
        entries.delete(key); entries.set(key, existing); // bump recency
        return existing.canvas;
      }
      misses++;
      const canvas = createCanvas(width, height);
      paint(canvas.getContext("2d"));
      const bytes = width * height * 4;
      entries.set(key, { canvas, bytes });
      bytesUsed += bytes;
      while (bytesUsed > limitBytes && entries.size > 1) {
        const [oldestKey, oldest] = entries.entries().next().value!;
        entries.delete(oldestKey);
        bytesUsed -= oldest.bytes;
      }
      return canvas;
    },
    stats: () => ({ hits, misses, bytesUsed }),
    dispose() { entries.clear(); bytesUsed = 0; },
  };
}
