// Paragraph reconstruction: the pure, DOM-free heuristics that turn a page's flat list of
// positioned text runs (RunItem) into lines and paragraph blocks, decide where spaces belong,
// and infer alignment. Extracted from index.ts so this trickiest layer is unit-testable in
// isolation (no canvas, no pdf.js, no DOM).
import type { Anchor, RGB } from "./glyph-edit";

export type Align = "left" | "center" | "right" | "justify";

export interface RunItem {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
  fontName: string;
  /** Per-character original-glyph anchors (font resource + byte code), when recoverable. */
  anchors?: (Anchor | null)[];
  /** The glyphs are drawn invisibly (white fill / render mode 3), so omit from the overlay. */
  invisible?: boolean;
}

export interface Line {
  items: RunItem[];
  y: number;
  minX: number;
  maxX: number;
  size: number;
  text: string;
}

// Map a symbol font's Private Use Area codes (0xF001-0xF0FF) back to their ASCII equivalents,
// so PUA-encoded text reads as normal characters in the overlay.
export const normalizePua = (s: string): string => {
  if (!/[\uF000-\uF0FF]/.test(s)) return s;
  let out = "";
  for (const ch of s) {
    const cp = ch.charCodeAt(0);
    out += cp >= 0xf001 && cp <= 0xf0ff ? String.fromCharCode(cp - 0xf000) : ch;
  }
  return out;
};

// Re-encode normalized text back to the symbol font's Private Use Area codes (the inverse
// of normalizePua) so a reused embedded symbol font finds its glyphs on export.
export const toPua = (s: string): string => {
  let out = "";
  for (const ch of s) {
    const cp = ch.charCodeAt(0);
    out += cp >= 0x20 && cp <= 0xff ? String.fromCharCode(0xf000 + cp) : ch;
  }
  return out;
};

// Plausible advance width of a text item. Some subset fonts report garbage widths (many
// times the page width); fall back to an estimate so one bad item can't distort layout.
export const itemWidth = (it: RunItem): number => {
  const plausible = it.str.length * it.size * 1.5 + it.size;
  return it.w > 0 && it.w <= plausible ? it.w : it.str.length * it.size * 0.5;
};

// Whether to insert a space between two items: a positional gap (adjacent label/value with
// no space char), or a strong overlap (distinct text pieces laid over each other), but not
// when whitespace already borders the seam.
export const wantSpace = (gap: number, size: number, before: string, next: string): boolean =>
  (gap > size * 0.2 || gap < -size * 0.5) && before !== "" && !/\s$/.test(before) && !/^\s/.test(next);

// Join items on one line, inserting spaces per wantSpace (PDFs often emit adjacent runs,
// e.g. a label and a value, with no space char between them).
export const joinItems = (items: RunItem[]): string => {
  let text = "";
  let prevEnd = -Infinity;
  for (const it of items) {
    if (prevEnd > -Infinity && wantSpace(it.x - prevEnd, it.size, text, it.str)) text += " ";
    text += it.str;
    prevEnd = it.x + itemWidth(it);
  }
  return text;
};

export const colorDist = (a: RGB, b: RGB): number => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

export const variance = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
};
export const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

// A large horizontal gap between items sharing a baseline marks a column / block boundary
// (e.g. a left-aligned footer and a right-aligned page number sit on the same baseline but
// are separate blocks). Gaps wider than this many ems split a baseline into segments.
export const COL_GAP_EM = 2.2;

export function buildLines(items: RunItem[]): Line[] {
  // 1) group items into baselines (same y within tolerance)
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const baselines: RunItem[][] = [];
  let curY = 0;
  let curSize = 0;
  for (const it of sorted) {
    const base = baselines[baselines.length - 1];
    if (base && Math.abs(curY - it.y) <= Math.max(curSize, it.size) * 0.4) {
      base.push(it);
      curSize = Math.max(curSize, it.size);
    } else {
      baselines.push([it]);
      curY = it.y;
      curSize = it.size;
    }
  }
  // 2) split each baseline into segments at large horizontal gaps (a column boundary)
  const lines: Line[] = [];
  for (const base of baselines) {
    base.sort((a, b) => a.x - b.x);
    let seg: RunItem[] = [];
    let segEnd = -Infinity;
    const flush = () => {
      if (!seg.length) return;
      lines.push({
        items: seg,
        y: seg[0]!.y,
        minX: seg[0]!.x,
        maxX: Math.max(...seg.map((i) => i.x + itemWidth(i))),
        size: Math.max(...seg.map((i) => i.size)),
        text: joinItems(seg),
      });
      seg = [];
    };
    for (const it of base) {
      const em = Math.max(it.size, seg[seg.length - 1]?.size ?? it.size);
      if (seg.length && it.x - segEnd > em * COL_GAP_EM) flush();
      seg.push(it);
      segEnd = Math.max(segEnd, it.x + itemWidth(it));
    }
    flush();
  }
  return lines;
}

// Group line segments into paragraph blocks by 2D proximity: a segment joins a block when
// it sits directly below the block's last line (within line spacing, same size) AND overlaps
// it horizontally (or shares its left edge). This keeps side-by-side columns and stacked
// address blocks as distinct, separately-clickable zones instead of one merged box.
interface Block {
  lines: Line[];
  left: number;
  right: number;
  lastY: number;
  lastSize: number;
  bg: RGB | null;
}
export function buildParagraphs(items: RunItem[], bgOf?: (ln: Line) => RGB | null): Line[][] {
  const segs = buildLines(items);
  if (!segs.length) return [];
  // line-spacing estimate from distinct baselines
  const ys = Array.from(new Set(segs.map((s) => Math.round(s.y)))).sort((a, b) => b - a);
  const gaps: number[] = [];
  for (let i = 1; i < ys.length; i++) {
    const g = ys[i - 1]! - ys[i]!;
    if (g > 1) gaps.push(g);
  }
  const medGap = median(gaps);
  const bgMap = bgOf ? new Map<Line, RGB | null>(segs.map((s) => [s, bgOf(s)])) : null;

  const blocks: Block[] = [];
  const ordered = segs.slice().sort((a, b) => b.y - a.y || a.minX - b.minX);
  for (const seg of ordered) {
    const spacing = medGap > 0 ? medGap : seg.size * 1.2;
    const segBg = bgMap?.get(seg) ?? null;
    let best: Block | null = null;
    let bestGap = Infinity;
    for (const b of blocks) {
      const vgap = b.lastY - seg.y;
      if (vgap <= 0 || vgap > spacing * 1.6) continue; // not the immediately following line
      if (Math.abs(b.lastSize - seg.size) > b.lastSize * 0.15) continue; // size change = new block
      // a clear background change separates blocks (e.g. a shaded table header above a row)
      if (segBg && b.bg && colorDist(segBg, b.bg) > 38) continue;
      const overlap = Math.min(seg.maxX, b.right) - Math.max(seg.minX, b.left);
      const minW = Math.min(seg.maxX - seg.minX, b.right - b.left) || 1;
      const aligned = overlap > minW * 0.3 || Math.abs(seg.minX - b.left) <= seg.size;
      if (!aligned) continue;
      // a first-line indent inside an otherwise left-flush block starts a new paragraph
      const leftFlush = b.lines.every((l) => Math.abs(l.minX - b.left) <= seg.size);
      if (leftFlush && seg.minX > b.left + seg.size * 1.2) continue;
      if (vgap < bestGap) {
        best = b;
        bestGap = vgap;
      }
    }
    if (best) {
      best.lines.push(seg);
      best.left = Math.min(best.left, seg.minX);
      best.right = Math.max(best.right, seg.maxX);
      best.lastY = seg.y;
      best.lastSize = seg.size;
    } else {
      blocks.push({ lines: [seg], left: seg.minX, right: seg.maxX, lastY: seg.y, lastSize: seg.size, bg: segBg });
    }
  }
  return blocks.map((b) => b.lines);
}

export function detectAlign(lines: Line[], boxX: number, boxRight: number, pageW: number): Align {
  const avgSize = lines.reduce((a, l) => a + l.size, 0) / lines.length || 12;
  const tol = avgSize * 0.9;
  const sd = (arr: number[]): number => Math.sqrt(variance(arr));
  if (lines.length >= 2) {
    const lsd = sd(lines.map((l) => l.minX));
    const csd = sd(lines.map((l) => (l.minX + l.maxX) / 2));
    // The last line of justified text is ragged, so judge the right edge on the body.
    const bodyLines = lines.length >= 3 ? lines.slice(0, -1) : lines;
    const rsd = sd(bodyLines.map((l) => l.maxX));
    const leftFlush = lsd < tol;
    const rightFlush = rsd < tol;
    if (leftFlush && rightFlush) return "justify";
    if (rightFlush && !leftFlush) return "right";
    if (csd < lsd && csd < rsd) return "center";
    return "left";
  }
  const leftM = boxX;
  const rightM = pageW - boxRight;
  if (leftM > pageW * 0.12 && Math.abs(leftM - rightM) < pageW * 0.08) return "center";
  if (rightM < pageW * 0.1 && leftM > pageW * 0.2) return "right";
  return "left";
}
