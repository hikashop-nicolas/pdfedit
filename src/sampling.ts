// Canvas colour sampling: read the foreground (glyph) colour, background colour and ink
// coverage of a rectangular region of the rendered page canvas. Extracted from index.ts so
// the pixel maths is unit-testable against a synthetic ImageData without a real canvas.
import type { RGB } from "./glyph-edit";

// Only the one viewport method the run sampler needs, so this module stays free of the
// pdf.js types (a real PageViewport satisfies it structurally).
export interface ViewportLike {
  convertToViewportPoint(x: number, y: number): number[];
}

export function sampleColors(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): { fg: RGB; bg: RGB; ink: number } {
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const sx = Math.max(0, Math.min(Math.floor(x), cw - 1));
  const sy = Math.max(0, Math.min(Math.floor(y), ch - 1));
  const sw = Math.max(1, Math.min(Math.floor(w), cw - sx));
  const sh = Math.max(1, Math.min(Math.floor(h), ch - sy));
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(sx, sy, sw, sh).data;
  } catch {
    return { fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 }, ink: 0 };
  }
  // Background = most common color in the region (robust vs. a corner pixel landing
  // on a glyph). Foreground = the pixel furthest from the background.
  const counts = new Map<string, { r: number; g: number; b: number; n: number }>();
  for (let i = 0; i < data.length; i += 4) {
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
  for (let i = 0; i < data.length; i += 4) {
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
  return { fg, bg, ink: data.length ? ink / (data.length / 4) : 0 };
}

/** Glyph color and ink coverage of a single run's box, sampled from the rendered canvas. */
export function sampleRunStats(ctx: CanvasRenderingContext2D, viewport: ViewportLike, x: number, baseY: number, w: number, size: number): { fg: RGB; ink: number } {
  const tl = viewport.convertToViewportPoint(x, baseY + size * 0.85);
  const br = viewport.convertToViewportPoint(x + w, baseY - size * 0.2);
  const left = Math.min(tl[0]!, br[0]!);
  const top = Math.min(tl[1]!, br[1]!);
  const dW = Math.abs(br[0]! - tl[0]!);
  const dH = Math.abs(br[1]! - tl[1]!);
  const s = sampleColors(ctx, left, top, Math.max(dW, 2), Math.max(dH, 2));
  return { fg: s.fg, ink: s.ink };
}
