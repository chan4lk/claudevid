import { describe, expect, it } from "vitest";
import { orderIndices } from "../src/stagger.js";

describe("orderIndices (AC5, FR10)", () => {
  it("'first' assigns rank in original order", () => {
    expect(orderIndices(["a", "b", "c"], "first")).toEqual([0, 1, 2]);
  });

  it("'last' reverses the order", () => {
    expect(orderIndices(["a", "b", "c"], "last")).toEqual([2, 1, 0]);
  });

  it("'center' ranks the middlemost element first", () => {
    const order = orderIndices(["a", "b", "c", "d", "e"], "center");
    expect(order[2]).toBe(0);
  });

  it("'random' produces the identical ordering across repeated calls — the determinism claim", () => {
    const keys = ["scenes/0/layers/0/0", "scenes/0/layers/0/1", "scenes/0/layers/0/2", "scenes/0/layers/0/3"];
    expect(orderIndices(keys, "random")).toEqual(orderIndices(keys, "random"));
  });

  it("'random' produces a permutation of 0..n-1, not a lossy or repeated ranking", () => {
    const keys = ["a", "b", "c", "d", "e"];
    const order = orderIndices(keys, "random");
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });
});
