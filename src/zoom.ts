// The zoom a page opens at when the user has not chosen one.

export const ZOOM_MIN = 25;
export const ZOOM_MAX = 400;
export const ZOOM_STEP = 5;

/**
 * The largest zoom, in percent, at which a page of `pageWidthPx` fits in `availPx`: rounded down to
 * the slider's step, never above 100 (a small page is not blown up) and never below the minimum.
 */
export function fitZoomPct(availPx: number, pageWidthPx: number): number {
  if (!(availPx > 0) || !(pageWidthPx > 0)) return 100;
  const pct = Math.floor(((availPx / pageWidthPx) * 100) / ZOOM_STEP) * ZOOM_STEP;
  return Math.max(ZOOM_MIN, Math.min(100, pct));
}
