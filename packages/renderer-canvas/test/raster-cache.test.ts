import { describe, expect, it, vi } from "vitest";
import { createRasterCache } from "../src/raster-cache.js";

describe("createRasterCache — hit/miss behavior", () => {
  it("does not re-invoke paint on a second getOrRender with the same key, and returns the same canvas", () => {
    const cache = createRasterCache(1024 * 1024);
    const paint = vi.fn();

    const first = cache.getOrRender("a", 4, 4, paint);
    const second = cache.getOrRender("a", 4, 4, paint);

    expect(paint).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("produces two different canvases for two different keys, invoking paint once per key", () => {
    const cache = createRasterCache(1024 * 1024);
    const paint = vi.fn();

    const a = cache.getOrRender("a", 4, 4, paint);
    const b = cache.getOrRender("b", 4, 4, paint);

    expect(paint).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
  });
});

describe("createRasterCache — stats()", () => {
  it("reports correct cumulative hits/misses across a sequence of calls", () => {
    const cache = createRasterCache(1024 * 1024);
    const paint = vi.fn();

    cache.getOrRender("a", 4, 4, paint); // miss
    cache.getOrRender("a", 4, 4, paint); // hit
    cache.getOrRender("b", 4, 4, paint); // miss
    cache.getOrRender("a", 4, 4, paint); // hit
    cache.getOrRender("b", 4, 4, paint); // hit

    expect(cache.stats()).toEqual({ hits: 3, misses: 2, bytesUsed: 4 * 4 * 4 * 2 });
  });
});

describe("createRasterCache — LRU eviction", () => {
  it("evicts the least-recently-used entry when the byte limit is exceeded", () => {
    // Each 4x4 canvas costs 4*4*4 = 64 bytes. Limit fits 2 but not 3.
    const cache = createRasterCache(130);
    const paintA = vi.fn();
    const paintB = vi.fn();
    const paintC = vi.fn();

    cache.getOrRender("a", 4, 4, paintA); // miss, bytesUsed = 64
    cache.getOrRender("b", 4, 4, paintB); // miss, bytesUsed = 128
    cache.getOrRender("c", 4, 4, paintC); // miss, bytesUsed = 192 -> evict "a" -> 128

    expect(cache.stats().bytesUsed).toBe(128);

    // "a" was evicted: requesting it again must be a fresh miss (paintA invoked again).
    cache.getOrRender("a", 4, 4, paintA);
    expect(paintA).toHaveBeenCalledTimes(2);
  });
});

describe("createRasterCache — dispose()", () => {
  it("clears state such that a previously-cached key misses on the next getOrRender", () => {
    const cache = createRasterCache(1024 * 1024);
    const paint = vi.fn();

    cache.getOrRender("a", 4, 4, paint);
    cache.dispose();
    cache.getOrRender("a", 4, 4, paint);

    expect(paint).toHaveBeenCalledTimes(2);
    expect(cache.stats().hits).toBe(0);
  });
});
