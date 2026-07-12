import { describe, expect, it } from "vitest";
import { pxRectToPdfRect, rotatePoint, textAngle, uniformRotation, uprightViewport } from "./geometry";

describe("rotatePoint", () => {
  it("is an exact identity at angle 0", () => {
    expect(rotatePoint(37, 51, 0)).toEqual([37, 51]);
  });
  it("rotates CCW by 90 (x,y -> -y,x)", () => {
    expect(rotatePoint(200, -250, 90)).toEqual([250, 200]);
  });
  it("rotates by 270 (x,y -> y,-x)", () => {
    const [x, y] = rotatePoint(10, 20, 270);
    expect(x).toBeCloseTo(20, 9);
    expect(y).toBeCloseTo(-10, 9);
  });
  it("round-trips a point through +deg then -deg", () => {
    for (const deg of [90, 180, 270]) {
      const [ux, uy] = rotatePoint(123, -45, deg);
      const [bx, by] = rotatePoint(ux, uy, -deg);
      expect(bx).toBeCloseTo(123, 9);
      expect(by).toBeCloseTo(-45, 9);
    }
  });
});

describe("textAngle", () => {
  it("reports 0 for horizontal text", () => {
    expect(textAngle([22, 0, 0, 22, 5, 5])).toBe(0);
  });
  it("reports 90 for a /Rotate 90 upright text matrix", () => {
    expect(textAngle([0, 22, -22, 0, 250, 200])).toBe(90);
  });
  it("reports 180 and 270 for the flipped matrices", () => {
    expect(textAngle([-22, 0, 0, -22, 0, 0])).toBe(180);
    expect(textAngle([0, -22, 22, 0, 0, 0])).toBe(270);
  });
});

describe("uniformRotation", () => {
  it("is 0 when everything is upright", () => {
    expect(uniformRotation([0, 0, 0])).toBe(0);
  });
  it("is the shared angle when every item agrees", () => {
    expect(uniformRotation([90, 90, 90])).toBe(90);
  });
  it("falls back to 0 on any disagreement", () => {
    expect(uniformRotation([90, 90, 0])).toBe(0);
    expect(uniformRotation([90, 270])).toBe(0);
  });
  it("is 0 for no items", () => {
    expect(uniformRotation([])).toBe(0);
  });
});

describe("uprightViewport", () => {
  const vp = {
    convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
    convertToPdfPoint: (x: number, y: number) => [x, 800 - y],
  };
  it("returns the very same viewport object at angle 0 (no-op)", () => {
    expect(uprightViewport(vp, 0)).toBe(vp);
  });
  it("maps an upright point back to user space before delegating (deg 90)", () => {
    // upright (200,-250) -> user (250,200) -> viewport [250, 800-200]
    expect(uprightViewport(vp, 90).convertToViewportPoint(200, -250)).toEqual([250, 600]);
  });
});

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
