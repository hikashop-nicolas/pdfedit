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
      // Split only on a large vertical gap (a genuine break / separate region); a smaller gap
      // is kept so an embedded horizontal number (e.g. a year) that leaves a few glyph-heights
      // of space does not chop the sentence into separate columns.
      if (seg.length && prevY - it.y > s * 5) flush();
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

// Group adjacent columns (right-to-left) into blocks by column spacing, using look-ahead so
// paragraph structure survives. A column starts a new block when its incoming gap is a
// "separator": notably wider than the tighter of its neighbouring gaps (so a column that
// begins a more tightly-spaced run, i.e. a paragraph, is not absorbed into the wider-spaced
// group before it), or when size/vertical-extent changes. Each block then renders at its own
// spacing, and a wrapped paragraph keeps its continuation columns.
export function buildVerticalBlocks(items: RunItem[]): VCol[][] {
  const cols = buildColumns(items).sort((a, b) => b.x - a.x);
  if (!cols.length) return [];
  const gapAt = (i: number): number => cols[i - 1]!.x - cols[i]!.x; // gap before cols[i]
  const blocks: VCol[][] = [];
  let cur: VCol[] = [cols[0]!];
  for (let i = 1; i < cols.length; i++) {
    const c = cols[i]!;
    const prev = cols[i - 1]!;
    const gIn = gapAt(i);
    // The local rhythm is the tighter neighbouring gap (ignoring degenerate same-x gaps).
    const valid = (g: number): number => (g > c.size * 0.4 ? g : Infinity);
    const gPrev = i >= 2 ? valid(gapAt(i - 1)) : Infinity;
    const gNext = i <= cols.length - 2 ? valid(gapAt(i + 1)) : Infinity;
    const localTight = Math.min(gPrev, gNext);
    const sameSize = Math.abs(prev.size - c.size) <= prev.size * 0.15;
    const overlap = Math.min(prev.maxY, c.maxY) - Math.max(prev.minY, c.minY);
    const minH = Math.min(prev.maxY - prev.minY, c.maxY - c.minY) || 1;
    const yOk = overlap > minH * 0.3 || Math.abs(prev.maxY - c.maxY) <= c.size;
    const separator = gIn <= c.size * 0.4 || gIn > localTight * 1.3;
    if (!sameSize || !yOk || separator) {
      blocks.push(cur);
      cur = [c];
    } else {
      cur.push(c);
    }
  }
  blocks.push(cur);
  return blocks;
}
