// Bridge between pdf-lib (which holds the raw PDF structure) and the content-stream engine.
// Decodes a page's content stream and builds per-font advance metrics from the font dicts,
// then lays out every glyph with its original font resource, byte code and user-space
// position. Used to anchor the editable text to the original glyphs.

import { PDFArray, PDFDict, type PDFDocument, PDFName, PDFNumber, decodePDFRawStream } from "pdf-lib";
import { type FontMetrics, layoutGlyphs, type PlacedGlyph } from "./content-stream";

function decodedContent(page: ReturnType<PDFDocument["getPage"]>): string {
  const Contents = page.node.Contents();
  const dec = (s: unknown): Uint8Array => decodePDFRawStream(s as never).decode();
  if (Contents instanceof PDFArray) {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < Contents.size(); i++) {
      parts.push(dec(Contents.lookup(i)));
      parts.push(new Uint8Array([0x0a]));
    }
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return bytesToLatin1(out);
  }
  if (!Contents) return "";
  return bytesToLatin1(dec(Contents));
}

const bytesToLatin1 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};

function buildMetrics(page: ReturnType<PDFDocument["getPage"]>): Record<string, FontMetrics> {
  const out: Record<string, FontMetrics> = {};
  const res = page.node.Resources();
  if (!res) return out;
  const fontDict = res.lookupMaybe(PDFName.of("Font"), PDFDict);
  if (!fontDict) return out;
  const ctx = page.node.context;
  const num = (x: unknown): number | undefined => (x instanceof PDFNumber ? x.asNumber() : undefined);
  for (const [key, ref] of fontDict.entries()) {
    const name = key.toString().slice(1); // "/F1" -> "F1"
    try {
      const fd = ctx.lookup(ref) as PDFDict;
      const sub = fd.lookup(PDFName.of("Subtype"))?.toString();
      if (sub === "/Type0") {
        const desc = fd.lookup(PDFName.of("DescendantFonts"), PDFArray);
        const cf = ctx.lookup(desc.get(0)) as PDFDict;
        const dw = num(cf.lookup(PDFName.of("DW"))) ?? 1000;
        const W = cf.lookup(PDFName.of("W"));
        const wm = new Map<number, number>();
        if (W instanceof PDFArray) {
          let i = 0;
          while (i < W.size()) {
            const c = num(ctx.lookup(W.get(i)));
            const nx = ctx.lookup(W.get(i + 1));
            if (c == null) break;
            if (nx instanceof PDFArray) {
              for (let j = 0; j < nx.size(); j++) wm.set(c + j, num(ctx.lookup(nx.get(j))) ?? dw);
              i += 2;
            } else {
              const cl = num(nx);
              const w = num(ctx.lookup(W.get(i + 2)));
              if (cl == null || w == null) break;
              for (let cc = c; cc <= cl; cc++) wm.set(cc, w);
              i += 3;
            }
          }
        }
        out[name] = { bytesPerCode: 2, width: (code) => wm.get(code) ?? dw };
      } else {
        const fc = num(fd.lookup(PDFName.of("FirstChar"))) ?? 0;
        const Wd = fd.lookup(PDFName.of("Widths"));
        const arr: number[] = [];
        if (Wd instanceof PDFArray) for (let i = 0; i < Wd.size(); i++) arr.push(num(ctx.lookup(Wd.get(i))) ?? 0);
        // A code outside (or absent) the Widths array must not anchor at width 0, or every
        // glyph would stack on the same x. Fall back to the descriptor's MissingWidth, else a
        // typical advance. An explicit 0 in Widths is kept (only a missing entry falls back).
        let missing = 500;
        const fdesc = ctx.lookupMaybe(fd.lookup(PDFName.of("FontDescriptor")), PDFDict);
        const mw = fdesc ? num(fdesc.lookup(PDFName.of("MissingWidth"))) : undefined;
        if (mw != null) missing = mw;
        out[name] = { bytesPerCode: 1, width: (code) => arr[code - fc] ?? missing };
      }
    } catch {
      /* skip a font we can't read; its glyphs just won't be anchored */
    }
  }
  return out;
}

// Fill alpha (/ca) per ExtGState resource, so a fully-transparent OCR text layer reads as
// invisible in the layout pass.
function buildAlpha(page: ReturnType<PDFDocument["getPage"]>): Record<string, number> {
  const out: Record<string, number> = {};
  const res = page.node.Resources();
  const gsDict = res?.lookupMaybe(PDFName.of("ExtGState"), PDFDict);
  if (!gsDict) return out;
  const ctx = page.node.context;
  for (const [key, ref] of gsDict.entries()) {
    try {
      const gs = ctx.lookup(ref) as PDFDict;
      const ca = gs.lookup(PDFName.of("ca"));
      if (ca instanceof PDFNumber) out[key.toString().slice(1)] = ca.asNumber();
    } catch {
      /* skip an ExtGState we can't read */
    }
  }
  return out;
}

/** Placed glyphs (font resource, byte code, user-space position) for one page. */
export function pageGlyphs(pdf: PDFDocument, pageIndex: number): PlacedGlyph[] {
  const page = pdf.getPage(pageIndex);
  const metrics = buildMetrics(page);
  const alpha = buildAlpha(page);
  return layoutGlyphs(decodedContent(page), (r) => metrics[r], (n) => alpha[n]);
}
