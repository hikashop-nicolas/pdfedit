// Page-space geometry: convert an overlay's pixel rectangle (CSS left/top/width/height, y-down)
// into a PDF-space rectangle (y-up origin at bottom-left) for a page's viewport. Split from the
// DOM reads in index.ts so the axis-flip / rotation handling is unit-testable.

// Only the one viewport method needed, so this stays free of the pdf.js types (a real
// PageViewport satisfies it structurally).
export interface PdfPointViewport {
  convertToPdfPoint(x: number, y: number): number[];
}

export interface PdfRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// --- Rotated-page (rotated text matrix) support ------------------------------
// Some PDFs draw their text with a rotated text matrix (e.g. a landscape document
// stored as portrait + /Rotate 90, whose glyphs are pre-rotated so they display
// upright). pdf.js reports every item's transform in the page's UNROTATED user
// space, so a rotated page's baselines run vertically there and the read heuristics
// (group by horizontal baseline) mis-group them. The fix reads and edits such a page
// in an "upright" space (the user space deskewed by the text angle), then maps back
// to user space plus a draw rotation on export. Angle 0 is always a no-op.

// Rotate a point CCW by `deg` about the origin. Quarter turns (the only angles used for
// rotated pages) are returned exactly, so angle 0 is an identity pass-through and 90/180/270
// avoid the sub-pixel drift of cos/sin.
export function rotatePoint(x: number, y: number, deg: number): [number, number] {
  switch (((deg % 360) + 360) % 360) {
    case 0:
      return [x, y];
    case 90:
      return [-y, x];
    case 180:
      return [-x, -y];
    case 270:
      return [y, -x];
    default: {
      const r = (deg * Math.PI) / 180;
      const c = Math.cos(r);
      const s = Math.sin(r);
      return [x * c - y * s, x * s + y * c];
    }
  }
}

// The rotation of a pdf.js text-item transform [a,b,c,d,e,f], rounded to the nearest
// multiple of 90 in [0,360). Horizontal text -> 0; a /Rotate 90 upright page -> 90.
export function textAngle(t: number[]): number {
  const deg = (Math.atan2(t[1] ?? 0, t[0] ?? 0) * 180) / Math.PI;
  return (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
}

// The single non-zero angle shared by EVERY item, else 0. A page is handled as rotated
// only when all its (non-blank) text agrees on one 90/180/270 angle; mixed or upright
// pages fall back to the plain (angle-0) path, so nothing regresses there.
export function uniformRotation(angles: number[]): number {
  if (angles.length === 0) return 0;
  const a0 = angles[0]!;
  if (a0 === 0) return 0;
  for (const a of angles) if (a !== a0) return 0;
  return a0;
}

// A viewport wrapper that presents an upright-space point as if it were a user-space one:
// it rotates an upright (x,y) back to user space by `deg` before delegating, so all the
// existing viewport-based reads (overlay placement, canvas colour sampling) work unchanged
// on a rotated page. deg 0 returns the real viewport untouched (byte-for-byte no-op).
export interface FullViewport extends PdfPointViewport {
  convertToViewportPoint(x: number, y: number): number[];
}
export function uprightViewport<V extends FullViewport>(vp: V, deg: number): FullViewport {
  if (!deg) return vp;
  return {
    convertToViewportPoint(x: number, y: number): number[] {
      const [ux, uy] = rotatePoint(x, y, deg);
      return vp.convertToViewportPoint(ux, uy);
    },
    convertToPdfPoint(x: number, y: number): number[] {
      const [ux, uy] = vp.convertToPdfPoint(x, y);
      return rotatePoint(ux, uy, -deg);
    },
  };
}

// Map the pixel rect's two opposite corners through the viewport and normalise with min/abs, so
// a viewport that flips or rotates the axes (e.g. a /Rotate 90 page) still yields a positive,
// correctly-placed PDF rect.
export function pxRectToPdfRect(left: number, top: number, w: number, h: number, viewport: PdfPointViewport): PdfRect {
  const tl = viewport.convertToPdfPoint(left, top);
  const br = viewport.convertToPdfPoint(left + w, top + h);
  return {
    x: Math.min(tl[0]!, br[0]!),
    y: Math.min(tl[1]!, br[1]!),
    w: Math.abs(br[0]! - tl[0]!),
    h: Math.abs(br[1]! - tl[1]!),
  };
}
