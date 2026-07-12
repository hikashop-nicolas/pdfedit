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
