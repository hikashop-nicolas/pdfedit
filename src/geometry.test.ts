import { describe, expect, it } from "vitest";
import { pxRectToPdfRect } from "./geometry";

describe("pxRectToPdfRect", () => {
  it("flips the y axis for an upright page (y-down px -> y-up pdf)", () => {
    // A 800pt-tall page: pdf_y = 800 - px_y. The box top(px) becomes the box bottom edge...
    const vp = { convertToPdfPoint: (x: number, y: number) => [x, 800 - y] };
    const r = pxRectToPdfRect(100, 50, 40, 30, vp); // px rect at (100,50) 40x30
    // corners -> pdf (100,750) and (140,720); normalised: x=100 y=720 w=40 h=30.
    expect(r).toEqual({ x: 100, y: 720, w: 40, h: 30 });
  });

  it("normalises a rotated (axis-swapping) viewport to a positive rect", () => {
    // A /Rotate 90 style transform that swaps and offsets axes.
    const vp = { convertToPdfPoint: (x: number, y: number) => [y, x] };
    const r = pxRectToPdfRect(10, 200, 5, 60, vp);
    // corners -> (200,10) and (260,15); normalised: x=200 y=10 w=60 h=5.
    expect(r).toEqual({ x: 200, y: 10, w: 60, h: 5 });
  });

  it("passes an identity viewport through unchanged", () => {
    const vp = { convertToPdfPoint: (x: number, y: number) => [x, y] };
    expect(pxRectToPdfRect(0, 0, 10, 20, vp)).toEqual({ x: 0, y: 0, w: 10, h: 20 });
  });
});
