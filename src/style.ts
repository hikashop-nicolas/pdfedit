// Text styling: font-family classification, colour conversion, and parsing an edited
// contenteditable block into styled runs. Extracted from index.ts so the export-side run
// logic (the inverse of reflow's read-side grouping) is unit-testable in isolation.
import { StandardFonts } from "pdf-lib";
import type { RGB } from "./glyph-edit";

export type Family = "sans" | "serif" | "mono";

/** A styled text run parsed from a paragraph block on export. */
export interface StyledRun {
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

// Order matters: check mono and sans before serif, because the CSS keyword
// "sans-serif" contains "serif" and would otherwise be misread as a serif font.
export const familyOf = (n: string): Family =>
  /courier|mono|consol|menlo/i.test(n)
    ? "mono"
    : /sans|arial|helvetica|verdana|tahoma|segoe|calibri|roboto|system-ui|-apple-system/i.test(n)
      ? "sans"
      : /times|georgia|serif|roman|minion|garamond|cambria|century|palatino|bookman|schoolbook|baskerville|caslon|didot|book antiqua/i.test(n)
        ? "serif"
        : "sans";
export const cssFamily = (f: Family): string =>
  f === "serif" ? "Times New Roman, serif" : f === "mono" ? "monospace" : "Helvetica, Arial, sans-serif";

export function standardFont(f: Family, bold: boolean, italic: boolean): StandardFonts {
  if (f === "serif")
    return bold && italic ? StandardFonts.TimesRomanBoldItalic : bold ? StandardFonts.TimesRomanBold : italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman;
  if (f === "mono")
    return bold && italic ? StandardFonts.CourierBoldOblique : bold ? StandardFonts.CourierBold : italic ? StandardFonts.CourierOblique : StandardFonts.Courier;
  return bold && italic ? StandardFonts.HelveticaBoldOblique : bold ? StandardFonts.HelveticaBold : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
}

export const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
export const hex2 = (n: number): string => clamp255(n).toString(16).padStart(2, "0");
export const rgb255ToHex = (c: RGB): string => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
export const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Block-level tags a contenteditable can wrap a new line in (Chrome's Enter inserts <div>),
// each of which starts a new visual line just like a <br>.
export const BLOCK_TAGS = new Set(["DIV", "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "SECTION", "ARTICLE", "UL", "OL", "PRE"]);

// Current text of an edited block, with a "\n" for each <br> and before each block element
// (matches how anchorText was captured at render), for diffing against the original on export.
export const blockText = (el: HTMLElement): string => {
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

let colorProbe: HTMLDivElement | null = null;
export function cssColorToRgb(str: string, fallback: RGB): RGB {
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

// Map common typographic glyphs onto their WinAnsi equivalents (the standard fonts
// cover Latin-1 + cp1252 punctuation only).
export function normalizeStd(s: string): string {
  return s
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[   ]/g, " ")
    .replace(/[•]/g, "-");
}
// Characters no standard font can encode; dropping them keeps drawText from throwing
// (which would leave an empty cover box). The export tries the fallback font first.
// eslint-disable-next-line no-control-regex
export const STD_DROP_RE = /[^ -ÿ€ŒœŽžŠšŸ]/g;

export const norm = (c: RGB): RGB => ({ r: c.r / 255, g: c.g / 255, b: c.b / 255 });

/** Parse a paragraph block's rich HTML into styled runs (sizes in pt). */
export function parseRuns(el: HTMLElement, base: { bold: boolean; italic: boolean; family: Family; size: number; color: RGB; fontKey?: string }, scale: number): StyledRun[] {
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
