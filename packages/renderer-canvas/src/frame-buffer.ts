/** Caller-owned RGBA pixel buffer: `data.length === width * height * 4`. */
export interface FrameBuffer {
  width: number;
  height: number;
  data: Buffer;
}

/** Allocates a new `FrameBuffer`. Uninitialized memory — callers paint before reading. */
export function createFrameBuffer(width: number, height: number): FrameBuffer {
  return { width, height, data: Buffer.allocUnsafe(width * height * 4) };
}

/**
 * Fixed-size pool of pre-allocated `FrameBuffer`s so the render loop never allocates per
 * frame in steady state. Does not grow: `acquire()` past `size` concurrently-held buffers
 * throws rather than silently allocating more.
 */
export function createFrameBufferPool(
  width: number,
  height: number,
  size: number,
): { acquire(): FrameBuffer; release(fb: FrameBuffer): void } {
  const free: FrameBuffer[] = [];
  for (let i = 0; i < size; i++) {
    free.push(createFrameBuffer(width, height));
  }

  return {
    acquire(): FrameBuffer {
      const fb = free.pop();
      if (!fb) {
        throw new Error(`FrameBuffer pool exhausted (size: ${size})`);
      }
      return fb;
    },
    release(fb: FrameBuffer): void {
      free.push(fb);
    },
  };
}
