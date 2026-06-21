import * as pdfjsLib from "pdfjs-dist";
import fontkit from "@pdf-lib/fontkit";
import { PDFArray, PDFDocument, type PDFFont, PDFName, type PDFPage, PDFString, StandardFonts, rgb } from "pdf-lib";

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
}
export interface PdfEditor {
  getBytes(): Promise<Uint8Array>;
  isDirty(): boolean;
  destroy(): void;
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
interface RunItem {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
  fontName: string;
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
    .pdfedit-root {
      flex:1; min-height:0; overflow:auto; box-sizing:border-box;
      display:flex; flex-direction:column; align-items:center; gap:16px; padding:16px; background:#525659;
    }
    .pdfedit-page { position:relative; background:#fff; box-shadow:0 2px 10px rgba(0,0,0,.45); }
    .pdfedit-page canvas { display:block; }
    .pdfedit-para {
      position:absolute; box-sizing:border-box; cursor:text; outline:none;
      color:var(--c,#000); opacity:0; white-space:pre-wrap; word-break:break-word; overflow:visible;
    }
    .pdfedit-para:focus, .pdfedit-para.pdfedit-edited { opacity:1; background:var(--bg,#fff); }
    .pdfedit-para:focus { box-shadow:0 0 0 2px #6e7bff; }
    .pdfedit-img { position:absolute; cursor:move; outline:1px dashed rgba(110,123,255,.9); }
    .pdfedit-img img { display:block; width:100%; height:auto; pointer-events:none; }
    .pdfedit-img-handle {
      position:absolute; right:-7px; bottom:-7px; width:14px; height:14px; box-sizing:border-box;
      background:#6e7bff; border:2px solid #fff; border-radius:3px; cursor:nwse-resize;
    }
    .pdfedit-img-del {
      position:absolute; right:-9px; top:-9px; width:18px; height:18px; box-sizing:border-box;
      background:#e4484f; color:#fff; border:2px solid #fff; border-radius:50%; cursor:pointer;
      font:700 12px/14px system-ui, sans-serif; text-align:center;
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
const rgb01ToHex = (c: RGB): string => `#${hex2(c.r * 255)}${hex2(c.g * 255)}${hex2(c.b * 255)}`;
const parseRgbToHex = (s: string): string => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s);
  return m ? `#${hex2(+m[1]!)}${hex2(+m[2]!)}${hex2(+m[3]!)}` : "#000000";
};
const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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

function buildLines(items: RunItem[]): Line[] {
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= last.size * 0.4) {
      last.items.push(it);
      last.minX = Math.min(last.minX, it.x);
      last.maxX = Math.max(last.maxX, it.x + it.w);
      last.size = Math.max(last.size, it.size);
    } else lines.push({ items: [it], y: it.y, minX: it.x, maxX: it.x + it.w, size: it.size, text: "" });
  }
  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);
    ln.text = ln.items.map((i) => i.str).join("");
  }
  return lines;
}

// Group lines into paragraphs. The key is telling a soft wrap (same paragraph) from a
// paragraph break: calibrate to the document's actual line spacing (median gap) instead
// of a fixed multiple of font size, and also break on a size change or a first-line
// indent relative to the running paragraph.
function buildParagraphs(items: RunItem[]): Line[][] {
  const lines = buildLines(items);
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1]!.y - lines[i]!.y;
    if (g > 1) gaps.push(g);
  }
  const medGap = median(gaps);
  const paras: Line[][] = [];
  for (const ln of lines) {
    const group = paras[paras.length - 1];
    const prev = group?.[group.length - 1];
    if (!group || !prev) {
      paras.push([ln]);
      continue;
    }
    const gap = prev.y - ln.y;
    const spacing = medGap > 0 ? medGap : prev.size * 1.2;
    const sizeClose = Math.abs(prev.size - ln.size) <= prev.size * 0.3;
    const groupLeft = Math.min(...group.map((l) => l.minX));
    const gapBreak = gap > spacing * 1.5;
    const indentBreak = ln.minX > groupLeft + prev.size * 0.9;
    if (gap > 0 && sizeClose && !gapBreak && !indentBreak) group.push(ln);
    else paras.push([ln]);
  }
  return paras;
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
  const pageEls: { el: HTMLElement; viewport: pdfjsLib.PageViewport; index: number }[] = [];
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
  const faces = new Map<string, FontFace>();
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
        const f = page.commonObjs.get(fontName) as { name?: string; type?: string; bold?: boolean; italic?: boolean; black?: boolean; data?: Uint8Array | ArrayBuffer };
        const nm = String(f?.name ?? "");
        baseName = nm.replace(/^[A-Z]{6}\+/, "");
        isType3 = f?.type === "Type3";
        // Prefer pdf.js's own flags (from the font's OS/2 / descriptor), which work even
        // when a subset font name omits "Bold"/"Italic"; fall back to the name.
        bold = f?.bold === true || f?.black === true || /bold|black|semibold|heavy/i.test(nm);
        italic = f?.italic === true || /italic|oblique/i.test(nm);
        family = familyOf(nm);
        if (f?.data) {
          const d = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
          if (d.length) {
            data = d;
            cssName = registerFace(fontName, d);
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

  injectStyles();
  const wrap = document.createElement("div");
  wrap.className = "pdfedit-wrap";
  const toolbar = buildToolbar();
  const root = document.createElement("div");
  root.className = "pdfedit-root";
  wrap.append(toolbar.el, root);
  container.appendChild(wrap);

  // Track the selection inside a paragraph so toolbar controls that steal focus
  // (color/font/size pickers) can restore it before applying, and reflect the caret's
  // style back into the toolbar fields.
  const onSelChange = () => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    const elx = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
    if (!elx || !root.contains(elx)) return;
    const paraEl = elx.closest(".pdfedit-para");
    if (!paraEl) return;
    savedRange = r.cloneRange();
    const para = paragraphs.find((p) => p.el === paraEl) ?? null;
    if (para) {
      savedPara = para;
      activePara = para;
    }
    const cs = getComputedStyle(elx);
    toolbar.update({ sizePt: parseFloat(cs.fontSize) / scale, family: familyOf(cs.fontFamily), colorHex: parseRgbToHex(cs.color) });
  };
  document.addEventListener("selectionchange", onSelChange);

  function buildToolbar() {
    const el = document.createElement("div");
    el.className = "pdfedit-toolbar";
    const keepSel = (b: HTMLElement) => b.addEventListener("mousedown", (e) => e.preventDefault());
    const exec = (cmd: string, val?: string) => document.execCommand(cmd, false, val);
    const wrapSel = (styleText: string) => {
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const span = document.createElement("span");
      span.setAttribute("style", styleText);
      try {
        range.surroundContents(span);
      } catch {
        span.appendChild(range.extractContents());
        range.insertNode(span);
      }
    };
    // Restore the saved paragraph selection, run the styling op, mark dirty.
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

    const textBtn = (label: string, title: string, css: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      if (css) b.style.cssText = css;
      b.addEventListener("click", () => withSel(fn));
      keepSel(b);
      return b;
    };
    const iconBtn = (svg: string, title: string, fn: () => void) => {
      const b = document.createElement("button");
      b.innerHTML = svg;
      b.title = title;
      b.addEventListener("click", () => withSel(fn));
      keepSel(b);
      return b;
    };
    const sep = () => {
      const s = document.createElement("span");
      s.className = "sep";
      return s;
    };

    el.append(
      textBtn("B", "Bold", "font-weight:bold", () => exec("bold")),
      textBtn("I", "Italic", "font-style:italic", () => exec("italic")),
    );

    const color = document.createElement("input");
    color.type = "color";
    color.title = "Text color";
    color.value = "#000000";
    color.addEventListener("change", () => withSel(() => exec("foreColor", color.value)));
    el.append(color);

    const font = document.createElement("select");
    font.title = "Font";
    for (const [v, label] of [["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"]] as const) {
      font.add(new Option(label, v));
    }
    font.addEventListener("change", () => withSel(() => wrapSel(`font-family:${cssFamily(font.value as Family)}`)));
    el.append(font);

    const size = document.createElement("input");
    size.type = "number";
    size.min = "4";
    size.max = "300";
    size.title = "Font size (pt)";
    size.addEventListener("change", () => {
      if (size.value) withSel(() => wrapSel(`font-size:${(Number(size.value) * scale).toFixed(2)}px`));
    });
    el.append(size);

    el.append(
      sep(),
      iconBtn(ICON.left, "Align left", () => setAlign("left")),
      iconBtn(ICON.center, "Align center", () => setAlign("center")),
      iconBtn(ICON.right, "Align right", () => setAlign("right")),
      iconBtn(ICON.justify, "Justify", () => setAlign("justify")),
      sep(),
    );

    const linkBtn = document.createElement("button");
    linkBtn.textContent = "Link";
    linkBtn.title = "Add/edit link";
    keepSel(linkBtn);
    linkBtn.addEventListener("click", () => {
      const url = prompt("Link URL (empty to remove):", "https://");
      if (url === null) return;
      withSel(() => {
        if (url === "") exec("unlink");
        else exec("createLink", url);
      });
    });
    el.append(linkBtn);

    const imgBtn = document.createElement("button");
    imgBtn.textContent = "Image";
    imgBtn.title = "Insert image";
    keepSel(imgBtn);
    imgBtn.addEventListener("click", () => imageInput.click());
    el.append(imgBtn);

    const imageInput = document.createElement("input");
    imageInput.type = "file";
    imageInput.accept = "image/png,image/jpeg";
    imageInput.style.display = "none";
    imageInput.addEventListener("change", () => {
      const f = imageInput.files?.[0];
      if (f) void insertImage(f);
      imageInput.value = "";
    });
    el.append(imageInput);

    const update = (o: { sizePt?: number; family?: Family; colorHex?: string }) => {
      if (o.sizePt != null && isFinite(o.sizePt)) size.value = String(Math.round(o.sizePt));
      if (o.family) font.value = o.family;
      if (o.colorHex) color.value = o.colorHex;
    };
    return { el, update };
  }

  function setAlign(a: Align): void {
    if (!activePara) return;
    activePara.align = a;
    activePara.el.style.textAlign = a;
    activePara.dirty = true;
    activePara.el.classList.add("pdfedit-edited");
    change();
  }

  async function insertImage(file: File): Promise<void> {
    const target = pageEls[0];
    if (!target) return;
    const bytesImg = new Uint8Array(await file.arrayBuffer());
    const box = document.createElement("div");
    box.className = "pdfedit-img";
    box.style.left = "40px";
    box.style.top = "40px";
    box.style.width = "160px";
    const img = document.createElement("img");
    img.src = URL.createObjectURL(new Blob([bytesImg as BlobPart], { type: file.type }));
    img.draggable = false;
    const handle = document.createElement("div");
    handle.className = "pdfedit-img-handle";
    handle.title = "Drag to resize";
    const del = document.createElement("div");
    del.className = "pdfedit-img-del";
    del.textContent = "×";
    del.title = "Delete image";
    box.append(img, handle, del);
    target.el.appendChild(box);
    const rec: ImageItem = { page: target.index, bytes: bytesImg, mime: file.type, xPdf: 0, yPdf: 0, wPdf: 0, hPdf: 0, el: box };
    images.push(rec);
    img.addEventListener("load", () => updateImageRect(rec, target.viewport), { once: true });
    makeDraggable(box);
    makeResizable(box, handle, rec);
    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      box.remove();
      const i = images.indexOf(rec);
      if (i >= 0) images.splice(i, 1);
      change();
    });
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
    for (let p = 1; p <= doc.numPages && !destroyed; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale });
      const pageW = page.getViewport({ scale: 1 }).width;
      const pageEl = document.createElement("div");
      pageEl.className = "pdfedit-page";
      pageEl.style.width = `${viewport.width}px`;
      pageEl.style.height = `${viewport.height}px`;
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const cctx = canvas.getContext("2d");
      if (cctx) await page.render({ canvasContext: cctx, viewport, canvas }).promise;
      pageEl.appendChild(canvas);
      pageEls.push({ el: pageEl, viewport, index: p - 1 });

      const content = await page.getTextContent();
      const allItems: RunItem[] = [];
      for (const item of content.items) {
        if (!("str" in item) || item.str === "") continue;
        const t = item.transform as number[];
        allItems.push({ str: item.str, x: t[4]!, y: t[5]!, w: item.width ?? 0, size: Math.hypot(t[2]!, t[3]!) || 10, fontName: item.fontName });
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

      for (const lines of buildParagraphs(items)) {
        const first = lines[0]!;
        if (lines.every((l) => l.text.trim() === "")) continue;
        const boxX = Math.min(...lines.map((l) => l.minX));
        const boxRight = Math.max(...lines.map((l) => l.maxX));
        const size = first.size;
        const lineHeight = lines.length >= 2 ? Math.abs(lines[0]!.y - lines[1]!.y) || size * 1.2 : size * 1.2;
        const topY = first.y + size * 0.85;
        const bottomY = lines[lines.length - 1]!.y - size * 0.3;
        const align = detectAlign(lines, boxX, boxRight, pageW);
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
          for (const it of ln.items) {
            if (it.str === "") continue;
            const rec = getFontRec(page, it.fontName);
            fontCount.set(it.fontName, (fontCount.get(it.fontName) ?? 0) + it.str.length);
            const szR = Math.round(it.size * 10) / 10;
            // Key by font identity (not just detected style) so a differently-fonted run,
            // e.g. a bold subset whose name omits "Bold", still gets its own span and its
            // own original font on export.
            const key = `${it.fontName}|${szR}`;
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
          }
          if (li !== lastLi) curText += " ";
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
        };
        el.addEventListener("focus", () => {
          activePara = para;
          savedPara = para;
          toolbar.update({ sizePt: para.size, family: para.family, colorHex: rgb01ToHex(para.color) });
        });
        el.addEventListener("input", () => {
          para.dirty = true;
          el.classList.add("pdfedit-edited");
          change();
        });
        pageEl.appendChild(el);
        paragraphs.push(para);
      }
      root.appendChild(pageEl);
    }
    upgradeOverlayFonts();
  })().catch((e: unknown) => console.error("[pdfedit] render failed", e));

  return {
    isDirty() {
      return images.length > 0 || paragraphs.some((p) => p.dirty);
    },
    async getBytes() {
      const editedParas = paragraphs.filter((p) => p.dirty);
      if (editedParas.length === 0 && images.length === 0) return original.slice();
      const pdf = await PDFDocument.load(original.slice());
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
        if (space) return { font: emb ?? std, text: " ", faux: false };
        if (emb && covers(emb, part)) {
          // Faux-bold when the run is bold but the reused font isn't an actual bold font.
          const embBold = !!(embKey && fontRecs.get(embKey)?.bold);
          return { font: emb, text: part, faux: run.bold && !embBold };
        }
        return { font: std, text: sanitizeStd(part), faux: false };
      };

      for (const pp of editedParas) {
        const page = pages[pp.page];
        if (!page) continue;
        page.drawRectangle({ x: pp.x, y: pp.bottomY, width: Math.max(pp.w, 1), height: Math.max(pp.topY - pp.bottomY, 1), color: rgb(pp.bg.r, pp.bg.g, pp.bg.b) });
        // Fallback for text typed directly in the block (outside any span): the paragraph's
        // dominant font, so stray text exports in the document font, not a generic one.
        const baseRec = fontRecs.get(pp.baseFontKey);
        const base = {
          bold: baseRec ? baseRec.bold || !!baseRec.synthBold : false,
          italic: baseRec ? baseRec.italic : false,
          family: pp.family,
          size: pp.size,
          color: pp.color,
          fontKey: baseRec ? pp.baseFontKey : undefined,
        };
        const runs = parseRuns(pp.el, base, scale);
        await drawRuns(pdf, page, pp, runs, resolveToken);
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
