// Canvas colour sampling: read the foreground (glyph) colour, background colour and ink
// coverage of a rectangular region of the rendered page canvas. Extracted from index.ts so
// the pixel maths is unit-testable against a synthetic ImageData without a real canvas.
//
// Two entry points share one core: sampleColors reads its region straight from the context
// (one getImageData per call), while sampleColorsFrom samples a sub-rect of a page image the
// caller fetched ONCE. The render path uses the latter so a text-dense page does one
// getImageData for the whole page instead of one per line/run.
import type { RGB } from "./glyph-edit";

// Only the one viewport method the run sampler needs, so this module stays free of the
// pdf.js types (a real PageViewport satisfies it structurally).
export interface ViewportLike {
  convertToViewportPoint(x: number, y: number): number[];
}

// An RGBA pixel buffer (an ImageData satisfies this structurally).
export interface PageImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

// Sample the sw x sh sub-rect at (sx, sy) of a `stride`-wide RGBA buffer: background = the most
// common colour, foreground = the pixel furthest from it, ink = fraction far enough from bg.
function sampleRect(data: Uint8ClampedArray, stride: number, sx: number, sy: number, sw: number, sh: number): { fg: RGB; bg: RGB; ink: number } {
  const counts = new Map<string, { r: number; g: number; b: number; n: number }>();
  for (let yy = sy; yy < sy + sh; yy++)
    for (let xx = sx; xx < sx + sw; xx++) {
      const i = (yy * stride + xx) * 4;
      if ((data[i + 3] ?? 0) < 128) continue;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      const e = counts.get(key);
      if (e) {
        e.r += r;
        e.g += g;
        e.b += b;
        e.n++;
      } else counts.set(key, { r, g, b, n: 1 });
    }
  let bg: RGB = { r: 255, g: 255, b: 255 };
  let max = 0;
  for (const e of counts.values()) {
    if (e.n > max) {
      max = e.n;
      bg = { r: e.r / e.n, g: e.g / e.n, b: e.b / e.n };
    }
  }
  let fg = bg;
  let best = -1;
  let ink = 0; // opaque pixels far enough from bg to be glyph coverage
  for (let yy = sy; yy < sy + sh; yy++)
    for (let xx = sx; xx < sx + sw; xx++) {
      const i = (yy * stride + xx) * 4;
      if ((data[i + 3] ?? 0) < 128) continue;
      const dr = data[i]! - bg.r;
      const dg = data[i + 1]! - bg.g;
      const db = data[i + 2]! - bg.b;
      const d = dr * dr + dg * dg + db * db;
      if (d > 8000) ink++;
      if (d > best) {
        best = d;
        fg = { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! };
      }
    }
  const total = sw * sh;
  return { fg, bg, ink: total ? ink / total : 0 };
}

const clampRect = (x: number, y: number, w: number, h: number, cw: number, ch: number) => {
  const sx = Math.max(0, Math.min(Math.floor(x), cw - 1));
  const sy = Math.max(0, Math.min(Math.floor(y), ch - 1));
  return { sx, sy, sw: Math.max(1, Math.min(Math.floor(w), cw - sx)), sh: Math.max(1, Math.min(Math.floor(h), ch - sy)) };
};

export function sampleColors(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): { fg: RGB; bg: RGB; ink: number } {
  const { sx, sy, sw, sh } = clampRect(x, y, w, h, ctx.canvas.width, ctx.canvas.height);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(sx, sy, sw, sh).data;
  } catch {
    return { fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 }, ink: 0 };
  }
  return sampleRect(data, sw, 0, 0, sw, sh); // the region buffer is exactly sw wide
}

// Same as sampleColors but samples a sub-rect of a page image the caller already fetched, so a
// whole page's line/run probes cost a single getImageData instead of one each.
export function sampleColorsFrom(img: PageImage, x: number, y: number, w: number, h: number): { fg: RGB; bg: RGB; ink: number } {
  const { sx, sy, sw, sh } = clampRect(x, y, w, h, img.width, img.height);
  return sampleRect(img.data, img.width, sx, sy, sw, sh);
}

/** Glyph color and ink coverage of a single run's box, sampled from the rendered canvas. */
export function sampleRunStats(ctx: CanvasRenderingContext2D, viewport: ViewportLike, x: number, baseY: number, w: number, size: number): { fg: RGB; ink: number } {
  const { left, top, dW, dH } = runBox(viewport, x, baseY, w, size);
  const s = sampleColors(ctx, left, top, dW, dH);
  return { fg: s.fg, ink: s.ink };
}

/** Same as sampleRunStats but against a pre-fetched page image. */
export function sampleRunStatsFrom(img: PageImage, viewport: ViewportLike, x: number, baseY: number, w: number, size: number): { fg: RGB; ink: number } {
  const { left, top, dW, dH } = runBox(viewport, x, baseY, w, size);
  const s = sampleColorsFrom(img, left, top, dW, dH);
  return { fg: s.fg, ink: s.ink };
}

function runBox(viewport: ViewportLike, x: number, baseY: number, w: number, size: number): { left: number; top: number; dW: number; dH: number } {
  const tl = viewport.convertToViewportPoint(x, baseY + size * 0.85);
  const br = viewport.convertToViewportPoint(x + w, baseY - size * 0.2);
  return {
    left: Math.min(tl[0]!, br[0]!),
    top: Math.min(tl[1]!, br[1]!),
    dW: Math.max(Math.abs(br[0]! - tl[0]!), 2),
    dH: Math.max(Math.abs(br[1]! - tl[1]!), 2),
  };
}
