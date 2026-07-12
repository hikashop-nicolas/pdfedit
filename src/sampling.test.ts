import { describe, expect, it } from "vitest";
import { sampleColors, sampleRunStats } from "./sampling";

// A fake 2D context backed by an in-memory RGBA pixel buffer, so the pixel maths can be
// exercised without a real canvas. `pixels` is row-major [r,g,b,a] per pixel.
function ctxFrom(w: number, h: number, pixels: number[]): CanvasRenderingContext2D {
  const data = Uint8ClampedArray.from(pixels);
  return {
    canvas: { width: w, height: h },
    getImageData: (sx: number, sy: number, sw: number, sh: number) => {
      const out: number[] = [];
      for (let yy = sy; yy < sy + sh; yy++)
        for (let xx = sx; xx < sx + sw; xx++) {
          const i = (yy * w + xx) * 4;
          out.push(data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!);
        }
      return { data: Uint8ClampedArray.from(out) };
    },
  } as unknown as CanvasRenderingContext2D;
}

// Build a WxH region: white background with `nBlack` black pixels in the top-left.
function region(w: number, h: number, nBlack: number): CanvasRenderingContext2D {
  const px: number[] = [];
  let black = nBlack;
  for (let i = 0; i < w * h; i++) {
    if (black-- > 0) px.push(0, 0, 0, 255);
    else px.push(255, 255, 255, 255);
  }
  return ctxFrom(w, h, px);
}

describe("sampleColors", () => {
  it("reports the majority colour as background and the outlier as foreground", () => {
    const { fg, bg } = sampleColors(region(10, 10, 8), 0, 0, 10, 10); // mostly white, a few black
    expect(bg).toEqual({ r: 255, g: 255, b: 255 });
    expect(fg).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("measures ink coverage as the fraction of pixels far from the background", () => {
    const { ink } = sampleColors(region(10, 10, 25), 0, 0, 10, 10); // 25 of 100 black
    expect(ink).toBeCloseTo(0.25, 5);
  });

  it("reports zero ink for a uniform region", () => {
    const { ink, fg, bg } = sampleColors(region(8, 8, 0), 0, 0, 8, 8);
    expect(ink).toBe(0);
    expect(fg).toEqual(bg);
  });

  it("clamps the sample rectangle to the canvas bounds", () => {
    // Asking for a region past the edge must not throw and still sample real pixels.
    const { bg } = sampleColors(region(4, 4, 0), 2, 2, 100, 100);
    expect(bg).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("falls back to black-on-white when getImageData throws (tainted canvas)", () => {
    const ctx = { canvas: { width: 10, height: 10 }, getImageData: () => { throw new Error("tainted"); } } as unknown as CanvasRenderingContext2D;
    expect(sampleColors(ctx, 0, 0, 10, 10)).toEqual({ fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 }, ink: 0 });
  });
});

describe("sampleRunStats", () => {
  it("maps a run box through the viewport and returns the sampled fg + ink", () => {
    // baseY 5, size 10 -> the sampler reads canvas rows ~3..13, so put a black band there.
    const px: number[] = [];
    for (let r = 0; r < 20; r++)
      for (let c = 0; c < 20; c++) {
        const black = r >= 4 && r <= 9 && c < 4;
        px.push(black ? 0 : 255, black ? 0 : 255, black ? 0 : 255, 255);
      }
    const ctx = ctxFrom(20, 20, px);
    // Identity viewport: PDF (x, y-up) -> canvas point (x, y).
    const viewport = { convertToViewportPoint: (x: number, y: number) => [x, y] };
    const { fg, ink } = sampleRunStats(ctx, viewport, 0, 5, 20, 10);
    expect(fg).toEqual({ r: 0, g: 0, b: 0 });
    expect(ink).toBeGreaterThan(0);
  });
});
