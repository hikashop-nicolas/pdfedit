// Export line layout: wrap a paragraph's tokens into lines and compute each line's start x
// and inter-word stretch for the paragraph alignment. Pure geometry over token widths, split
// from the pdf-lib drawing in index.ts so the wrapping and justify/center/right maths is
// unit-testable.
import type { Align } from "./reflow";

// The layout only needs each token's advance width and whether it is whitespace.
export interface WrapTok {
  w: number;
  space: boolean;
}

// Greedy word wrap: break before a non-space token that would overflow maxWidth, and at each
// forced break index (a <br> / block boundary). Trailing spaces are trimmed off each line and
// a leading space at the start of a line is dropped.
export function wrapTokens<T extends WrapTok>(toks: T[], lineBreaks: number[], maxWidth: number): T[][] {
  const breaks = new Set(lineBreaks);
  const lines: T[][] = [];
  let cur: T[] = [];
  let curW = 0;
  const flush = () => {
    while (cur.length && cur[cur.length - 1]!.space) cur.pop();
    lines.push(cur);
    cur = [];
    curW = 0;
  };
  toks.forEach((t, i) => {
    if (breaks.has(i)) flush();
    if (!t.space && cur.length && curW + t.w > maxWidth) flush();
    if (t.space && cur.length === 0) return;
    cur.push(t);
    curW += t.w;
  });
  if (cur.length) flush();
  return lines;
}

// The x the line's first token starts at, plus the extra width to add per whitespace token.
// center/right shift the whole line; justify spreads the slack across spaces (but never the
// last line of a paragraph, which stays left-flush).
export function layoutLine(line: WrapTok[], align: Align, boxX: number, boxW: number, isLast: boolean): { x: number; spaceExtra: number } {
  const lineW = line.reduce((a, t) => a + t.w, 0);
  let x = boxX;
  let spaceExtra = 0;
  if (align === "center") x = boxX + (boxW - lineW) / 2;
  else if (align === "right") x = boxX + boxW - lineW;
  else if (align === "justify" && !isLast) {
    const nSpaces = line.filter((t) => t.space).length;
    if (nSpaces > 0 && boxW > lineW) spaceExtra = (boxW - lineW) / nSpaces;
  }
  return { x, spaceExtra };
}
