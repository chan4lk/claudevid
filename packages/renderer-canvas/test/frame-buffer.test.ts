import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { createFrameBuffer, createFrameBufferPool } from "../src/frame-buffer.js";

describe("createFrameBuffer", () => {
  it("produces a buffer of exactly width * height * 4 bytes", () => {
    const fb = createFrameBuffer(16, 9);
    expect(fb.width).toBe(16);
    expect(fb.height).toBe(9);
    expect(fb.data.length).toBe(16 * 9 * 4);
  });
});

describe("@napi-rs/canvas RGBA byte order (AC2)", () => {
  it("reads back a pure red fill as [255, 0, 0, 255]", () => {
    const canvas = createCanvas(1, 1);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 1, 1);

    const data = canvas.data();
    expect([data[0], data[1], data[2], data[3]]).toEqual([255, 0, 0, 255]);
  });
});

describe("createFrameBufferPool", () => {
  it("acquires up to `size` buffers successfully", () => {
    const pool = createFrameBufferPool(4, 4, 2);
    const a = pool.acquire();
    const b = pool.acquire();
    expect(a.data.length).toBe(4 * 4 * 4);
    expect(b.data.length).toBe(4 * 4 * 4);
  });

  it("throws when acquiring one more than `size` without releasing", () => {
    const pool = createFrameBufferPool(4, 4, 1);
    pool.acquire();
    expect(() => pool.acquire()).toThrowError(/exhausted/);
  });

  it("allows acquire to succeed again after release (reuses the freed slot)", () => {
    const pool = createFrameBufferPool(4, 4, 1);
    const fb = pool.acquire();
    expect(() => pool.acquire()).toThrow();
    pool.release(fb);
    const reacquired = pool.acquire();
    expect(reacquired).toBe(fb);
  });
});
