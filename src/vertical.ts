import type { RunItem } from "./index";

// --- Vertical (tategaki) support ---------------------------------------------
// Some Japanese PDFs place each glyph individually down a column (shared x, y
// decreasing) with columns running right-to-left, and pdf.js still reports the font
// as non-vertical. Detect that from authoring order, then group by columns instead of
// baselines so each column stays a column. Pure geometry (no pdf.js), so unit-testable.

export interface VCol {
  items: RunItem[]; // top-to-bottom (descending y)
  x: number; // column glyph-origin x (left edge)
  minY: number; // bottom-most baseline
  maxY: number; // top-most baseline
  size: number;
  text: string;
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

// Conservative: only pages of mostly single glyphs that step downward, so normal prose
// (multi-char items) and horizontal CJK are never misclassified as vertical.
export function detectVertical(items: RunItem[]): boolean {
  const pts = items.filter((it) => it.str.trim() !== "");
  if (pts.length < 12) return false;
  const shortFrac = pts.filter((it) => [...it.str.trim()].length <= 2).length / pts.length;
  if (shortFrac < 0.7) return false;
  let vert = 0;
  let horiz = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const s = Math.max(a.size, b.size) || 12;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dy < -s * 0.3 && Math.abs(dx) <= s * 0.6) vert++;
    else if (dx > s * 0.3 && Math.abs(dy) <= s * 0.6) horiz++;
  }
  return vert > horiz * 2 && vert >= pts.length * 0.4;
}

const makeVCol = (seg: RunItem[]): VCol => ({
  items: seg,
  x: Math.min(...seg.map((i) => i.x)),
  minY: Math.min(...seg.map((i) => i.y)),
  maxY: Math.max(...seg.map((i) => i.y)),
  size: Math.max(...seg.map((i) => i.size)),
  text: seg.map((i) => i.str).join(""),
});

// Cluster glyphs into columns by shared x, ordered top-to-bottom, split at a large
// vertical gap (a blank line ends a column-block).
export function buildColumns(items: RunItem[]): VCol[] {
  const pts = items.filter((it) => it.str.trim() !== "").sort((a, b) => a.x - b.x || b.y - a.y);
  const cols: RunItem[][] = [];
  let cur: RunItem[] = [];
  let curX = 0;
  let curSize = 0;
  for (const it of pts) {
    if (cur.length && Math.abs(it.x - curX) <= Math.max(curSize, it.size) * 0.6) {
      cur.push(it);
      curSize = Math.max(curSize, it.size);
    } else {
      if (cur.length) cols.push(cur);
      cur = [it];
      curX = it.x;
      curSize = it.size;
    }
  }
  if (cur.length) cols.push(cur);
  const out: VCol[] = [];
  for (const col of cols) {
    col.sort((a, b) => b.y - a.y);
    let seg: RunItem[] = [];
    let prevY = Infinity;
    let segSize = 0;
    const flush = () => {
      if (seg.length) out.push(makeVCol(seg));
      seg = [];
    };
    for (const it of col) {
      const s = Math.max(it.size, segSize || it.size);
      if (seg.length && prevY - it.y > s * 2.2) flush();
      seg.push(it);
      prevY = it.y;
      segSize = Math.max(segSize, it.size);
    }
    flush();
  }
  return out;
}

// Tategaki export layout (pure geometry, unit-tested): place each character down a
// column (y decreasing by the run's glyph size), columns marching right-to-left by
// `pitch`. A run's brAfter starts a new column; a column overflowing `bottom` wraps to
// the next one left. Whitespace advances without emitting a glyph. Returns a glyph with
// its run index (so the caller resolves the font) and PDF-space (x, y).
export interface VLayoutRun {
  text: string;
  size: number;
  brAfter?: boolean;
}
export interface VGlyph {
  runIndex: number;
  ch: string;
  x: number;
  y: number;
}
export function layoutVerticalGlyphs(runs: VLayoutRun[], p: { startX: number; topY: number; pitch: number; bottom: number }): VGlyph[] {
  const out: VGlyph[] = [];
  let col = 0;
  let x = p.startX;
  let y = p.topY;
  let colCount = 0; // glyphs placed in the current column
  const nextCol = () => {
    col++;
    x = p.startX - col * p.pitch;
    y = p.topY;
    colCount = 0;
  };
  runs.forEach((run, ri) => {
    for (const ch of [...run.text]) {
      if (/\s/.test(ch)) {
        y -= run.size; // blank advance keeps alignment
        colCount++;
        continue;
      }
      if (colCount > 0 && y < p.bottom) nextCol(); // overflow wraps to the next column left
      out.push({ runIndex: ri, ch, x, y });
      y -= run.size;
      colCount++;
    }
    if (run.brAfter) nextCol();
  });
  return out;
}

// Group adjacent columns (right-to-left) that share size and vertical extent into one
// editable block, so a multi-column paragraph edits and reflows together.
export function buildVerticalBlocks(items: RunItem[]): VCol[][] {
  const cols = buildColumns(items).sort((a, b) => b.x - a.x);
  if (!cols.length) return [];
  const pitches: number[] = [];
  for (let i = 1; i < cols.length; i++) {
    const d = cols[i - 1]!.x - cols[i]!.x;
    if (d > 1) pitches.push(d);
  }
  const medPitch = median(pitches) || cols[0]!.size * 1.6;
  const blocks: VCol[][] = [];
  for (const c of cols) {
    let best: VCol[] | null = null;
    let bestGap = Infinity;
    for (const b of blocks) {
      const last = b[b.length - 1]!;
      const gap = last.x - c.x; // c sits to the left of the block's last column
      if (gap <= 0 || gap > medPitch * 1.6) continue;
      if (Math.abs(last.size - c.size) > last.size * 0.15) continue;
      const overlap = Math.min(last.maxY, c.maxY) - Math.max(last.minY, c.minY);
      const minH = Math.min(last.maxY - last.minY, c.maxY - c.minY) || 1;
      if (overlap < minH * 0.3 && Math.abs(last.maxY - c.maxY) > c.size) continue;
      if (gap < bestGap) {
        best = b;
        bestGap = gap;
      }
    }
    if (best) best.push(c);
    else blocks.push([c]);
  }
  return blocks;
}
