export interface StaggerSpec {
  /** Seconds, added per rank position to each child's track delay. */
  each: number;
  from?: "first" | "center" | "last" | "random";
}

/** Pure 32-bit FNV-1a — used only to derive a deterministic `"random"` stagger order from a
 * child's `layerKey` (spec.md FR10). No `Math.random`/`Date.now` anywhere in this file
 * (NFR2): the same spec always produces the same cascade, and two workers rendering adjacent
 * chunks of the same scene (change 005, future) never disagree at a chunk boundary. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function rankFromOrder(order: number[]): number[] {
  const rank = new Array<number>(order.length);
  order.forEach((originalIndex, position) => {
    rank[originalIndex] = position;
  });
  return rank;
}

/** Returns, for each position `i` in `childKeys`, its 0-based rank in stagger order. */
export function orderIndices(childKeys: string[], from: StaggerSpec["from"] = "first"): number[] {
  const n = childKeys.length;
  const indices = childKeys.map((_, i) => i);

  if (from === "first") return indices;
  if (from === "last") return indices.map((i) => n - 1 - i);

  if (from === "center") {
    const middle = (n - 1) / 2;
    const order = [...indices].sort((a, b) => {
      const da = Math.abs(a - middle);
      const db = Math.abs(b - middle);
      return da !== db ? da - db : a - b;
    });
    return rankFromOrder(order);
  }

  // "random": stable-sort by a pure hash of each child's own layerKey.
  const order = [...indices].sort((a, b) => {
    const ha = fnv1a(childKeys[a]!);
    const hb = fnv1a(childKeys[b]!);
    return ha !== hb ? ha - hb : a - b;
  });
  return rankFromOrder(order);
}
