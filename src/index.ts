import * as pdfjsLib from "pdfjs-dist";
import fontkit from "@pdf-lib/fontkit";
import {
  beginText,
  endText,
  PDFArray,
  PDFDocument,
  type PDFFont,
  PDFHexString,
  PDFName,
  type PDFPage,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  setFillingRgbColor,
  setFontAndSize,
  setTextMatrix,
  showText,
  StandardFonts,
  rgb,
} from "pdf-lib";
import { type PlacedGlyph } from "./content-stream";
import { type Anchor, planEditedBlock } from "./glyph-edit";
import { pageGlyphs } from "./pdf-glyphs";
import { detectVertical, buildVerticalBlocks, layoutVerticalGlyphs, type VCol } from "./vertical";
import { t } from "./i18n";

// pdfedit: a standalone, framework-agnostic PDF editor.
//
// Renders pages with pdf.js, reconstructs paragraphs from text runs, and overlays one
// rich-text editable block per paragraph plus a toolbar. The original styling (per-run
// bold/italic/family/size/color) is reproduced in the editable block, so editing keeps
// it. On export, pdf-lib repaints each edited paragraph and re-lays-out its styled runs,
// wrapping with the detected alignment (left/center/right/justify), adds link
// annotations, and draws inserted images.
//
// Limits (honest): paragraph reconstruction is heuristic (columns/tables/tight lists
// may group imperfectly); styled/new text uses standard font families (Helvetica/
// Times/Courier) so it won't always match a custom embedded typeface; scanned PDFs
// have no text to edit.

export interface PdfEditorOptions {
  workerSrc?: string;
  scale?: number;
  onChange?: () => void;
  /** Restore a prior editing session (from getState). Applied after the pages render. */
  initialState?: PdfEditState;
}
export interface PdfEditor {
  getBytes(): Promise<Uint8Array>;
  isDirty(): boolean;
  /** A serialisable snapshot of the editing session: the pristine bytes plus the edits made
   *  on top. Restoring re-renders the original and replays the edits (lossless, unlike
   *  re-opening an exported PDF), which is what a version-history tool should snapshot. */
  getState(): PdfEditState;
  destroy(): void;
}

/** One edited existing paragraph: its index among the rendered (non-added) paragraphs. */
export interface PdfParagraphEdit {
  page: number;
  index: number;
  html: string;
}
/** A text box the user added in blank space. */
export interface PdfBoxState {
  page: number;
  xPdf: number;
  yPdf: number;
  wPdf: number;
  size: number;
  align: "left" | "center" | "right" | "justify";
  family: "sans" | "serif" | "mono";
  colorHex: string;
  html: string;
}
/** An inserted image, with its viewport-space placement (render scale is constant per doc). */
export interface PdfImageState {
  page: number;
  bytes: Uint8Array;
  mime: string;
  leftPx: number;
  topPx: number;
  widthPx: number;
}
export interface PdfEditState {
  /** The pristine bytes the document was opened with (re-render base). */
  original: Uint8Array;
  edits: PdfParagraphEdit[];
  boxes: PdfBoxState[];
  images: PdfImageState[];
}

type Family = "sans" | "serif" | "mono";
type Align = "left" | "center" | "right" | "justify";
interface RGB {
  r: number;
  g: number;
  b: number;
}
interface FontRec {
  bold: boolean;
  italic: boolean;
  family: Family;
  baseName: string; // font name without the "ABCDEF+" subset prefix, for sibling lookup
  isType3: boolean; // Type3 fonts draw glyphs procedurally; visible but no reusable program
  data?: Uint8Array; // original embedded font program (pdf.js, sanitized to OpenType)
  cssName?: string; // @font-face family name registered for the overlay
  synthBold?: boolean; // renders heavier than a same-name sibling; emulate bold on export
  inkSum?: number; // accumulated glyph ink coverage (for bold-by-density detection)
  inkN?: number;
}
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
interface Line {
  items: RunItem[];
  y: number;
  minX: number;
  maxX: number;
  size: number;
  text: string;
}
interface Paragraph {
  page: number;
  x: number;
  w: number;
  topY: number;
  bottomY: number;
  firstBaseline: number;
  lineHeight: number;
  size: number;
  align: Align;
  family: Family;
  baseFontKey: string; // dominant font of the paragraph, for stray/newly-typed text
  color: RGB; // 0..1
  bg: RGB; // 0..1
  origText: string;
  dirty: boolean;
  el: HTMLDivElement;
  viewport: pdfjsLib.PageViewport;
  /** Block text captured at render, aligned 1:1 with `anchors` (for glyph-preserving export). */
  anchorText: string;
  anchors: (Anchor | null)[];
  /** Re-emit original glyphs on export (set when the block uses fonts with no usable Unicode). */
  glyphPreserve: boolean;
  /** Added by the user in blank space (no original content to cover / preserve). */
  isNew?: boolean;
  /** Tategaki block: glyphs flow top-to-bottom, columns right-to-left. */
  vertical?: boolean;
  vStartX?: number; // rightmost column's glyph-origin x (draw start)
  vTopY?: number; // top baseline (draw start y for each column)
  vPitch?: number; // column spacing (positive px, right-to-left)
  vBottomY?: number; // bottom baseline limit (wrap a column past it)
}
interface ImageItem {
  page: number;
  bytes: Uint8Array;
  mime: string;
  xPdf: number;
  yPdf: number; // bottom-left, y-up
  wPdf: number;
  hPdf: number;
  el: HTMLElement;
}
/** A styled text run parsed from a paragraph block on export. */
interface StyledRun {
  text: string;
  bold: boolean;
  italic: boolean;
  family: Family;
  size: number; // pt
  color: RGB; // 0..1
  href?: string;
  brAfter?: boolean;
  fontKey?: string; // original font identity, for embedded-font reuse on export
}

const ICON = {
  left: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 3.5h12M2 6.8h8M2 10.1h11M2 13.4h6"/></svg>`,
  center: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 3.5h12M4 6.8h8M3 10.1h10M5 13.4h6"/></svg>`,
  right: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 3.5h12M6 6.8h8M3 10.1h11M8 13.4h6"/></svg>`,
  justify: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 3.5h12M2 6.8h12M2 10.1h12M2 13.4h6"/></svg>`,
};

const STYLE_ID = "pdfedit-style";
function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    .pdfedit-wrap { display:flex; flex-direction:column; height:100%; }
    .pdfedit-live { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0 0 0 0); border:0; }
    .pdfedit-toolbar {
      display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:6px 10px;
      background:#2b2f36; border-bottom:1px solid #1c1f24; color:#e6e6e6;
      font:13px system-ui, sans-serif;
    }
    .pdfedit-toolbar button, .pdfedit-toolbar select, .pdfedit-toolbar input[type=number] {
      font:inherit; background:#3a3f47; color:#e6e6e6; border:1px solid #4a4f57;
      border-radius:5px; padding:3px 8px; cursor:pointer; height:28px; box-sizing:border-box;
    }
    .pdfedit-toolbar button { display:inline-flex; align-items:center; justify-content:center; min-width:30px; }
    .pdfedit-toolbar button:hover, .pdfedit-toolbar select:hover { border-color:#6e7bff; }
    .pdfedit-toolbar input[type=number] {
      width:56px; cursor:text; -moz-appearance:textfield; color:#ffffff; background:#1f232a;
    }
    .pdfedit-toolbar input[type=color] {
      width:30px; height:28px; padding:2px; background:#3a3f47; border:1px solid #4a4f57;
      border-radius:5px; cursor:pointer;
    }
    .pdfedit-toolbar .sep { width:1px; align-self:stretch; background:#4a4f57; margin:0 2px; }
    .pdfedit-toolbar .pdfedit-zoom { display:inline-flex; align-items:center; gap:6px; }
    .pdfedit-toolbar input[type=range] { width:110px; cursor:pointer; accent-color:#6e7bff; }
    .pdfedit-root {
      flex:1; min-height:0; overflow:auto; box-sizing:border-box;
      /* "safe center" keeps pages centred when they fit but falls back to start when a
         zoomed page is wider than the viewport, so its left edge stays scrollable. */
      display:flex; flex-direction:column; align-items:safe center; gap:16px; padding:16px; background:#525659;
    }
    .pdfedit-page { position:relative; background:#fff; box-shadow:0 2px 10px rgba(0,0,0,.45); }
    .pdfedit-page canvas { display:block; }
    .pdfedit-para {
      position:absolute; box-sizing:border-box; cursor:text; outline:none;
      color:var(--c,#000); opacity:0; white-space:pre-wrap; word-break:break-word; overflow:visible;
    }
    .pdfedit-para:focus, .pdfedit-para.pdfedit-edited, .pdfedit-para.pdfedit-active { opacity:1; background:var(--bg,#fff); }
    .pdfedit-para:focus, .pdfedit-para.pdfedit-active { box-shadow:0 0 0 2px #6e7bff; }
    /* Selection stays visible even when focus moves to a toolbar control. */
    ::highlight(pdfedit-sel) { background-color:rgba(110,123,255,.4); }
    .pdfedit-img { position:absolute; cursor:move; outline:1px dashed rgba(110,123,255,.9); }
    .pdfedit-img img { display:block; width:100%; height:auto; pointer-events:none; }
    .pdfedit-img-handle {
      position:absolute; right:-7px; bottom:-7px; width:14px; height:14px; box-sizing:border-box;
      background:#6e7bff; border:2px solid #fff; border-radius:3px; cursor:nwse-resize;
    }
    .pdfedit-img-del {
      position:absolute; right:-9px; top:-9px; width:18px; height:18px; box-sizing:border-box;
      padding:0; background:#e4484f; color:#fff; border:2px solid #fff; border-radius:50%; cursor:pointer;
      font:700 12px/14px system-ui, sans-serif; text-align:center;
    }
    .pdfedit-img:focus-visible { outline:2px solid #6e7bff; outline-offset:2px; }
    .pdfedit-toolbar button:focus-visible, .pdfedit-toolbar select:focus-visible,
    .pdfedit-toolbar input:focus-visible, .pdfedit-img-del:focus-visible {
      outline:2px solid #fff; outline-offset:1px;
    }
  `;
  document.head.appendChild(s);
}

// Order matters: check mono and sans before serif, because the CSS keyword
// "sans-serif" contains "serif" and would otherwise be misread as a serif font.
const familyOf = (n: string): Family =>
  /courier|mono|consol|menlo/i.test(n)
    ? "mono"
    : /sans|arial|helvetica|verdana|tahoma|segoe|calibri|roboto|system-ui|-apple-system/i.test(n)
      ? "sans"
      : /times|georgia|serif|roman|minion|garamond|cambria|century|palatino|bookman|schoolbook|baskerville|caslon|didot|book antiqua/i.test(n)
        ? "serif"
        : "sans";
const cssFamily = (f: Family): string =>
  f === "serif" ? "Times New Roman, serif" : f === "mono" ? "monospace" : "Helvetica, Arial, sans-serif";

function standardFont(f: Family, bold: boolean, italic: boolean): StandardFonts {
  if (f === "serif")
    return bold && italic ? StandardFonts.TimesRomanBoldItalic : bold ? StandardFonts.TimesRomanBold : italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman;
  if (f === "mono")
    return bold && italic ? StandardFonts.CourierBoldOblique : bold ? StandardFonts.CourierBold : italic ? StandardFonts.CourierOblique : StandardFonts.Courier;
  return bold && italic ? StandardFonts.HelveticaBoldOblique : bold ? StandardFonts.HelveticaBold : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
}

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
const hex2 = (n: number): string => clamp255(n).toString(16).padStart(2, "0");
const rgb255ToHex = (c: RGB): string => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Symbol-flagged subset fonts with no ToUnicode CMap map each byte c to glyph U+F000+c
// (the (3,0) "symbol" cmap convention). pdf.js returns those Private Use Area code points
// verbatim, so the editable overlay renders them as tofu (squares). Map the F0xx range
// back to its low byte to recover readable text (e.g. U+F04D -> "M").
const normalizePua = (s: string): string => {
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
const toPua = (s: string): string => {
  let out = "";
  for (const ch of s) {
    const cp = ch.charCodeAt(0);
    out += cp >= 0x20 && cp <= 0xff ? String.fromCharCode(0xf000 + cp) : ch;
  }
  return out;
};

// Plausible advance width of a text item. Some subset fonts report garbage widths (many
// times the page width); fall back to an estimate so one bad item can't distort layout.
const itemWidth = (it: RunItem): number => {
  const plausible = it.str.length * it.size * 1.5 + it.size;
  return it.w > 0 && it.w <= plausible ? it.w : it.str.length * it.size * 0.5;
};

// Whether to insert a space between two items: a positional gap (adjacent label/value with
// no space char), or a strong overlap (distinct text pieces laid over each other), but not
// when whitespace already borders the seam.
const wantSpace = (gap: number, size: number, before: string, next: string): boolean =>
  (gap > size * 0.2 || gap < -size * 0.5) && before !== "" && !/\s$/.test(before) && !/^\s/.test(next);

// Join items on one line, inserting spaces per wantSpace (PDFs often emit adjacent runs,
// e.g. a label and a value, with no space char between them).
const joinItems = (items: RunItem[]): string => {
  let text = "";
  let prevEnd = -Infinity;
  for (const it of items) {
    if (prevEnd > -Infinity && wantSpace(it.x - prevEnd, it.size, text, it.str)) text += " ";
    text += it.str;
    prevEnd = it.x + itemWidth(it);
  }
  return text;
};

const colorDist = (a: RGB, b: RGB): number => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

// Block-level tags a contenteditable can wrap a new line in (Chrome's Enter inserts <div>),
// each of which starts a new visual line just like a <br>.
const BLOCK_TAGS = new Set(["DIV", "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "SECTION", "ARTICLE", "UL", "OL", "PRE"]);

// Current text of an edited block, with a "\n" for each <br> and before each block element
// (matches how anchorText was captured at render), for diffing against the original on export.
const blockText = (el: HTMLElement): string => {
  let out = "";
  const walk = (node: Node): void => {
    for (const ch of Array.from(node.childNodes)) {
      if (ch.nodeType === 3) out += ch.textContent ?? "";
      else if (ch.nodeName === "BR") out += "\n";
      else if (ch.nodeType === 1) {
        if (BLOCK_TAGS.has((ch as Element).tagName) && out !== "" && !out.endsWith("\n")) out += "\n";
        walk(ch);
      }
    }
  };
  walk(el);
  return out;
};

// Persist the zoom level (a UI preference) across documents/sessions. Guarded so it is a
// no-op where localStorage is unavailable (privacy mode / non-browser).
const ZOOM_KEY = "pdfedit:zoom";
const loadZoomPct = (): number => {
  try {
    const v = Number(localStorage.getItem(ZOOM_KEY));
    if (Number.isFinite(v) && v >= 25 && v <= 400) return v;
  } catch {
    /* ignore */
  }
  return 100;
};
const saveZoomPct = (pct: number): void => {
  try {
    localStorage.setItem(ZOOM_KEY, String(pct));
  } catch {
    /* ignore */
  }
};

let colorProbe: HTMLDivElement | null = null;
function cssColorToRgb(str: string, fallback: RGB): RGB {
  if (!str) return fallback;
  if (!colorProbe) {
    colorProbe = document.createElement("div");
    colorProbe.style.display = "none";
    document.body.appendChild(colorProbe);
  }
  colorProbe.style.color = "";
  colorProbe.style.color = str;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(colorProbe).color);
  if (!m) return fallback;
  return { r: Number(m[1]) / 255, g: Number(m[2]) / 255, b: Number(m[3]) / 255 };
}

function sampleColors(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): { fg: RGB; bg: RGB; ink: number } {
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
function sampleRunStats(ctx: CanvasRenderingContext2D, viewport: pdfjsLib.PageViewport, x: number, baseY: number, w: number, size: number): { fg: RGB; ink: number } {
  const tl = viewport.convertToViewportPoint(x, baseY + size * 0.85);
  const br = viewport.convertToViewportPoint(x + w, baseY - size * 0.2);
  const left = Math.min(tl[0]!, br[0]!);
  const top = Math.min(tl[1]!, br[1]!);
  const dW = Math.abs(br[0]! - tl[0]!);
  const dH = Math.abs(br[1]! - tl[1]!);
  const s = sampleColors(ctx, left, top, Math.max(dW, 2), Math.max(dH, 2));
  return { fg: s.fg, ink: s.ink };
}

// Replace characters the standard fonts can't encode so drawText never throws (which
// would leave an empty cover box). WinAnsi covers Latin-1 + cp1252 punctuation; map the
// few common typographic glyphs and drop anything else outside that range.
function sanitizeStd(s: string): string {
  return s
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[   ]/g, " ")
    .replace(/[•]/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[^ -ÿ€ŒœŽžŠšŸ]/g, "");
}

const norm = (c: RGB): RGB => ({ r: c.r / 255, g: c.g / 255, b: c.b / 255 });
const variance = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
};
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

// A large horizontal gap between items sharing a baseline marks a column / block boundary
// (e.g. a left-aligned footer and a right-aligned page number sit on the same baseline but
// are separate blocks). Gaps wider than this many ems split a baseline into segments.
const COL_GAP_EM = 2.2;

function buildLines(items: RunItem[]): Line[] {
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
function buildParagraphs(items: RunItem[], bgOf?: (ln: Line) => RGB | null): Line[][] {
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

function detectAlign(lines: Line[], boxX: number, boxRight: number, pageW: number): Align {
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

/** Parse a paragraph block's rich HTML into styled runs (sizes in pt). */
function parseRuns(el: HTMLElement, base: { bold: boolean; italic: boolean; family: Family; size: number; color: RGB; fontKey?: string }, scale: number): StyledRun[] {
  const runs: StyledRun[] = [];
  const walk = (node: Node, st: typeof base & { href?: string }): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? "";
        if (text) runs.push({ ...st, text });
      } else if (child instanceof HTMLBRElement) {
        const last = runs[runs.length - 1];
        if (last) last.brAfter = true;
        else runs.push({ ...st, text: "", brAfter: true });
      } else if (child instanceof HTMLElement) {
        const next = { ...st };
        const tag = child.tagName;
        // A block element (e.g. Chrome's Enter <div>) starts a new line, like a <br>.
        if (BLOCK_TAGS.has(tag)) {
          const last = runs[runs.length - 1];
          if (last && !last.brAfter) last.brAfter = true;
        }
        if (child.dataset.font) next.fontKey = child.dataset.font;
        if (tag === "B" || tag === "STRONG") next.bold = true;
        if (tag === "I" || tag === "EM") next.italic = true;
        if (tag === "A") next.href = (child as HTMLAnchorElement).getAttribute("href") ?? st.href;
        const fw = child.style.fontWeight;
        if (fw === "bold" || Number(fw) >= 600) next.bold = true;
        else if (fw === "normal" || (fw && Number(fw) > 0 && Number(fw) < 600)) next.bold = false;
        if (child.style.fontStyle === "italic") next.italic = true;
        else if (child.style.fontStyle === "normal") next.italic = false;
        if (child.style.fontFamily) next.family = familyOf(child.style.fontFamily);
        if (child.style.color) next.color = cssColorToRgb(child.style.color, st.color);
        const fsAttr = child.getAttribute("color");
        if (tag === "FONT" && fsAttr) next.color = cssColorToRgb(fsAttr, st.color);
        const fs = child.style.fontSize;
        if (fs.endsWith("px")) next.size = parseFloat(fs) / scale;
        else if (fs.endsWith("pt")) next.size = parseFloat(fs);
        walk(child, next);
      }
    }
  };
  walk(el, { ...base });
  return runs;
}

interface Tok {
  text: string;
  run: StyledRun;
  font: PDFFont;
  w: number;
  space: boolean;
  faux: boolean; // emulate bold by double-striking (no real bold font available)
}

let instanceSeq = 0;

export function createPdfEditor(container: HTMLElement, bytes: Uint8Array, options: PdfEditorOptions = {}): PdfEditor {
  if (options.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = options.workerSrc;
  const scale = options.scale ?? 1.3;
  const original = bytes.slice();
  const paragraphs: Paragraph[] = [];
  const images: ImageItem[] = [];
  // Off-screen aria-live region for status announcements (e.g. zoom level).
  const live = document.createElement("div");
  live.className = "pdfedit-live";
  live.setAttribute("aria-live", "polite");
  const pageEls: { el: HTMLElement; viewport: pdfjsLib.PageViewport; index: number }[] = [];
  let displayZoom = loadZoomPct() / 100; // visual zoom only (persisted); render scale + PDF coords unchanged
  const applyZoom = (z: number) => {
    // Anchor the page under the viewport centre so it stays put across the zoom change;
    // otherwise scrollTop is a fixed number while page heights change and the view jumps
    // to a neighbouring page. getBoundingClientRect gives real screen px, robust to CSS
    // zoom (which makes offsetTop/offsetHeight unreliable) and to the fixed inter-page gaps.
    const rootRect = root.getBoundingClientRect();
    const cy = rootRect.top + root.clientHeight / 2;
    const cx = rootRect.left + root.clientWidth / 2;
    let anchor: HTMLElement | null = null;
    let fy = 0;
    let fx = 0;
    for (let i = 0; i < pageEls.length; i++) {
      const r = pageEls[i].el.getBoundingClientRect();
      if (cy < r.bottom || i === pageEls.length - 1) {
        anchor = pageEls[i].el;
        fy = r.height ? (cy - r.top) / r.height : 0;
        fx = r.width ? (cx - r.left) / r.width : 0;
        break;
      }
    }
    displayZoom = z;
    for (const p of pageEls) p.el.style.zoom = String(z);
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      root.scrollTop += r.top + fy * r.height - cy;
      root.scrollLeft += r.left + fx * r.width - cx;
    }
  };
  let destroyed = false;
  let activePara: Paragraph | null = null;
  let savedPara: Paragraph | null = null;
  let savedRange: Range | null = null;
  const change = () => options.onChange?.();
  const touch = () => {
    if (activePara) {
      activePara.dirty = true;
      activePara.el.classList.add("pdfedit-edited");
    }
    change();
  };

  // Per-instance font registry: bold/italic/family plus the original embedded font
  // program (reused on export) and an @font-face name (so the overlay shows the real
  // font while editing). Keyed by pdf.js loadedName (unique per font in the document).
  const uid = (instanceSeq++).toString(36);
  const fontRecs = new Map<string, FontRec>();
  const puaFonts = new Set<string>(); // fonts whose text was Private-Use-Area encoded (symbol cmap)
  const faces = new Map<string, FontFace>();
  // For fonts whose cmap is unusable in HTML: displayed char -> original glyph id, per pdf.js
  // font, used to build a display-only @font-face that shows the true glyph shapes.
  const displayFontChars = new Map<string, Map<string, number>>();
  const displayFamilies = new Map<string, string>();
  const displayCharByGid = new Map<string, string>();
  let displayCharCounter = 0;
  // A unique BMP Private-Use char (0xE000+) per font+glyph, used as the overlay placeholder
  // for an unreliable glyph so the display font can map it to the real outline without
  // colliding with real text (BMP keeps it one code unit, so anchor alignment holds).
  const displayCharFor = (fontName: string, gid: number): string => {
    const k = `${fontName}:${gid}`;
    let ch = displayCharByGid.get(k);
    if (!ch) {
      ch = String.fromCharCode(0xe000 + (displayCharCounter++ % 0x1000));
      displayCharByGid.set(k, ch);
    }
    return ch;
  };
  const registerFace = (key: string, data: Uint8Array): string | undefined => {
    const name = `pf_${uid}_${key.replace(/[^a-zA-Z0-9_]/g, "")}`;
    if (faces.has(name)) return name;
    try {
      const ff = new FontFace(name, data.slice() as unknown as ArrayBuffer);
      faces.set(name, ff);
      document.fonts.add(ff);
      ff.load().catch(() => {
        /* font format the browser can't load; the overlay falls back to the CSS family */
      });
      return name;
    } catch {
      return undefined;
    }
  };
  const getFontRec = (page: pdfjsLib.PDFPageProxy, fontName: string): FontRec => {
    const hit = fontRecs.get(fontName);
    if (hit) return hit;
    let bold = false;
    let italic = false;
    let family: Family = "sans";
    let baseName = "";
    let isType3 = false;
    let data: Uint8Array | undefined;
    let cssName: string | undefined;
    try {
      if (page.commonObjs.has(fontName)) {
        const f = page.commonObjs.get(fontName) as {
          name?: string;
          type?: string;
          bold?: boolean;
          italic?: boolean;
          black?: boolean;
          data?: Uint8Array | ArrayBuffer;
          isSerifFont?: boolean;
          isMonospace?: boolean;
        };
        const nm = String(f?.name ?? "");
        baseName = nm.replace(/^[A-Z]{6}\+/, "");
        isType3 = f?.type === "Type3";
        // Prefer pdf.js's own flags (from the font's OS/2 / descriptor), which work even
        // when a subset font name omits "Bold"/"Italic"; fall back to the name.
        bold = f?.bold === true || f?.black === true || /bold|black|semibold|heavy/i.test(nm);
        italic = f?.italic === true || /italic|oblique/i.test(nm);
        family = familyOf(nm);
        // Subset names like "CIDFont+F2" carry no family hint; trust the descriptor flags so
        // a substitute (when the embedded program can't be reused) matches serif vs sans.
        const hasSansHint = /sans|arial|helvetica|verdana|tahoma|segoe|calibri|roboto|system-ui|-apple-system/i.test(nm);
        if (family === "sans" && !hasSansHint) {
          family = f?.isMonospace ? "mono" : f?.isSerifFont ? "serif" : "sans";
        }
        if (f?.data) {
          const d = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
          if (d.length) {
            data = d;
            cssName = registerFace(fontName, d);
            // pdf.js omits weight/style for CID subsets; read them from the font program's
            // OS/2 / head tables (reliable) so bold and italic survive editing.
            try {
              const ft = (fontkit as { create(b: Uint8Array): unknown }).create(d) as {
                ["OS/2"]?: { usWeightClass?: number };
                head?: { macStyle?: { bold?: boolean; italic?: boolean } };
              };
              const weight = ft["OS/2"]?.usWeightClass;
              const mac = ft.head?.macStyle;
              if ((typeof weight === "number" && weight >= 600) || mac?.bold) bold = true;
              if (mac?.italic) italic = true;
            } catch {
              /* not a parseable sfnt; keep name/flag-based detection */
            }
          }
        }
      }
    } catch {
      /* defaults */
    }
    const rec: FontRec = { bold, italic, family, baseName, isType3, data, cssName };
    fontRecs.set(fontName, rec);
    return rec;
  };
  // A font with no reusable program (e.g. a Type3 font) can borrow a sibling with the
  // same base name that does have one. Returns [loadedName, rec] of the donor.
  const findDonor = (baseName: string, has: (r: FontRec) => boolean): [string, FontRec] | undefined => {
    if (!baseName) return undefined;
    for (const [k, r] of fontRecs) if (r.baseName === baseName && has(r)) return [k, r];
    return undefined;
  };
  // Detect "rendered-bolder" fonts: a font whose glyph ink coverage is notably higher
  // than a same-base-name sibling is an emphasized/bold variant even when its name and
  // flags say regular (e.g. a Type3 heading vs the CID body, same "CenturyStd-Book").
  const detectSynthBold = () => {
    const dens = new Map<string, number>();
    for (const [k, rec] of fontRecs) if (rec.inkN) dens.set(k, rec.inkSum! / rec.inkN);
    const baseMin = new Map<string, number>();
    for (const [k, rec] of fontRecs) {
      const d = dens.get(k);
      if (d == null) continue;
      const b = rec.baseName || k;
      if (!baseMin.has(b) || d < baseMin.get(b)!) baseMin.set(b, d);
    }
    for (const [k, rec] of fontRecs) {
      const d = dens.get(k);
      if (d == null || rec.bold) continue;
      const min = baseMin.get(rec.baseName || k);
      if (min != null && min > 0 && d > min * 1.18) rec.synthBold = true;
    }
  };
  // After load: spans whose font has no @font-face borrow a sibling's (so the real font
  // shows while editing, e.g. a Type3 font borrowing its CID twin), and synthBold spans
  // get a bold weight so the emphasis is visible and preserved on export.
  const faceFor = (rec: FontRec): string | undefined => {
    if (rec.cssName) return rec.cssName;
    const donor = rec.baseName ? findDonor(rec.baseName, (r) => !!r.cssName) : undefined;
    return donor?.[1].cssName;
  };
  const upgradeOverlayFonts = () => {
    detectSynthBold();
    for (const para of paragraphs) {
      // Block element (covers stray / newly-typed text) gets the dominant font's face.
      const baseRec = fontRecs.get(para.baseFontKey);
      const baseFace = baseRec ? faceFor(baseRec) : undefined;
      if (baseFace) para.el.style.fontFamily = `'${baseFace}', ${para.el.style.fontFamily}`;
      para.el.querySelectorAll<HTMLElement>("span[data-font]").forEach((span) => {
        const key = span.dataset.font;
        const rec = key ? fontRecs.get(key) : undefined;
        if (!rec) return;
        if (!rec.cssName && rec.baseName) {
          const donor = findDonor(rec.baseName, (r) => !!r.cssName);
          if (donor) span.style.fontFamily = `'${donor[1].cssName}', ${span.style.fontFamily}`;
        }
        if (rec.synthBold) {
          // Keep font-weight:bold as the export signal (parseRuns reads it), but render the
          // bold via a text-shadow double-strike instead of the browser's synthetic bold,
          // which some browsers/fonts don't apply to a regular-only @font-face. This also
          // matches how export emulates the weight.
          span.style.fontWeight = "bold";
          span.style.fontSynthesis = "none";
          span.style.textShadow = "0.35px 0 0 currentColor";
        }
      });
    }
  };
  // Build a display-only @font-face per unreliable font from its real glyph outlines, and
  // apply it so the overlay shows the true shapes (e.g. "Śląski") instead of mojibake. The
  // saved file is unaffected (it re-emits the original glyphs); this is purely visual.
  const applyDisplayFonts = async (): Promise<void> => {
    if (!displayFontChars.size) return;
    let mod: typeof import("./display-font");
    try {
      mod = await import("./display-font");
    } catch {
      return;
    }
    for (const [fontName, cmap] of displayFontChars) {
      const rec = fontRecs.get(fontName);
      if (!rec?.data || !cmap.size) continue;
      const family = `pdfedit_disp_${uid}_${fontName.replace(/[^a-zA-Z0-9_]/g, "")}`;
      let buf: ArrayBuffer | null = null;
      try {
        buf = mod.buildDisplayFont(rec.data, cmap, family);
      } catch {
        buf = null;
      }
      if (!buf) continue;
      try {
        const ff = new FontFace(family, buf);
        faces.set(family, ff);
        document.fonts.add(ff);
        await ff.load();
        displayFamilies.set(fontName, family);
      } catch {
        /* couldn't load the built font; the span keeps its placeholder text */
      }
    }
    for (const para of paragraphs) {
      para.el.querySelectorAll<HTMLElement>("span[data-font]").forEach((span) => {
        const fam = span.dataset.font ? displayFamilies.get(span.dataset.font) : undefined;
        if (fam) span.style.fontFamily = `'${fam}', ${span.style.fontFamily}`;
      });
    }
  };

  injectStyles();
  const wrap = document.createElement("div");
  wrap.className = "pdfedit-wrap";
  const toolbar = buildToolbar();
  const root = document.createElement("div");
  root.className = "pdfedit-root";
  wrap.append(toolbar.el, root, live);
  container.appendChild(wrap);

  // Two-finger pinch zooms the document only (it drives the same zoom control as the
  // slider), not the whole page. For touch devices such as the Android app.
  let pinchDist0 = 0;
  let pinchPct0 = 100;
  const touchDist = (t: TouchList): number => {
    const a = t[0]!;
    const b = t[1]!;
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  };
  root.addEventListener(
    "touchstart",
    (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinchDist0 = touchDist(e.touches);
        pinchPct0 = Math.round(displayZoom * 100);
      }
    },
    { passive: true },
  );
  root.addEventListener(
    "touchmove",
    (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchDist0 > 0) {
        e.preventDefault(); // handle the gesture ourselves; no page scroll/native zoom
        toolbar.setZoom(pinchPct0 * (touchDist(e.touches) / pinchDist0));
      }
    },
    { passive: false },
  );
  const endPinch = (): void => {
    pinchDist0 = 0;
  };
  root.addEventListener("touchend", endPinch);
  root.addEventListener("touchcancel", endPinch);

  // Track the selection inside a paragraph so toolbar controls that steal focus
  // (color/font/size pickers) can restore it before applying, and reflect the caret's
  // style back into the toolbar fields.
  // Highlight the saved selection with the CSS Custom Highlight API so it stays visible
  // when focus moves to a toolbar control (the native highlight only shows while the
  // contenteditable is focused). Falls back to nothing on browsers without the API.
  const cssHL = (window as unknown as { CSS?: { highlights?: { set(k: string, v: unknown): void; delete(k: string): void } } }).CSS?.highlights;
  const HighlightCtor = (window as unknown as { Highlight?: new (r: Range) => unknown }).Highlight;
  const showSavedHighlight = () => {
    try {
      if (!cssHL || !HighlightCtor) return;
      if (savedRange && !savedRange.collapsed) cssHL.set("pdfedit-sel", new HighlightCtor(savedRange.cloneRange()));
      else cssHL.delete("pdfedit-sel");
    } catch {
      /* ignore */
    }
  };
  const clearHighlight = () => {
    try {
      cssHL?.delete("pdfedit-sel");
    } catch {
      /* ignore */
    }
  };

  // Attach the editing behaviour (active state, selection retention, dirty tracking) to a
  // paragraph's element. Used for both extracted paragraphs and ones added in blank space.
  const wirePara = (para: Paragraph): void => {
    const el = para.el;
    el.addEventListener("focus", () => {
      activePara = para;
      savedPara = para;
      // Keep this paragraph active (border + visible overlay) even when focus moves to a
      // toolbar control; the native selection shows while it is focused.
      for (const p of paragraphs) p.el.classList.toggle("pdfedit-active", p === para);
      clearHighlight();
      toolbar.update({ sizePt: para.size, family: para.family });
    });
    el.addEventListener("blur", (e) => {
      const to = (e as FocusEvent).relatedTarget as Node | null;
      if (to && toolbar.el.contains(to)) {
        showSavedHighlight();
        return;
      }
      el.classList.remove("pdfedit-active");
      clearHighlight();
      // A box added in blank space but left empty is discarded (so a stray add leaves nothing).
      if (para.isNew && (el.textContent ?? "").trim() === "") {
        el.remove();
        const i = paragraphs.indexOf(para);
        if (i >= 0) paragraphs.splice(i, 1);
        if (activePara === para) activePara = null;
        if (savedPara === para) savedPara = null;
      }
    });
    el.addEventListener("input", () => {
      para.dirty = true;
      el.classList.add("pdfedit-edited");
      change();
    });
  };

  // Render one tategaki block: a right-to-left run of columns as a single vertical-rl
  // editable box. Columns are joined by <br> (a line break moves one column left).
  const renderVerticalBlock = (
    cols: VCol[],
    pageIndex: number,
    page: pdfjsLib.PDFPageProxy,
    viewport: pdfjsLib.PageViewport,
    cctx: CanvasRenderingContext2D | null,
    pageEl: HTMLElement,
  ): void => {
    const all = cols.flatMap((c) => c.items);
    if (!all.length || cols.every((c) => c.text.trim() === "")) return;
    const size = median(all.map((i) => i.size)) || 12;
    const pitches: number[] = [];
    for (let i = 1; i < cols.length; i++) {
      const d = Math.abs(cols[i - 1]!.x - cols[i]!.x);
      if (d > 1) pitches.push(d);
    }
    const pitch = median(pitches) || size * 1.6;
    const leftExtent = Math.min(...all.map((i) => i.x));
    const rightX = Math.max(...all.map((i) => i.x)); // rightmost column glyph-origin
    const rightExtent = rightX + size;
    const topBaseline = Math.max(...all.map((i) => i.y));
    const topExtent = topBaseline + size * 0.85;
    const botExtent = Math.min(...all.map((i) => i.y)) - size * 0.15;
    // Anchor the box at the text's top-right and let it hug its content (max-content in both
    // axes): vertical-rl fills down-then-left from the top-right, so a content-sized box keeps
    // edited/long columns inside the focus ring regardless of how the browser's font metrics
    // differ from the original (which the tight ink extent did not allow for).
    const tr = viewport.convertToViewportPoint(rightExtent, topExtent);
    const bl = viewport.convertToViewportPoint(leftExtent, botExtent);
    const rightPx = Math.max(tr[0]!, bl[0]!);
    const top = Math.min(tr[1]!, bl[1]!);
    const sLeft = Math.min(tr[0]!, bl[0]!); // original ink region, for colour sampling
    const sW = Math.abs(bl[0]! - tr[0]!);
    const sH = Math.abs(bl[1]! - tr[1]!);
    const { fg, bg } = cctx ? sampleColors(cctx, sLeft, top, sW, sH) : { fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } };
    const fgHex = rgb255ToHex(fg);

    // Build styled spans column by column (right-to-left), glyphs top-to-bottom.
    const fontCount = new Map<string, number>();
    let html = "";
    cols.forEach((col, ci) => {
      let curFont = "";
      let curSize = 0;
      let curText = "";
      const flush = () => {
        if (!curText) return;
        const rec = getFontRec(page, curFont);
        const parts: string[] = [];
        if (rec.bold) parts.push("font-weight:bold");
        if (rec.italic) parts.push("font-style:italic");
        parts.push(`font-family:${rec.cssName ? `'${rec.cssName}', ${cssFamily(rec.family)}` : cssFamily(rec.family)}`);
        parts.push(`font-size:${(curSize * scale).toFixed(2)}px`);
        parts.push(`color:${fgHex}`);
        html += `<span data-font="${curFont}" style="${parts.join(";")}">${escapeHtml(curText)}</span>`;
        curText = "";
      };
      for (const it of col.items) {
        if (it.str === "") continue;
        fontCount.set(it.fontName, (fontCount.get(it.fontName) ?? 0) + it.str.length);
        const szR = Math.round(it.size * 10) / 10;
        if (it.fontName !== curFont || szR !== curSize) {
          flush();
          curFont = it.fontName;
          curSize = szR;
        }
        curText += it.str;
      }
      flush();
      if (ci !== cols.length - 1) html += "<br>";
    });

    let baseFontName = all[0]!.fontName;
    let bestN = -1;
    for (const [fn, n] of fontCount) {
      if (n > bestN) {
        bestN = n;
        baseFontName = fn;
      }
    }
    const baseRec = getFontRec(page, baseFontName);

    const el = document.createElement("div");
    el.className = "pdfedit-para";
    el.contentEditable = "true";
    el.spellcheck = false;
    el.setAttribute("role", "textbox");
    el.setAttribute("aria-multiline", "true");
    el.innerHTML = html || escapeHtml(cols.map((c) => c.text).join(""));
    el.style.right = `${Math.max(0, viewport.width - rightPx)}px`;
    el.style.top = `${top}px`;
    el.style.width = "max-content";
    el.style.height = "max-content";
    el.style.writingMode = "vertical-rl";
    el.style.fontSize = `${size * scale}px`;
    el.style.lineHeight = `${pitch * scale}px`;
    el.style.fontWeight = "normal";
    el.style.fontStyle = "normal";
    el.style.fontFamily = cssFamily(baseRec.family);
    el.style.color = fgHex;
    el.style.setProperty("--c", fgHex);
    el.style.setProperty("--bg", rgb255ToHex(bg));

    const para: Paragraph = {
      page: pageIndex,
      x: leftExtent,
      w: rightExtent - leftExtent,
      topY: topExtent,
      bottomY: botExtent,
      firstBaseline: topBaseline,
      lineHeight: pitch,
      size,
      align: "left",
      family: baseRec.family,
      baseFontKey: baseFontName,
      color: norm(fg),
      bg: norm(bg),
      origText: cols.map((c) => c.text).join("\n"),
      dirty: false,
      el,
      viewport,
      anchorText: "",
      anchors: [],
      glyphPreserve: false,
      vertical: true,
      vStartX: rightX,
      vTopY: topBaseline,
      vPitch: pitch,
      vBottomY: botExtent,
    };
    wirePara(para);
    pageEl.appendChild(el);
    paragraphs.push(para);
  };

  // Add a new editable text box at a blank spot (double-clicked) on a page.
  // Create an added text box at a PDF-space position. Used by the double-click handler and by
  // session restore (which passes a saved width/size/style and content instead of defaults).
  const createTextBox = (
    pageEl: HTMLElement,
    viewport: pdfjsLib.PageViewport,
    pageIndex: number,
    o: { pdfX: number; pdfY: number; wPdf?: number; size?: number; align?: Align; family?: Family; colorHex?: string; html?: string; focus?: boolean },
  ): Paragraph => {
    const [vx, vy] = viewport.convertToViewportPoint(o.pdfX, o.pdfY);
    const pageWidthPdf = viewport.width / scale;
    const size = o.size ?? 12;
    const wPdf = o.wPdf ?? Math.max(60, pageWidthPdf - o.pdfX - 10);
    const family = o.family ?? "sans";
    const colorHex = o.colorHex ?? "#000";
    const lineHeight = size * 1.2;
    const el = document.createElement("div");
    el.className = o.focus ? "pdfedit-para pdfedit-active" : "pdfedit-para";
    el.contentEditable = "true";
    el.spellcheck = false;
    el.setAttribute("role", "textbox");
    el.setAttribute("aria-multiline", "true");
    if (o.html) el.innerHTML = o.html;
    el.style.left = `${vx}px`;
    el.style.top = `${vy}px`;
    el.style.width = `${wPdf * scale}px`;
    el.style.minHeight = `${size * scale}px`;
    el.style.fontSize = `${size * scale}px`;
    el.style.lineHeight = `${lineHeight * scale}px`;
    el.style.fontFamily = cssFamily(family);
    el.style.textAlign = o.align ?? "left";
    el.style.color = colorHex;
    el.style.setProperty("--c", colorHex);
    el.style.setProperty("--bg", "#ffffff");
    const para: Paragraph = {
      page: pageIndex,
      x: o.pdfX,
      w: wPdf,
      topY: o.pdfY,
      bottomY: o.pdfY - lineHeight,
      firstBaseline: o.pdfY - size * 0.8,
      lineHeight,
      size,
      align: o.align ?? "left",
      family,
      baseFontKey: "",
      color: cssColorToRgb(colorHex, { r: 0, g: 0, b: 0 }),
      bg: { r: 1, g: 1, b: 1 },
      origText: "",
      dirty: !!o.html, // restored content is already an edit
      el,
      viewport,
      anchorText: "",
      anchors: [],
      glyphPreserve: false,
      isNew: true,
    };
    wirePara(para);
    pageEl.appendChild(el);
    paragraphs.push(para);
    if (o.focus) el.focus();
    return para;
  };

  const addTextAt = (pageEl: HTMLElement, viewport: pdfjsLib.PageViewport, pageIndex: number, clientX: number, clientY: number): void => {
    const rect = pageEl.getBoundingClientRect();
    const vx = (clientX - rect.left) / displayZoom; // undo the CSS zoom -> canvas/viewport px
    const vy = (clientY - rect.top) / displayZoom;
    const [pdfX, pdfY] = viewport.convertToPdfPoint(vx, vy);
    createTextBox(pageEl, viewport, pageIndex, { pdfX, pdfY, focus: true });
  };

  const onSelChange = () => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    const elx = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
    if (!elx || !root.contains(elx)) return;
    const paraEl = elx.closest(".pdfedit-para");
    if (!paraEl) return;
    // Only remember a real (non-empty) selection. A collapsed caret, e.g. the one left
    // behind when clicking a toolbar control, must not overwrite the selection the user
    // wants to style, or color/size would have nothing to apply to.
    if (!r.collapsed) savedRange = r.cloneRange();
    const para = paragraphs.find((p) => p.el === paraEl) ?? null;
    if (para) {
      savedPara = para;
      activePara = para;
    }
    // Note: deliberately do NOT sync the color swatch to the selection's color, so the
    // user's chosen color persists across selections (apply one color to several runs).
    const cs = getComputedStyle(elx);
    toolbar.update({ sizePt: parseFloat(cs.fontSize) / scale, family: familyOf(cs.fontFamily) });
  };
  document.addEventListener("selectionchange", onSelChange);

  function buildToolbar() {
    const el = document.createElement("div");
    el.className = "pdfedit-toolbar";
    el.setAttribute("role", "toolbar");
    el.setAttribute("aria-label", t("toolbar"));
    const keepSel = (b: HTMLElement) => b.addEventListener("mousedown", (e) => e.preventDefault());
    const exec = (cmd: string, val?: string) => document.execCommand(cmd, false, val);
    // Apply a CSS property to the saved selection by operating on the Range OBJECT
    // directly (not the live document selection). Range methods don't need focus, so this
    // works even after clicking a toolbar input moved focus away from the paragraph, which
    // is why color/font/size do NOT go through withSel/execCommand.
    const applyStyle = (cssProp: string, value: string) => {
      const range = savedRange;
      if (!range || range.collapsed) return;
      const span = document.createElement("span");
      span.style.setProperty(cssProp, value);
      try {
        range.surroundContents(span);
      } catch {
        span.appendChild(range.extractContents());
        range.insertNode(span);
      }
      // Inner spans carry their own inline style; clear this one property on them so the
      // wrapper's new value wins instead of being overridden by a nested span.
      span.querySelectorAll<HTMLElement>("*").forEach((e) => e.style.removeProperty(cssProp));
      const r = document.createRange();
      r.selectNodeContents(span);
      savedRange = r; // keep the styled run selected so styles can be chained
      if (savedPara) {
        savedPara.dirty = true;
        savedPara.el.classList.add("pdfedit-edited");
      }
      showSavedHighlight(); // keep the (now styled) selection visible while a control has focus
      change();
    };
    // Restore the saved paragraph selection, run the styling op, mark dirty. Used by the
    // execCommand-based controls (bold/italic/link), which need the live selection.
    const withSel = (fn: () => void) => {
      if (savedPara) {
        savedPara.el.focus();
        if (savedRange) {
          const s = document.getSelection();
          if (s) {
            s.removeAllRanges();
            s.addRange(savedRange);
          }
        }
        activePara = savedPara;
      }
      fn();
      touch();
    };

    const iconBtn = (svg: string, title: string, fn: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = svg;
      b.title = title;
      b.setAttribute("aria-label", title); // icon-only button needs an accessible name
      b.firstElementChild?.setAttribute("aria-hidden", "true"); // the SVG is decorative
      b.addEventListener("click", () => withSel(fn));
      keepSel(b);
      return b;
    };
    const sep = () => {
      const s = document.createElement("span");
      s.className = "sep";
      return s;
    };

    // Bold/italic are toggles: expose and update aria-pressed from the selection's state.
    const toggleBtn = (label: string, title: string, css: string, cmd: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.setAttribute("aria-pressed", "false");
      if (css) b.style.cssText = css;
      b.addEventListener("click", () => {
        withSel(() => exec(cmd));
        try { b.setAttribute("aria-pressed", String(document.queryCommandState(cmd))); } catch { /* no active editable */ }
      });
      keepSel(b);
      return b;
    };
    const boldBtn = toggleBtn("B", t("bold"), "font-weight:bold", "bold");
    const italBtn = toggleBtn("I", t("italic"), "font-style:italic", "italic");
    el.append(boldBtn, italBtn);

    const color = document.createElement("input");
    color.type = "color";
    color.title = t("textColor");
    color.setAttribute("aria-label", t("textColor"));
    color.value = "#000000";
    color.addEventListener("change", () => applyStyle("color", color.value));
    el.append(color);

    const font = document.createElement("select");
    font.title = t("font");
    font.setAttribute("aria-label", t("fontFamily"));
    for (const [v, label] of [["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"]] as const) {
      font.add(new Option(label, v));
    }
    font.addEventListener("change", () => applyStyle("font-family", cssFamily(font.value as Family)));
    el.append(font);

    const size = document.createElement("input");
    size.type = "number";
    size.min = "4";
    size.max = "300";
    size.title = t("fontSize");
    size.setAttribute("aria-label", t("fontSizeAria"));
    size.addEventListener("change", () => {
      if (size.value) applyStyle("font-size", `${(Number(size.value) * scale).toFixed(2)}px`);
    });
    el.append(size);

    el.append(
      sep(),
      iconBtn(ICON.left, t("alignLeft"), () => setAlign("left")),
      iconBtn(ICON.center, t("alignCenter"), () => setAlign("center")),
      iconBtn(ICON.right, t("alignRight"), () => setAlign("right")),
      iconBtn(ICON.justify, t("justify"), () => setAlign("justify")),
      sep(),
    );

    const linkBtn = document.createElement("button");
    linkBtn.type = "button";
    linkBtn.textContent = t("link");
    linkBtn.title = t("linkTitle");
    linkBtn.setAttribute("aria-label", t("linkAria"));
    keepSel(linkBtn);
    linkBtn.addEventListener("click", () => {
      const url = prompt(t("linkPrompt"), "https://");
      if (url === null) return;
      withSel(() => {
        if (url === "") exec("unlink");
        else exec("createLink", url);
      });
    });
    el.append(linkBtn);

    const imgBtn = document.createElement("button");
    imgBtn.type = "button";
    imgBtn.textContent = t("image");
    imgBtn.title = t("insertImage");
    imgBtn.setAttribute("aria-label", t("insertImage"));
    keepSel(imgBtn);
    imgBtn.addEventListener("click", () => imageInput.click());
    el.append(imgBtn);

    const imageInput = document.createElement("input");
    imageInput.type = "file";
    imageInput.accept = "image/png,image/jpeg";
    imageInput.tabIndex = -1;
    imageInput.setAttribute("aria-hidden", "true");
    imageInput.style.display = "none";
    imageInput.addEventListener("change", () => {
      const f = imageInput.files?.[0];
      if (f) void insertImage(f);
      imageInput.value = "";
    });
    el.append(imageInput);

    // Zoom: a slider + a percentage input, kept in sync. Scales the displayed pages only.
    el.append(sep());
    const zoomWrap = document.createElement("span");
    zoomWrap.className = "pdfedit-zoom";
    const zlabel = document.createElement("span");
    zlabel.textContent = t("zoom");
    zlabel.setAttribute("aria-hidden", "true"); // controls below carry their own labels
    const zrange = document.createElement("input");
    zrange.type = "range";
    zrange.min = "25";
    zrange.max = "400";
    zrange.step = "5";
    zrange.value = String(Math.round(displayZoom * 100));
    zrange.title = t("zoom");
    zrange.setAttribute("aria-label", t("zoomLevelAria"));
    const znum = document.createElement("input");
    znum.type = "number";
    znum.min = "25";
    znum.max = "400";
    znum.value = String(Math.round(displayZoom * 100));
    znum.title = t("zoomPctTitle");
    znum.setAttribute("aria-label", t("zoomPctAria"));
    const zpct = document.createElement("span");
    zpct.textContent = "%";
    const setZoom = (pct: number) => {
      const p = Math.max(25, Math.min(400, Math.round(pct || 100)));
      zrange.value = String(p);
      znum.value = String(p);
      applyZoom(p / 100);
      saveZoomPct(p);
      live.textContent = `${t("zoom")} ${p}%`;
    };
    zrange.addEventListener("input", () => setZoom(Number(zrange.value)));
    znum.addEventListener("change", () => setZoom(Number(znum.value)));
    zoomWrap.append(zlabel, zrange, znum, zpct);
    el.append(zoomWrap);

    const update = (o: { sizePt?: number; family?: Family; colorHex?: string }) => {
      if (o.sizePt != null && isFinite(o.sizePt)) size.value = String(Math.round(o.sizePt));
      if (o.family) font.value = o.family;
      if (o.colorHex) color.value = o.colorHex;
      // Reflect the current selection's bold/italic state on the toggle buttons.
      try {
        boldBtn.setAttribute("aria-pressed", String(document.queryCommandState("bold")));
        italBtn.setAttribute("aria-pressed", String(document.queryCommandState("italic")));
      } catch {
        /* no active editable */
      }
    };
    return { el, update, setZoom };
  }

  function setAlign(a: Align): void {
    if (!activePara) return;
    activePara.align = a;
    activePara.el.style.textAlign = a;
    activePara.dirty = true;
    activePara.el.classList.add("pdfedit-edited");
    change();
  }

  // The page under the middle of the scroll viewport, so inserts land on what
  // the user is looking at rather than always on page 1.
  function pageInView(): { el: HTMLElement; viewport: pdfjsLib.PageViewport; index: number } | undefined {
    const rootRect = root.getBoundingClientRect();
    const centerY = rootRect.top + rootRect.height / 2;
    let best: (typeof pageEls)[number] | undefined;
    let bestDist = Infinity;
    for (const p of pageEls) {
      const r = p.el.getBoundingClientRect();
      if (r.top <= centerY && r.bottom >= centerY) return p;
      const d = Math.min(Math.abs(r.top - centerY), Math.abs(r.bottom - centerY));
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  }

  async function insertImage(file: File): Promise<void> {
    const target = pageInView() ?? pageEls[0];
    if (!target) return;
    addImageBox(new Uint8Array(await file.arrayBuffer()), file.type, target, null, true);
  }

  // Build an image box (DOM + drag/resize/delete wiring). `place` restores a saved
  // viewport-space position/size (render scale is constant per document); null uses defaults.
  function addImageBox(
    bytesImg: Uint8Array,
    mime: string,
    target: { el: HTMLElement; viewport: pdfjsLib.PageViewport; index: number },
    place: { leftPx: number; topPx: number; widthPx: number } | null,
    focus: boolean,
  ): void {
    const box = document.createElement("div");
    box.className = "pdfedit-img";
    box.tabIndex = 0; // keyboard focusable
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", t("imageBoxAria"));
    box.style.left = `${place ? place.leftPx : 40}px`;
    box.style.top = `${place ? place.topPx : 40}px`;
    box.style.width = `${place ? place.widthPx : 160}px`;
    const img = document.createElement("img");
    img.src = URL.createObjectURL(new Blob([bytesImg as BlobPart], { type: mime }));
    img.draggable = false;
    img.alt = "";
    const handle = document.createElement("div");
    handle.className = "pdfedit-img-handle";
    handle.title = t("dragResize");
    handle.setAttribute("aria-hidden", "true"); // mouse affordance; keyboard uses +/- on the box
    const del = document.createElement("button");
    del.type = "button";
    del.className = "pdfedit-img-del";
    del.textContent = "×";
    del.title = t("deleteImage");
    del.setAttribute("aria-label", t("deleteImage"));
    box.append(img, handle, del);
    target.el.appendChild(box);
    const rec: ImageItem = { page: target.index, bytes: bytesImg, mime, xPdf: 0, yPdf: 0, wPdf: 0, hPdf: 0, el: box };
    images.push(rec);
    img.addEventListener("load", () => updateImageRect(rec, target.viewport), { once: true });
    makeDraggable(box);
    makeResizable(box, handle, rec);

    const sync = () => {
      const vp = pageViewportOf(box);
      if (vp) updateImageRect(rec, vp);
      change();
    };
    const removeImage = () => {
      box.remove();
      const i = images.indexOf(rec);
      if (i >= 0) images.splice(i, 1);
      change();
    };
    const moveBy = (dx: number, dy: number) => {
      box.style.left = `${parseFloat(box.style.left) + dx}px`;
      box.style.top = `${parseFloat(box.style.top) + dy}px`;
      sync();
    };
    const resizeBy = (dw: number) => {
      box.style.width = `${Math.max(20, box.offsetWidth + dw)}px`; // height auto keeps aspect
      sync();
    };
    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeImage();
    });
    // Keyboard control when the image box has focus.
    box.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 20 : 5;
      switch (e.key) {
        case "ArrowLeft": e.preventDefault(); moveBy(-step, 0); break;
        case "ArrowRight": e.preventDefault(); moveBy(step, 0); break;
        case "ArrowUp": e.preventDefault(); moveBy(0, -step); break;
        case "ArrowDown": e.preventDefault(); moveBy(0, step); break;
        case "+": case "=": e.preventDefault(); resizeBy(e.shiftKey ? 40 : 10); break;
        case "-": case "_": e.preventDefault(); resizeBy(e.shiftKey ? -40 : -10); break;
        case "Delete": case "Backspace": e.preventDefault(); removeImage(); break;
      }
    });
    if (focus) box.focus(); // newly inserted image gets focus so it can be positioned by keyboard
    change();
  }

  const pageViewportOf = (el: HTMLElement) => pageEls.find((p) => p.el === el.parentElement)?.viewport;

  function makeDraggable(box: HTMLElement): void {
    box.addEventListener("pointerdown", (e) => {
      if (e.target !== box && (e.target as HTMLElement).tagName !== "IMG") return; // not on handle/delete
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const left = parseFloat(box.style.left);
      const top = parseFloat(box.style.top);
      const move = (ev: PointerEvent) => {
        box.style.left = `${left + ev.clientX - startX}px`;
        box.style.top = `${top + ev.clientY - startY}px`;
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        const rec = images.find((r) => r.el === box);
        const vp = pageViewportOf(box);
        if (rec && vp) updateImageRect(rec, vp);
        change();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
  }

  function makeResizable(box: HTMLElement, handle: HTMLElement, rec: ImageItem): void {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = box.offsetWidth;
      const move = (ev: PointerEvent) => {
        box.style.width = `${Math.max(20, startW + (ev.clientX - startX))}px`; // height is auto, keeps aspect
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        const vp = pageViewportOf(box);
        if (vp) updateImageRect(rec, vp);
        change();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
  }

  function updateImageRect(rec: ImageItem, viewport: pdfjsLib.PageViewport): void {
    const left = parseFloat(rec.el.style.left);
    const top = parseFloat(rec.el.style.top);
    const w = rec.el.offsetWidth;
    const h = rec.el.offsetHeight;
    const tl = viewport.convertToPdfPoint(left, top);
    const br = viewport.convertToPdfPoint(left + w, top + h);
    rec.xPdf = Math.min(tl[0]!, br[0]!);
    rec.yPdf = Math.min(tl[1]!, br[1]!);
    rec.wPdf = Math.abs(br[0]! - tl[0]!);
    rec.hPdf = Math.abs(br[1]! - tl[1]!);
  }

  void (async () => {
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(), fontExtraProperties: true }).promise;
    // Lazily parsed (pdf-lib) copy used only to recover original glyph codes for blocks whose
    // fonts have no usable Unicode. Loaded on first need so normal PDFs pay nothing.
    let glyphPdf: PDFDocument | null = null;
    let glyphPdfFailed = false;
    const glyphsForPage = async (pageIndex: number): Promise<PlacedGlyph[]> => {
      if (glyphPdfFailed) return [];
      try {
        if (!glyphPdf) glyphPdf = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true });
        return pageGlyphs(glyphPdf, pageIndex);
      } catch {
        glyphPdfFailed = true;
        return [];
      }
    };
    for (let p = 1; p <= doc.numPages && !destroyed; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale });
      const pageW = page.getViewport({ scale: 1 }).width;
      const pageEl = document.createElement("div");
      pageEl.className = "pdfedit-page";
      pageEl.style.width = `${viewport.width}px`;
      pageEl.style.height = `${viewport.height}px`;
      pageEl.style.zoom = String(displayZoom);
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.setAttribute("aria-hidden", "true"); // visual render; the text is in the overlay
      const cctx = canvas.getContext("2d");
      if (cctx) await page.render({ canvasContext: cctx, viewport, canvas }).promise;
      pageEl.appendChild(canvas);
      pageEls.push({ el: pageEl, viewport, index: p - 1 });
      // Double-click a blank spot (not on existing text or an image) to add a text box there.
      const pageIndex = p - 1;
      const pageViewport = viewport;
      const thisPageEl = pageEl;
      pageEl.addEventListener("dblclick", (e) => {
        const t = e.target as HTMLElement;
        if (t.closest(".pdfedit-para") || t.closest(".pdfedit-img")) return;
        addTextAt(thisPageEl, pageViewport, pageIndex, e.clientX, e.clientY);
      });

      const content = await page.getTextContent();
      const allItems: RunItem[] = [];
      for (const item of content.items) {
        if (!("str" in item) || item.str === "") continue;
        const t = item.transform as number[];
        const norm = normalizePua(item.str);
        if (norm !== item.str) puaFonts.add(item.fontName); // symbol font: remember for export
        allItems.push({ str: norm, x: t[4]!, y: t[5]!, w: item.width ?? 0, size: Math.hypot(t[2]!, t[3]!) || 10, fontName: item.fontName });
      }
      // Drop hidden text layers: some PDFs (e.g. Google Docs / OCR exports) draw the
      // visible glyphs with an embedded/Type3 font and overlay an invisible copy in a
      // plain standard font (Helvetica/Times, no embedded program) for selection. Editing
      // would otherwise repaint that copy as visible and clobber the real font. A
      // standard-font run that overlaps a real (embedded or Type3) run on the same line is
      // treated as hidden; a standalone standard-font run is kept.
      const boxes = allItems.map((it) => ({ it, rec: getFontRec(page, it.fontName) }));
      const real = boxes.filter((b) => b.rec.data || b.rec.isType3);
      const items = boxes
        .filter((b) => {
          if (b.rec.data || b.rec.isType3) return true;
          const overlaps = real.some((r) => Math.abs(r.it.y - b.it.y) <= Math.max(b.it.size, r.it.size) * 0.5 && b.it.x < r.it.x + r.it.w && r.it.x < b.it.x + b.it.w);
          return !overlaps;
        })
        .map((b) => b.it);
      const perItemColor = !!cctx && items.length <= 800;

      // Anchor each item's characters to their original glyphs (font resource + byte code),
      // but only for pages that use a font with no usable Unicode (where editing would
      // otherwise lose the glyph). Normal PDFs skip this entirely.
      const pageHasFragileFont = items.some((it) => puaFonts.has(it.fontName));
      if (pageHasFragileFont) {
        const placed = await glyphsForPage(p - 1);
        const fontStats = new Map<string, { alnum: number; total: number }>();
        for (const it of items) {
          const chars = [...it.str];
          if (!chars.length) continue;
          // Invisible (white / render-mode-3) text is drawn but not shown. Decide this from
          // the glyph at the item's origin (robust even when the run overlaps visible text,
          // which would otherwise spoil the per-character count match below).
          let originGlyph: PlacedGlyph | null = null;
          let originDist = Infinity;
          for (const g of placed) {
            const d = Math.abs(g.x - it.x) + Math.abs(g.y - it.y);
            if (d < originDist) {
              originDist = d;
              originGlyph = g;
            }
          }
          if (originGlyph && originDist < 2 && !originGlyph.visible) {
            it.invisible = true; // omit invisible text from the overlay (it stays in the file)
            continue;
          }
          // Assign a glyph to this item when its centre falls in the item's x-span, so a
          // neighbouring glyph at the seam is not double-counted (matters for 1-glyph items).
          const here = placed
            .filter((g) => Math.abs(g.y - it.y) <= it.size * 0.4 && g.x + g.width / 2 >= it.x && g.x + g.width / 2 <= it.x + it.w)
            .sort((a, b) => a.x - b.x);
          if (here.length !== chars.length) continue; // mismatched mapping: leave un-anchored
          const fg = cctx ? sampleRunStats(cctx, viewport, it.x, it.y, it.w, it.size).fg : { r: 0, g: 0, b: 0 };
          const color = { r: fg.r / 255, g: fg.g / 255, b: fg.b / 255 };
          it.anchors = here.map((g) => ({ fontRes: g.fontRes, hex: g.hex, width: g.width, size: g.size, color }));
          const st = fontStats.get(it.fontName) ?? { alnum: 0, total: 0 };
          for (const ch of chars) {
            st.total++;
            if (/[\p{L}\p{N}]/u.test(ch)) st.alnum++;
          }
          fontStats.set(it.fontName, st);
        }
        // A font whose decoded text is mostly NOT letters/digits is one whose Unicode is
        // unreliable (the glyphs have no real characters, only shapes). For those, swap the
        // displayed text for unique private codepoints and render the true outlines via a
        // built display font, so the overlay shows the real glyphs instead of mojibake.
        const unreliable = new Set<string>();
        for (const [fn, st] of fontStats) if (st.total >= 2 && st.alnum / st.total < 0.5) unreliable.add(fn);
        for (const it of items) {
          if (!it.anchors || !unreliable.has(it.fontName)) continue;
          let cmap = displayFontChars.get(it.fontName);
          if (!cmap) displayFontChars.set(it.fontName, (cmap = new Map()));
          const chars = [...it.str];
          let s = "";
          for (let k = 0; k < chars.length; k++) {
            const a = it.anchors[k];
            if (!a) {
              s += chars[k];
              continue;
            }
            const gid = parseInt(a.hex, 16);
            const dch = displayCharFor(it.fontName, gid);
            cmap.set(dch, gid);
            s += dch;
          }
          it.str = s;
        }
      }

      // Sample the background under a line so the grouper can split blocks that differ in
      // fill (e.g. a shaded table header above a white data cell), even when adjacent.
      const bgOf = cctx
        ? (ln: Line): RGB | null => {
            const a = viewport.convertToViewportPoint(ln.minX, ln.y + ln.size * 0.85);
            const b = viewport.convertToViewportPoint(ln.maxX, ln.y - ln.size * 0.3);
            const left = Math.min(a[0]!, b[0]!);
            const top = Math.min(a[1]!, b[1]!);
            const w = Math.max(Math.abs(b[0]! - a[0]!), 2);
            const h = Math.max(Math.abs(b[1]! - a[1]!), 4);
            try {
              return sampleColors(cctx, left, top, w, h).bg;
            } catch {
              return null;
            }
          }
        : undefined;

      const visible = items.filter((it) => !it.invisible);
      if (detectVertical(visible)) {
        for (const cols of buildVerticalBlocks(visible)) renderVerticalBlock(cols, p - 1, page, viewport, cctx, pageEl);
        root.appendChild(pageEl);
        continue;
      }
      for (const lines of buildParagraphs(visible, bgOf)) {
        const first = lines[0]!;
        if (lines.every((l) => l.text.trim() === "")) continue;
        const boxX = Math.min(...lines.map((l) => l.minX));
        const boxRight = Math.max(...lines.map((l) => l.maxX));
        const size = first.size;
        const lineHeight = lines.length >= 2 ? Math.abs(lines[0]!.y - lines[1]!.y) || size * 1.2 : size * 1.2;
        const topY = first.y + size * 0.85;
        const bottomY = lines[lines.length - 1]!.y - size * 0.3;
        const align = detectAlign(lines, boxX, boxRight, pageW);
        // Soft wrap (flowing paragraph) vs hard line breaks (address / list): a flowing
        // paragraph's non-last lines each reach near the right edge (they broke because the
        // next word did not fit). If most lines instead end short, the breaks are intentional
        // and must be preserved as <br> rather than reflowed with a space.
        const bodyLines = lines.slice(0, -1);
        const fullCount = bodyLines.filter((l) => l.maxX >= boxRight - size * 2).length;
        const flowing = align === "justify" || (bodyLines.length >= 1 && fullCount >= Math.ceil(bodyLines.length * 0.6));
        const firstRec = getFontRec(page, first.items[0]!.fontName);
        const famCss = (rec: FontRec) => (rec.cssName ? `'${rec.cssName}', ${cssFamily(rec.family)}` : cssFamily(rec.family));

        const tl = viewport.convertToViewportPoint(boxX, topY);
        const br = viewport.convertToViewportPoint(boxRight, bottomY);
        const left = Math.min(tl[0]!, br[0]!);
        const top = Math.min(tl[1]!, br[1]!);
        const dW = Math.abs(br[0]! - tl[0]!);
        const dH = Math.abs(br[1]! - tl[1]!);
        const { fg, bg } = cctx ? sampleColors(cctx, left, top, dW, Math.max(size * scale * 1.2, 4)) : { fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } };
        const origText = lines.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();

        // Reproduce per-run styling (bold/italic/family/size/color) as styled spans so
        // editing keeps it. Consecutive items with the same style merge into one span;
        // soft-wrapped lines join with a space (the block reflows on its own).
        const fgHex = rgb255ToHex(fg);
        let html = "";
        let curKey = "";
        let curRec: FontRec = firstRec;
        let curFontName = first.items[0]!.fontName;
        let curSize = size;
        let curColor = fgHex;
        let curText = "";
        // Built in lockstep with the block text (curText pieces + "\n" per <br>) so each
        // character keeps its original-glyph anchor for glyph-preserving export.
        let anchorText = "";
        const paraAnchors: (Anchor | null)[] = [];
        let blockHasFragile = false;
        const fontCount = new Map<string, number>(); // chars per font, to find the dominant one
        const flushSpan = () => {
          if (!curText) return;
          const parts: string[] = [];
          if (curRec.bold) parts.push("font-weight:bold");
          if (curRec.italic) parts.push("font-style:italic");
          parts.push(`font-family:${famCss(curRec)}`);
          parts.push(`font-size:${(curSize * scale).toFixed(2)}px`);
          parts.push(`color:${curColor}`);
          html += `<span data-font="${curFontName}" style="${parts.join(";")}">${escapeHtml(curText)}</span>`;
          curText = "";
        };
        const lastLi = lines.length - 1;
        lines.forEach((ln, li) => {
          let prevEnd = -Infinity; // reset per line; inter-line spacing handled below
          for (const it of ln.items) {
            if (it.str === "") continue;
            const rec = getFontRec(page, it.fontName);
            fontCount.set(it.fontName, (fontCount.get(it.fontName) ?? 0) + it.str.length);
            const szR = Math.round(it.size * 10) / 10;
            const key = `${it.fontName}|${szR}`;
            const gap = prevEnd > -Infinity ? it.x - prevEnd : 0;
            // Decide the seam BEFORE any span flush so a space lands in the previous span
            // (a font change would otherwise have emptied curText and dropped it).
            if (prevEnd > -Infinity && gap < -it.size * 0.5) {
              flushSpan(); // overlapping items are stacked text (separate lines), not one line
              html += "<br>";
              curKey = "";
              anchorText += "\n";
              paraAnchors.push(null);
            } else if (prevEnd > -Infinity && gap > it.size * 0.2 && !/\s$/.test(curText) && !/^\s/.test(it.str)) {
              curText += " "; // positional gap with no whitespace (adjacent label/value)
              anchorText += " ";
              paraAnchors.push(null);
            }
            // Key by font identity (not just detected style) so a differently-fonted run,
            // e.g. a bold subset whose name omits "Bold", still gets its own span and its
            // own original font on export.
            if (key !== curKey) {
              flushSpan();
              curKey = key;
              curRec = rec;
              curFontName = it.fontName;
              curSize = it.size;
              if (cctx && it.str.trim() !== "") {
                const st = sampleRunStats(cctx, viewport, it.x, it.y, it.w, it.size);
                if (perItemColor) curColor = rgb255ToHex(st.fg);
                rec.inkSum = (rec.inkSum ?? 0) + st.ink;
                rec.inkN = (rec.inkN ?? 0) + 1;
              } else curColor = fgHex;
            }
            curText += it.str;
            if (puaFonts.has(it.fontName)) blockHasFragile = true;
            const chars = [...it.str];
            for (let k = 0; k < chars.length; k++) {
              anchorText += chars[k]!;
              paraAnchors.push(it.anchors?.[k] ?? null);
            }
            prevEnd = it.x + itemWidth(it);
          }
          if (li !== lastLi) {
            if (flowing) {
              curText += " "; // soft wrap: reflow as one paragraph
              anchorText += " ";
              paraAnchors.push(null);
            } else {
              flushSpan(); // hard break: preserve the line return
              anchorText += "\n";
              paraAnchors.push(null);
              html += "<br>";
            }
          }
        });
        flushSpan();

        // Dominant font (most characters): used for the block element and as the fallback
        // for stray / newly-typed text, so it matches the document instead of a generic.
        let baseFontName = first.items[0]!.fontName;
        let bestN = -1;
        for (const [fn, n] of fontCount) {
          if (n > bestN) {
            bestN = n;
            baseFontName = fn;
          }
        }
        const baseRec = getFontRec(page, baseFontName);

        const el = document.createElement("div");
        el.className = "pdfedit-para";
        el.contentEditable = "true";
        el.spellcheck = false;
        el.setAttribute("role", "textbox");
        el.setAttribute("aria-multiline", "true");
        el.innerHTML = html || escapeHtml(origText);
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.width = `${Math.max(dW, size * scale)}px`;
        el.style.minHeight = `${Math.max(dH, size * scale)}px`;
        el.style.fontSize = `${size * scale}px`;
        el.style.lineHeight = `${lineHeight * scale}px`;
        el.style.fontWeight = "normal";
        el.style.fontStyle = "normal";
        // Generic family here; the dominant font's @font-face is added post-load (its face,
        // or a sibling donor's, may not be registered yet at this point).
        el.style.fontFamily = cssFamily(baseRec.family);
        el.style.textAlign = align;
        el.style.color = fgHex;
        el.style.setProperty("--c", fgHex);
        el.style.setProperty("--bg", rgb255ToHex(bg));

        const para: Paragraph = {
          page: p - 1,
          x: boxX,
          w: boxRight - boxX,
          topY,
          bottomY,
          firstBaseline: first.y,
          lineHeight,
          size,
          align,
          family: baseRec.family,
          baseFontKey: baseFontName,
          color: norm(fg),
          bg: norm(bg),
          origText,
          dirty: false,
          el,
          viewport,
          anchorText,
          anchors: paraAnchors,
          // Re-emit original glyphs on export when this block uses fonts with no usable
          // Unicode and the anchors line up with the captured text.
          glyphPreserve:
            blockHasFragile && paraAnchors.length === anchorText.length && paraAnchors.some((a) => a !== null),
        };
        wirePara(para);
        pageEl.appendChild(el);
        paragraphs.push(para);
      }
      root.appendChild(pageEl);
    }
    upgradeOverlayFonts();
    await applyDisplayFonts();
    if (options.initialState) applyState(options.initialState);
  })().catch((e: unknown) => console.error("[pdfedit] render failed", e));

  // Replay a saved session onto the freshly rendered (pristine) pages: re-apply each edited
  // paragraph's content by its render index, then re-add the user's text boxes and images.
  function applyState(st: PdfEditState): void {
    const rendered = paragraphs.filter((p) => !p.isNew);
    for (const e of st.edits) {
      const para = rendered[e.index];
      if (para && para.page === e.page) {
        para.el.innerHTML = e.html;
        para.dirty = true;
        para.el.classList.add("pdfedit-edited");
      }
    }
    for (const b of st.boxes) {
      const target = pageEls.find((pe) => pe.index === b.page);
      if (target) {
        createTextBox(target.el, target.viewport, b.page, {
          pdfX: b.xPdf, pdfY: b.yPdf, wPdf: b.wPdf, size: b.size,
          align: b.align, family: b.family, colorHex: b.colorHex, html: b.html,
        });
      }
    }
    for (const im of st.images) {
      const target = pageEls.find((pe) => pe.index === im.page);
      if (target) addImageBox(im.bytes, im.mime, target, { leftPx: im.leftPx, topPx: im.topPx, widthPx: im.widthPx }, false);
    }
    if (st.edits.length || st.boxes.length || st.images.length) options.onChange?.();
  }

  return {
    isDirty() {
      return images.length > 0 || paragraphs.some((p) => p.dirty);
    },
    getState(): PdfEditState {
      const rendered = paragraphs.filter((p) => !p.isNew);
      const edits: PdfParagraphEdit[] = [];
      rendered.forEach((p, index) => {
        if (p.dirty) edits.push({ page: p.page, index, html: p.el.innerHTML });
      });
      const boxes: PdfBoxState[] = paragraphs
        .filter((p) => p.isNew)
        .map((p) => ({
          page: p.page,
          xPdf: p.x,
          yPdf: p.topY,
          wPdf: p.w,
          size: p.size,
          align: p.align,
          family: p.family,
          colorHex: rgb255ToHex({ r: p.color.r * 255, g: p.color.g * 255, b: p.color.b * 255 }),
          html: p.el.innerHTML,
        }));
      const imgs: PdfImageState[] = images.map((im) => ({
        page: im.page,
        bytes: im.bytes.slice(),
        mime: im.mime,
        leftPx: parseFloat(im.el.style.left) || 0,
        topPx: parseFloat(im.el.style.top) || 0,
        widthPx: im.el.offsetWidth || parseFloat(im.el.style.width) || 0,
      }));
      return { original: original.slice(), edits, boxes, images: imgs };
    },
    async getBytes() {
      const editedParas = paragraphs.filter((p) => p.dirty);
      if (editedParas.length === 0 && images.length === 0) return original.slice();
      // ignoreEncryption: owner-password PDFs (print/copy restricted) render and edit
      // fine via pdf.js; without it pdf-lib throws here and the user's edits are lost.
      const pdf = await PDFDocument.load(original.slice(), { ignoreEncryption: true });
      pdf.registerFontkit(fontkit);
      const pages = pdf.getPages();
      const stdCache = new Map<string, PDFFont>();
      const getStd = async (k: StandardFonts): Promise<PDFFont> => {
        let f = stdCache.get(k);
        if (!f) {
          f = await pdf.embedFont(k);
          stdCache.set(k, f);
        }
        return f;
      };
      // Re-embed the original font program once per source font.
      const embedCache = new Map<string, PDFFont | null>();
      const getEmbedded = async (key: string): Promise<PDFFont | null> => {
        if (embedCache.has(key)) return embedCache.get(key)!;
        const rec = fontRecs.get(key);
        let font: PDFFont | null = null;
        if (rec?.data && rec.data.length) {
          // Subset to keep the output small; some fonts can't be subset, so fall back to
          // embedding the whole (already-subset) program.
          try {
            font = await pdf.embedFont(rec.data, { subset: true });
          } catch {
            try {
              font = await pdf.embedFont(rec.data, { subset: false });
            } catch {
              font = null;
            }
          }
        }
        embedCache.set(key, font);
        return font;
      };
      // Whether an embedded font can render every (non-space) char in the text.
      const covers = (font: PDFFont, text: string): boolean => {
        try {
          const fk = (font as unknown as { embedder?: { font?: { hasGlyphForCodePoint?: (cp: number) => boolean } } }).embedder?.font;
          if (!fk?.hasGlyphForCodePoint) return false;
          for (const ch of text) {
            const cp = ch.codePointAt(0);
            if (!cp || cp === 32 || cp === 9 || cp === 10 || cp === 13) continue;
            if (!fk.hasGlyphForCodePoint(cp)) return false;
          }
          return true;
        } catch {
          return false;
        }
      };
      // Resolve a font per token: reuse the original embedded font when the run's style
      // is unchanged from the source and the font can render that word; otherwise a
      // standard font (WinAnsi). Per-word (not per-run) so one novel character only
      // affects its own word, not the whole paragraph.
      const resolveToken = async (run: StyledRun, part: string, space: boolean): Promise<{ font: PDFFont; text: string; faux: boolean }> => {
        const rec = run.fontKey ? fontRecs.get(run.fontKey) : undefined;
        // "Effective" original weight includes synthBold (a font that renders heavier than
        // its sibling). Matching it means the user didn't toggle, so reuse the real font.
        const effBold = rec ? rec.bold || !!rec.synthBold : run.bold;
        const styleSame = !!(rec && run.bold === effBold && run.italic === rec.italic);
        const std = await getStd(standardFont(rec ? rec.family : run.family, run.bold, run.italic));
        // Pick the embed source: the run's own font if it has a program, else a sibling
        // with the same base name that does (e.g. a Type3 font borrowing its CID twin).
        let embKey: string | undefined;
        if (run.fontKey && styleSame && rec) {
          if (rec.data?.length) embKey = run.fontKey;
          else {
            const donor = findDonor(rec.baseName, (r) => !!r.data?.length);
            if (donor) embKey = donor[0];
          }
        }
        const emb = embKey ? await getEmbedded(embKey) : null;
        const embPua = !!(embKey && puaFonts.has(embKey));
        // A symbol font has glyphs at U+F0xx, not at ASCII; re-encode the text to reuse it.
        if (space) return { font: emb && !embPua ? emb : std, text: " ", faux: false };
        if (emb) {
          const reencoded = embPua ? toPua(part) : part;
          if (covers(emb, reencoded)) {
            // Faux-bold when the run is bold but the reused font isn't an actual bold font.
            const embBold = !!(embKey && fontRecs.get(embKey)?.bold);
            return { font: emb, text: reencoded, faux: run.bold && !embBold };
          }
        }
        return { font: std, text: sanitizeStd(part), faux: false };
      };

      for (const pp of editedParas) {
        const page = pages[pp.page];
        if (!page) continue;
        // Cover the original text region before redrawing; a box added in blank space has
        // nothing to cover (and a white rectangle could hide a coloured background/image).
        if (!pp.isNew) {
          page.drawRectangle({ x: pp.x, y: pp.bottomY, width: Math.max(pp.w, 1), height: Math.max(pp.topY - pp.bottomY, 1), color: rgb(pp.bg.r, pp.bg.g, pp.bg.b) });
        }
        // Fallback for text typed directly in the block (outside any span): the paragraph's
        // dominant font, so stray text exports in the document font, not a generic one.
        const baseRec = fontRecs.get(pp.baseFontKey);
        // Glyph-preserving path: blocks whose fonts have no usable Unicode re-emit their
        // original glyphs (font resource + byte code) for unchanged text, substituting only
        // genuinely new characters. Everything else uses the well-tested substitute path.
        if (pp.glyphPreserve) {
          await drawGlyphPreserving(page, pp, baseRec, getStd);
          continue;
        }
        const base = {
          bold: baseRec ? baseRec.bold || !!baseRec.synthBold : false,
          italic: baseRec ? baseRec.italic : false,
          family: pp.family,
          size: pp.size,
          color: pp.color,
          fontKey: baseRec ? pp.baseFontKey : undefined,
        };
        const runs = parseRuns(pp.el, base, scale);
        if (pp.vertical) await drawVerticalRuns(page, pp, runs, resolveToken);
        else await drawRuns(pdf, page, pp, runs, resolveToken);
      }

      for (const im of images) {
        const page = pages[im.page];
        if (!page || im.wPdf <= 0) continue;
        try {
          const embedded = /png/i.test(im.mime) ? await pdf.embedPng(im.bytes) : await pdf.embedJpg(im.bytes);
          page.drawImage(embedded, { x: im.xPdf, y: im.yPdf, width: im.wPdf, height: im.hPdf });
        } catch (e) {
          console.error("[pdfedit] image embed failed", e);
        }
      }
      return new Uint8Array(await pdf.save());
    },
    destroy() {
      destroyed = true;
      document.removeEventListener("selectionchange", onSelChange);
      for (const ff of faces.values()) {
        try {
          document.fonts.delete(ff);
        } catch {
          /* ignore */
        }
      }
      wrap.remove();
    },
  };

  // Re-emit a block's original glyphs for unchanged text, substituting only new characters.
  async function drawGlyphPreserving(
    page: PDFPage,
    pp: Paragraph,
    baseRec: FontRec | undefined,
    getStd: (k: StandardFonts) => Promise<PDFFont>,
  ): Promise<void> {
    const bold = baseRec ? baseRec.bold || !!baseRec.synthBold : false;
    const italic = baseRec ? baseRec.italic : false;
    const std = await getStd(standardFont(pp.family, bold, italic));
    const measure = (ch: string, sz: number): number => {
      try {
        return std.widthOfTextAtSize(ch, sz);
      } catch {
        return sz * 0.5;
      }
    };
    const edited = blockText(pp.el);
    const segs = planEditedBlock(
      pp.anchorText,
      pp.anchors,
      edited,
      { x: pp.x, firstBaseline: pp.firstBaseline, lineHeight: pp.lineHeight, width: pp.w, align: pp.align, size: pp.size },
      measure,
      pp.color,
    );
    for (const s of segs) {
      if (s.kind === "glyph") {
        // /<fontRes> <size> Tf  1 0 0 1 x y Tm  <codes> Tj  — original glyphs, verbatim.
        page.pushOperators(
          pushGraphicsState(),
          beginText(),
          setFillingRgbColor(s.color.r, s.color.g, s.color.b),
          setFontAndSize(s.fontRes, s.size),
          setTextMatrix(1, 0, 0, 1, s.x, s.y),
          showText(PDFHexString.of(s.hex)),
          endText(),
          popGraphicsState(),
        );
      } else if (s.text.trim() !== "") {
        try {
          page.drawText(s.text, { x: s.x, y: s.y, size: s.size, font: std, color: rgb(s.color.r, s.color.g, s.color.b) });
        } catch {
          /* glyph not encodable in the substitute font */
        }
      }
    }
  }

  // Tategaki export: lay characters down each column (y decreasing by the glyph size),
  // columns marching right-to-left by the column pitch. A <br> (brAfter) starts a new
  // column; a column that would overflow the block's bottom wraps to the next one left.
  async function drawVerticalRuns(
    page: PDFPage,
    pp: Paragraph,
    runs: StyledRun[],
    resolveToken: (run: StyledRun, part: string, space: boolean) => Promise<{ font: PDFFont; text: string; faux: boolean }>,
  ): Promise<void> {
    const glyphs = layoutVerticalGlyphs(runs, {
      startX: pp.vStartX ?? pp.x,
      topY: pp.vTopY ?? pp.topY,
      pitch: pp.vPitch ?? pp.size * 1.6,
      bottom: (pp.vBottomY ?? pp.bottomY) + pp.size * 0.1,
    });
    for (const gph of glyphs) {
      const run = runs[gph.runIndex]!;
      const { font, text } = await resolveToken(run, gph.ch, false);
      try {
        page.drawText(text, { x: gph.x, y: gph.y, size: run.size, font, color: rgb(run.color.r, run.color.g, run.color.b) });
      } catch {
        /* glyph not encodable in the resolved font */
      }
    }
  }

  async function drawRuns(
    pdf: PDFDocument,
    page: PDFPage,
    pp: Paragraph,
    runs: StyledRun[],
    resolveToken: (run: StyledRun, part: string, space: boolean) => Promise<{ font: PDFFont; text: string; faux: boolean }>,
  ): Promise<void> {
    // Tokenize runs into words/spaces, resolving a font per token.
    const toks: Tok[] = [];
    const lineBreaks: number[] = [];
    for (const run of runs) {
      const parts = run.text.split(/(\s+)/);
      for (const part of parts) {
        if (part === "") continue;
        const space = /^\s+$/.test(part);
        const { font, text, faux } = await resolveToken(run, part, space);
        let w = 0;
        try {
          w = font.widthOfTextAtSize(text, run.size);
        } catch {
          w = run.size * text.length * 0.5;
        }
        toks.push({ text, run, font, w, space, faux });
      }
      if (run.brAfter) lineBreaks.push(toks.length);
    }

    // Wrap into lines.
    const lines: Tok[][] = [];
    let cur: Tok[] = [];
    let curW = 0;
    const flush = () => {
      while (cur.length && cur[cur.length - 1]!.space) cur.pop();
      lines.push(cur);
      cur = [];
      curW = 0;
    };
    toks.forEach((t, i) => {
      if (lineBreaks.includes(i)) flush();
      if (!t.space && cur.length && curW + t.w > pp.w) flush();
      if (t.space && cur.length === 0) return;
      cur.push(t);
      curW += t.w;
    });
    if (cur.length) flush();

    const lastIdx = lines.length - 1;
    let y = pp.firstBaseline;
    lines.forEach((line, li) => {
      const lineW = line.reduce((a, t) => a + t.w, 0);
      const lineSize = Math.max(pp.size, ...line.map((t) => t.run.size));
      let x = pp.x;
      let spaceExtra = 0;
      if (pp.align === "center") x = pp.x + (pp.w - lineW) / 2;
      else if (pp.align === "right") x = pp.x + pp.w - lineW;
      else if (pp.align === "justify" && li !== lastIdx) {
        const nSpaces = line.filter((t) => t.space).length;
        if (nSpaces > 0 && pp.w > lineW) spaceExtra = (pp.w - lineW) / nSpaces;
      }
      for (const t of line) {
        if (!t.space) {
          try {
            const col = rgb(t.run.color.r, t.run.color.g, t.run.color.b);
            page.drawText(t.text, { x, y, size: t.run.size, font: t.font, color: col });
            // Faux bold: redraw with a small horizontal offset to thicken the strokes.
            if (t.faux) page.drawText(t.text, { x: x + Math.max(t.run.size * 0.03, 0.2), y, size: t.run.size, font: t.font, color: col });
          } catch {
            /* glyph not encodable */
          }
          if (t.run.href) {
            addLink(pdf, page, x, y - t.run.size * 0.2, t.w, t.run.size * 1.1, t.run.href);
          }
        }
        x += t.w + (t.space ? spaceExtra : 0);
      }
      y -= Math.max(pp.lineHeight, lineSize * 1.15);
    });
  }

  function addLink(pdf: PDFDocument, page: PDFPage, x: number, y: number, w: number, h: number, url: string): void {
    try {
      const annot = pdf.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [x, y, x + w, y + h],
        Border: [0, 0, 0],
        A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
      });
      const ref = pdf.context.register(annot);
      let annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
      if (!annots) {
        annots = pdf.context.obj([]) as PDFArray;
        page.node.set(PDFName.of("Annots"), annots);
      }
      annots.push(ref);
    } catch (e) {
      console.error("[pdfedit] link annot failed", e);
    }
  }
}
