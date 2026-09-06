export interface RenderStats {
  msPerFrame: number[];
  p50: number;
  p95: number;
  cacheHits: number;
  cacheMisses: number;
  holdFrames: number;
  perLayerTypeMs: Record<string, number>;
}

export interface StatsCollector {
  recordFrameMs(ms: number): void;
  recordCacheHit(): void;
  recordCacheMiss(): void;
  recordHoldFrame(): void;
  recordPaint(): void;
  recordLayerTypeMs(type: string, ms: number): void;
  stats(): RenderStats;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(p * (sorted.length - 1))] ?? 0;
}

export function createStatsCollector(): StatsCollector {
  const msPerFrame: number[] = [];
  const perLayerTypeMs: Record<string, number> = {};
  let cacheHits = 0;
  let cacheMisses = 0;
  let holdFrames = 0;
  let paints = 0;

  return {
    recordFrameMs(ms) {
      msPerFrame.push(ms);
    },
    recordCacheHit() {
      cacheHits++;
    },
    recordCacheMiss() {
      cacheMisses++;
    },
    recordHoldFrame() {
      holdFrames++;
    },
    recordPaint() {
      paints++;
    },
    recordLayerTypeMs(type, ms) {
      perLayerTypeMs[type] = (perLayerTypeMs[type] ?? 0) + ms;
    },
    stats() {
      const sorted = [...msPerFrame].sort((a, b) => a - b);
      return {
        msPerFrame: [...msPerFrame],
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        cacheHits,
        cacheMisses,
        holdFrames,
        perLayerTypeMs: { ...perLayerTypeMs },
      };
    },
  };
}
