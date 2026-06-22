import * as pdfjsLib from "pdfjs-dist";
import fontkit from "@pdf-lib/fontkit";
import { beginText, endText, PDFArray, PDFDocument, PDFHexString, PDFName, PDFString, popGraphicsState, pushGraphicsState, setFillingRgbColor, setFontAndSize, setTextMatrix, showText, StandardFonts, rgb, } from "pdf-lib";
import {} from "./content-stream";
import { planEditedBlock } from "./glyph-edit";
import { pageGlyphs } from "./pdf-glyphs";
const ICON = {
    left: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 3.5h12M2 6.8h8M2 10.1h11M2 13.4h6"/></svg>`,
    center: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 3.5h12M4 6.8h8M3 10.1h10M5 13.4h6"/></svg>`,
    right: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 3.5h12M6 6.8h8M3 10.1h11M8 13.4h6"/></svg>`,
    justify: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 3.5h12M2 6.8h12M2 10.1h12M2 13.4h6"/></svg>`,
};
const STYLE_ID = "pdfedit-style";
function injectStyles() {
    if (document.getElementById(STYLE_ID))
        return;
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
    .pdfedit-toolbar .pdfedit-zoom { display:inline-flex; align-items:center; gap:6px; }
    .pdfedit-toolbar input[type=range] { width:110px; cursor:pointer; accent-color:#6e7bff; }
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
const familyOf = (n) => /courier|mono|consol|menlo/i.test(n)
    ? "mono"
    : /sans|arial|helvetica|verdana|tahoma|segoe|calibri|roboto|system-ui|-apple-system/i.test(n)
        ? "sans"
        : /times|georgia|serif|roman|minion|garamond|cambria|century|palatino|bookman|schoolbook|baskerville|caslon|didot|book antiqua/i.test(n)
            ? "serif"
            : "sans";
const cssFamily = (f) => f === "serif" ? "Times New Roman, serif" : f === "mono" ? "monospace" : "Helvetica, Arial, sans-serif";
function standardFont(f, bold, italic) {
    if (f === "serif")
        return bold && italic ? StandardFonts.TimesRomanBoldItalic : bold ? StandardFonts.TimesRomanBold : italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman;
    if (f === "mono")
        return bold && italic ? StandardFonts.CourierBoldOblique : bold ? StandardFonts.CourierBold : italic ? StandardFonts.CourierOblique : StandardFonts.Courier;
    return bold && italic ? StandardFonts.HelveticaBoldOblique : bold ? StandardFonts.HelveticaBold : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
}
const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));
const hex2 = (n) => clamp255(n).toString(16).padStart(2, "0");
const rgb255ToHex = (c) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Symbol-flagged subset fonts with no ToUnicode CMap map each byte c to glyph U+F000+c
// (the (3,0) "symbol" cmap convention). pdf.js returns those Private Use Area code points
// verbatim, so the editable overlay renders them as tofu (squares). Map the F0xx range
// back to its low byte to recover readable text (e.g. U+F04D -> "M").
const normalizePua = (s) => {
    if (!/[\uF000-\uF0FF]/.test(s))
        return s;
    let out = "";
    for (const ch of s) {
        const cp = ch.charCodeAt(0);
        out += cp >= 0xf001 && cp <= 0xf0ff ? String.fromCharCode(cp - 0xf000) : ch;
    }
    return out;
};
// Re-encode normalized text back to the symbol font's Private Use Area codes (the inverse
// of normalizePua) so a reused embedded symbol font finds its glyphs on export.
const toPua = (s) => {
    let out = "";
    for (const ch of s) {
        const cp = ch.charCodeAt(0);
        out += cp >= 0x20 && cp <= 0xff ? String.fromCharCode(0xf000 + cp) : ch;
    }
    return out;
};
// Plausible advance width of a text item. Some subset fonts report garbage widths (many
// times the page width); fall back to an estimate so one bad item can't distort layout.
const itemWidth = (it) => {
    const plausible = it.str.length * it.size * 1.5 + it.size;
    return it.w > 0 && it.w <= plausible ? it.w : it.str.length * it.size * 0.5;
};
// Whether to insert a space between two items: a positional gap (adjacent label/value with
// no space char), or a strong overlap (distinct text pieces laid over each other), but not
// when whitespace already borders the seam.
const wantSpace = (gap, size, before, next) => (gap > size * 0.2 || gap < -size * 0.5) && before !== "" && !/\s$/.test(before) && !/^\s/.test(next);
// Join items on one line, inserting spaces per wantSpace (PDFs often emit adjacent runs,
// e.g. a label and a value, with no space char between them).
const joinItems = (items) => {
    let text = "";
    let prevEnd = -Infinity;
    for (const it of items) {
        if (prevEnd > -Infinity && wantSpace(it.x - prevEnd, it.size, text, it.str))
            text += " ";
        text += it.str;
        prevEnd = it.x + itemWidth(it);
    }
    return text;
};
const colorDist = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
// Block-level tags a contenteditable can wrap a new line in (Chrome's Enter inserts <div>),
// each of which starts a new visual line just like a <br>.
const BLOCK_TAGS = new Set(["DIV", "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "SECTION", "ARTICLE", "UL", "OL", "PRE"]);
// Current text of an edited block, with a "\n" for each <br> and before each block element
// (matches how anchorText was captured at render), for diffing against the original on export.
const blockText = (el) => {
    let out = "";
    const walk = (node) => {
        for (const ch of Array.from(node.childNodes)) {
            if (ch.nodeType === 3)
                out += ch.textContent ?? "";
            else if (ch.nodeName === "BR")
                out += "\n";
            else if (ch.nodeType === 1) {
                if (BLOCK_TAGS.has(ch.tagName) && out !== "" && !out.endsWith("\n"))
                    out += "\n";
                walk(ch);
            }
        }
    };
    walk(el);
    return out;
};
let colorProbe = null;
function cssColorToRgb(str, fallback) {
    if (!str)
        return fallback;
    if (!colorProbe) {
        colorProbe = document.createElement("div");
        colorProbe.style.display = "none";
        document.body.appendChild(colorProbe);
    }
    colorProbe.style.color = "";
    colorProbe.style.color = str;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(colorProbe).color);
    if (!m)
        return fallback;
    return { r: Number(m[1]) / 255, g: Number(m[2]) / 255, b: Number(m[3]) / 255 };
}
function sampleColors(ctx, x, y, w, h) {
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const sx = Math.max(0, Math.min(Math.floor(x), cw - 1));
    const sy = Math.max(0, Math.min(Math.floor(y), ch - 1));
    const sw = Math.max(1, Math.min(Math.floor(w), cw - sx));
    const sh = Math.max(1, Math.min(Math.floor(h), ch - sy));
    let data;
    try {
        data = ctx.getImageData(sx, sy, sw, sh).data;
    }
    catch {
        return { fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 }, ink: 0 };
    }
    // Background = most common color in the region (robust vs. a corner pixel landing
    // on a glyph). Foreground = the pixel furthest from the background.
    const counts = new Map();
    for (let i = 0; i < data.length; i += 4) {
        if ((data[i + 3] ?? 0) < 128)
            continue;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const key = `${r >> 4},${g >> 4},${b >> 4}`;
        const e = counts.get(key);
        if (e) {
            e.r += r;
            e.g += g;
            e.b += b;
            e.n++;
        }
        else
            counts.set(key, { r, g, b, n: 1 });
    }
    let bg = { r: 255, g: 255, b: 255 };
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
        if ((data[i + 3] ?? 0) < 128)
            continue;
        const dr = data[i] - bg.r;
        const dg = data[i + 1] - bg.g;
        const db = data[i + 2] - bg.b;
        const d = dr * dr + dg * dg + db * db;
        if (d > 8000)
            ink++;
        if (d > best) {
            best = d;
            fg = { r: data[i], g: data[i + 1], b: data[i + 2] };
        }
    }
    return { fg, bg, ink: data.length ? ink / (data.length / 4) : 0 };
}
/** Glyph color and ink coverage of a single run's box, sampled from the rendered canvas. */
function sampleRunStats(ctx, viewport, x, baseY, w, size) {
    const tl = viewport.convertToViewportPoint(x, baseY + size * 0.85);
    const br = viewport.convertToViewportPoint(x + w, baseY - size * 0.2);
    const left = Math.min(tl[0], br[0]);
    const top = Math.min(tl[1], br[1]);
    const dW = Math.abs(br[0] - tl[0]);
    const dH = Math.abs(br[1] - tl[1]);
    const s = sampleColors(ctx, left, top, Math.max(dW, 2), Math.max(dH, 2));
    return { fg: s.fg, ink: s.ink };
}
// Replace characters the standard fonts can't encode so drawText never throws (which
// would leave an empty cover box). WinAnsi covers Latin-1 + cp1252 punctuation; map the
// few common typographic glyphs and drop anything else outside that range.
function sanitizeStd(s) {
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
const norm = (c) => ({ r: c.r / 255, g: c.g / 255, b: c.b / 255 });
const variance = (xs) => {
    if (xs.length < 2)
        return 0;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
};
const median = (xs) => {
    if (xs.length === 0)
        return 0;
    const s = xs.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// A large horizontal gap between items sharing a baseline marks a column / block boundary
// (e.g. a left-aligned footer and a right-aligned page number sit on the same baseline but
// are separate blocks). Gaps wider than this many ems split a baseline into segments.
const COL_GAP_EM = 2.2;
function buildLines(items) {
    // 1) group items into baselines (same y within tolerance)
    const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
    const baselines = [];
    let curY = 0;
    let curSize = 0;
    for (const it of sorted) {
        const base = baselines[baselines.length - 1];
        if (base && Math.abs(curY - it.y) <= Math.max(curSize, it.size) * 0.4) {
            base.push(it);
            curSize = Math.max(curSize, it.size);
        }
        else {
            baselines.push([it]);
            curY = it.y;
            curSize = it.size;
        }
    }
    // 2) split each baseline into segments at large horizontal gaps (a column boundary)
    const lines = [];
    for (const base of baselines) {
        base.sort((a, b) => a.x - b.x);
        let seg = [];
        let segEnd = -Infinity;
        const flush = () => {
            if (!seg.length)
                return;
            lines.push({
                items: seg,
                y: seg[0].y,
                minX: seg[0].x,
                maxX: Math.max(...seg.map((i) => i.x + itemWidth(i))),
                size: Math.max(...seg.map((i) => i.size)),
                text: joinItems(seg),
            });
            seg = [];
        };
        for (const it of base) {
            const em = Math.max(it.size, seg[seg.length - 1]?.size ?? it.size);
            if (seg.length && it.x - segEnd > em * COL_GAP_EM)
                flush();
            seg.push(it);
            segEnd = Math.max(segEnd, it.x + itemWidth(it));
        }
        flush();
    }
    return lines;
}
function buildParagraphs(items, bgOf) {
    const segs = buildLines(items);
    if (!segs.length)
        return [];
    // line-spacing estimate from distinct baselines
    const ys = Array.from(new Set(segs.map((s) => Math.round(s.y)))).sort((a, b) => b - a);
    const gaps = [];
    for (let i = 1; i < ys.length; i++) {
        const g = ys[i - 1] - ys[i];
        if (g > 1)
            gaps.push(g);
    }
    const medGap = median(gaps);
    const bgMap = bgOf ? new Map(segs.map((s) => [s, bgOf(s)])) : null;
    const blocks = [];
    const ordered = segs.slice().sort((a, b) => b.y - a.y || a.minX - b.minX);
    for (const seg of ordered) {
        const spacing = medGap > 0 ? medGap : seg.size * 1.2;
        const segBg = bgMap?.get(seg) ?? null;
        let best = null;
        let bestGap = Infinity;
        for (const b of blocks) {
            const vgap = b.lastY - seg.y;
            if (vgap <= 0 || vgap > spacing * 1.6)
                continue; // not the immediately following line
            if (Math.abs(b.lastSize - seg.size) > b.lastSize * 0.15)
                continue; // size change = new block
            // a clear background change separates blocks (e.g. a shaded table header above a row)
            if (segBg && b.bg && colorDist(segBg, b.bg) > 38)
                continue;
            const overlap = Math.min(seg.maxX, b.right) - Math.max(seg.minX, b.left);
            const minW = Math.min(seg.maxX - seg.minX, b.right - b.left) || 1;
            const aligned = overlap > minW * 0.3 || Math.abs(seg.minX - b.left) <= seg.size;
            if (!aligned)
                continue;
            // a first-line indent inside an otherwise left-flush block starts a new paragraph
            const leftFlush = b.lines.every((l) => Math.abs(l.minX - b.left) <= seg.size);
            if (leftFlush && seg.minX > b.left + seg.size * 1.2)
                continue;
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
        }
        else {
            blocks.push({ lines: [seg], left: seg.minX, right: seg.maxX, lastY: seg.y, lastSize: seg.size, bg: segBg });
        }
    }
    return blocks.map((b) => b.lines);
}
function detectAlign(lines, boxX, boxRight, pageW) {
    const avgSize = lines.reduce((a, l) => a + l.size, 0) / lines.length || 12;
    const tol = avgSize * 0.9;
    const sd = (arr) => Math.sqrt(variance(arr));
    if (lines.length >= 2) {
        const lsd = sd(lines.map((l) => l.minX));
        const csd = sd(lines.map((l) => (l.minX + l.maxX) / 2));
        // The last line of justified text is ragged, so judge the right edge on the body.
        const bodyLines = lines.length >= 3 ? lines.slice(0, -1) : lines;
        const rsd = sd(bodyLines.map((l) => l.maxX));
        const leftFlush = lsd < tol;
        const rightFlush = rsd < tol;
        if (leftFlush && rightFlush)
            return "justify";
        if (rightFlush && !leftFlush)
            return "right";
        if (csd < lsd && csd < rsd)
            return "center";
        return "left";
    }
    const leftM = boxX;
    const rightM = pageW - boxRight;
    if (leftM > pageW * 0.12 && Math.abs(leftM - rightM) < pageW * 0.08)
        return "center";
    if (rightM < pageW * 0.1 && leftM > pageW * 0.2)
        return "right";
    return "left";
}
/** Parse a paragraph block's rich HTML into styled runs (sizes in pt). */
function parseRuns(el, base, scale) {
    const runs = [];
    const walk = (node, st) => {
        for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE) {
                const text = child.textContent ?? "";
                if (text)
                    runs.push({ ...st, text });
            }
            else if (child instanceof HTMLBRElement) {
                const last = runs[runs.length - 1];
                if (last)
                    last.brAfter = true;
                else
                    runs.push({ ...st, text: "", brAfter: true });
            }
            else if (child instanceof HTMLElement) {
                const next = { ...st };
                const tag = child.tagName;
                // A block element (e.g. Chrome's Enter <div>) starts a new line, like a <br>.
                if (BLOCK_TAGS.has(tag)) {
                    const last = runs[runs.length - 1];
                    if (last && !last.brAfter)
                        last.brAfter = true;
                }
                if (child.dataset.font)
                    next.fontKey = child.dataset.font;
                if (tag === "B" || tag === "STRONG")
                    next.bold = true;
                if (tag === "I" || tag === "EM")
                    next.italic = true;
                if (tag === "A")
                    next.href = child.getAttribute("href") ?? st.href;
                const fw = child.style.fontWeight;
                if (fw === "bold" || Number(fw) >= 600)
                    next.bold = true;
                else if (fw === "normal" || (fw && Number(fw) > 0 && Number(fw) < 600))
                    next.bold = false;
                if (child.style.fontStyle === "italic")
                    next.italic = true;
                else if (child.style.fontStyle === "normal")
                    next.italic = false;
                if (child.style.fontFamily)
                    next.family = familyOf(child.style.fontFamily);
                if (child.style.color)
                    next.color = cssColorToRgb(child.style.color, st.color);
                const fsAttr = child.getAttribute("color");
                if (tag === "FONT" && fsAttr)
                    next.color = cssColorToRgb(fsAttr, st.color);
                const fs = child.style.fontSize;
                if (fs.endsWith("px"))
                    next.size = parseFloat(fs) / scale;
                else if (fs.endsWith("pt"))
                    next.size = parseFloat(fs);
                walk(child, next);
            }
        }
    };
    walk(el, { ...base });
    return runs;
}
let instanceSeq = 0;
export function createPdfEditor(container, bytes, options = {}) {
    if (options.workerSrc)
        pdfjsLib.GlobalWorkerOptions.workerSrc = options.workerSrc;
    const scale = options.scale ?? 1.3;
    const original = bytes.slice();
    const paragraphs = [];
    const images = [];
    const pageEls = [];
    let displayZoom = 1; // visual zoom only; render scale and PDF coordinates are unchanged
    const applyZoom = (z) => {
        displayZoom = z;
        for (const p of pageEls)
            p.el.style.zoom = String(z);
    };
    let destroyed = false;
    let activePara = null;
    let savedPara = null;
    let savedRange = null;
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
    const fontRecs = new Map();
    const puaFonts = new Set(); // fonts whose text was Private-Use-Area encoded (symbol cmap)
    const faces = new Map();
    // For fonts whose cmap is unusable in HTML: displayed char -> original glyph id, per pdf.js
    // font, used to build a display-only @font-face that shows the true glyph shapes.
    const displayFontChars = new Map();
    const displayFamilies = new Map();
    const displayCharByGid = new Map();
    let displayCharCounter = 0;
    // A unique BMP Private-Use char (0xE000+) per font+glyph, used as the overlay placeholder
    // for an unreliable glyph so the display font can map it to the real outline without
    // colliding with real text (BMP keeps it one code unit, so anchor alignment holds).
    const displayCharFor = (fontName, gid) => {
        const k = `${fontName}:${gid}`;
        let ch = displayCharByGid.get(k);
        if (!ch) {
            ch = String.fromCharCode(0xe000 + (displayCharCounter++ % 0x1000));
            displayCharByGid.set(k, ch);
        }
        return ch;
    };
    const registerFace = (key, data) => {
        const name = `pf_${uid}_${key.replace(/[^a-zA-Z0-9_]/g, "")}`;
        if (faces.has(name))
            return name;
        try {
            const ff = new FontFace(name, data.slice());
            faces.set(name, ff);
            document.fonts.add(ff);
            ff.load().catch(() => {
                /* font format the browser can't load; the overlay falls back to the CSS family */
            });
            return name;
        }
        catch {
            return undefined;
        }
    };
    const getFontRec = (page, fontName) => {
        const hit = fontRecs.get(fontName);
        if (hit)
            return hit;
        let bold = false;
        let italic = false;
        let family = "sans";
        let baseName = "";
        let isType3 = false;
        let data;
        let cssName;
        try {
            if (page.commonObjs.has(fontName)) {
                const f = page.commonObjs.get(fontName);
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
                            const ft = fontkit.create(d);
                            const weight = ft["OS/2"]?.usWeightClass;
                            const mac = ft.head?.macStyle;
                            if ((typeof weight === "number" && weight >= 600) || mac?.bold)
                                bold = true;
                            if (mac?.italic)
                                italic = true;
                        }
                        catch {
                            /* not a parseable sfnt; keep name/flag-based detection */
                        }
                    }
                }
            }
        }
        catch {
            /* defaults */
        }
        const rec = { bold, italic, family, baseName, isType3, data, cssName };
        fontRecs.set(fontName, rec);
        return rec;
    };
    // A font with no reusable program (e.g. a Type3 font) can borrow a sibling with the
    // same base name that does have one. Returns [loadedName, rec] of the donor.
    const findDonor = (baseName, has) => {
        if (!baseName)
            return undefined;
        for (const [k, r] of fontRecs)
            if (r.baseName === baseName && has(r))
                return [k, r];
        return undefined;
    };
    // Detect "rendered-bolder" fonts: a font whose glyph ink coverage is notably higher
    // than a same-base-name sibling is an emphasized/bold variant even when its name and
    // flags say regular (e.g. a Type3 heading vs the CID body, same "CenturyStd-Book").
    const detectSynthBold = () => {
        const dens = new Map();
        for (const [k, rec] of fontRecs)
            if (rec.inkN)
                dens.set(k, rec.inkSum / rec.inkN);
        const baseMin = new Map();
        for (const [k, rec] of fontRecs) {
            const d = dens.get(k);
            if (d == null)
                continue;
            const b = rec.baseName || k;
            if (!baseMin.has(b) || d < baseMin.get(b))
                baseMin.set(b, d);
        }
        for (const [k, rec] of fontRecs) {
            const d = dens.get(k);
            if (d == null || rec.bold)
                continue;
            const min = baseMin.get(rec.baseName || k);
            if (min != null && min > 0 && d > min * 1.18)
                rec.synthBold = true;
        }
    };
    // After load: spans whose font has no @font-face borrow a sibling's (so the real font
    // shows while editing, e.g. a Type3 font borrowing its CID twin), and synthBold spans
    // get a bold weight so the emphasis is visible and preserved on export.
    const faceFor = (rec) => {
        if (rec.cssName)
            return rec.cssName;
        const donor = rec.baseName ? findDonor(rec.baseName, (r) => !!r.cssName) : undefined;
        return donor?.[1].cssName;
    };
    const upgradeOverlayFonts = () => {
        detectSynthBold();
        for (const para of paragraphs) {
            // Block element (covers stray / newly-typed text) gets the dominant font's face.
            const baseRec = fontRecs.get(para.baseFontKey);
            const baseFace = baseRec ? faceFor(baseRec) : undefined;
            if (baseFace)
                para.el.style.fontFamily = `'${baseFace}', ${para.el.style.fontFamily}`;
            para.el.querySelectorAll("span[data-font]").forEach((span) => {
                const key = span.dataset.font;
                const rec = key ? fontRecs.get(key) : undefined;
                if (!rec)
                    return;
                if (!rec.cssName && rec.baseName) {
                    const donor = findDonor(rec.baseName, (r) => !!r.cssName);
                    if (donor)
                        span.style.fontFamily = `'${donor[1].cssName}', ${span.style.fontFamily}`;
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
    const applyDisplayFonts = async () => {
        if (!displayFontChars.size)
            return;
        let mod;
        try {
            mod = await import("./display-font");
        }
        catch {
            return;
        }
        for (const [fontName, cmap] of displayFontChars) {
            const rec = fontRecs.get(fontName);
            if (!rec?.data || !cmap.size)
                continue;
            const family = `pdfedit_disp_${uid}_${fontName.replace(/[^a-zA-Z0-9_]/g, "")}`;
            let buf = null;
            try {
                buf = mod.buildDisplayFont(rec.data, cmap, family);
            }
            catch {
                buf = null;
            }
            if (!buf)
                continue;
            try {
                const ff = new FontFace(family, buf);
                faces.set(family, ff);
                document.fonts.add(ff);
                await ff.load();
                displayFamilies.set(fontName, family);
            }
            catch {
                /* couldn't load the built font; the span keeps its placeholder text */
            }
        }
        for (const para of paragraphs) {
            para.el.querySelectorAll("span[data-font]").forEach((span) => {
                const fam = span.dataset.font ? displayFamilies.get(span.dataset.font) : undefined;
                if (fam)
                    span.style.fontFamily = `'${fam}', ${span.style.fontFamily}`;
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
    // Highlight the saved selection with the CSS Custom Highlight API so it stays visible
    // when focus moves to a toolbar control (the native highlight only shows while the
    // contenteditable is focused). Falls back to nothing on browsers without the API.
    const cssHL = window.CSS?.highlights;
    const HighlightCtor = window.Highlight;
    const showSavedHighlight = () => {
        try {
            if (!cssHL || !HighlightCtor)
                return;
            if (savedRange && !savedRange.collapsed)
                cssHL.set("pdfedit-sel", new HighlightCtor(savedRange.cloneRange()));
            else
                cssHL.delete("pdfedit-sel");
        }
        catch {
            /* ignore */
        }
    };
    const clearHighlight = () => {
        try {
            cssHL?.delete("pdfedit-sel");
        }
        catch {
            /* ignore */
        }
    };
    const onSelChange = () => {
        const sel = document.getSelection();
        if (!sel || sel.rangeCount === 0)
            return;
        const r = sel.getRangeAt(0);
        const node = r.startContainer;
        const elx = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        if (!elx || !root.contains(elx))
            return;
        const paraEl = elx.closest(".pdfedit-para");
        if (!paraEl)
            return;
        // Only remember a real (non-empty) selection. A collapsed caret, e.g. the one left
        // behind when clicking a toolbar control, must not overwrite the selection the user
        // wants to style, or color/size would have nothing to apply to.
        if (!r.collapsed)
            savedRange = r.cloneRange();
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
        el.setAttribute("aria-label", "PDF editor tools");
        const keepSel = (b) => b.addEventListener("mousedown", (e) => e.preventDefault());
        const exec = (cmd, val) => document.execCommand(cmd, false, val);
        // Apply a CSS property to the saved selection by operating on the Range OBJECT
        // directly (not the live document selection). Range methods don't need focus, so this
        // works even after clicking a toolbar input moved focus away from the paragraph, which
        // is why color/font/size do NOT go through withSel/execCommand.
        const applyStyle = (cssProp, value) => {
            const range = savedRange;
            if (!range || range.collapsed)
                return;
            const span = document.createElement("span");
            span.style.setProperty(cssProp, value);
            try {
                range.surroundContents(span);
            }
            catch {
                span.appendChild(range.extractContents());
                range.insertNode(span);
            }
            // Inner spans carry their own inline style; clear this one property on them so the
            // wrapper's new value wins instead of being overridden by a nested span.
            span.querySelectorAll("*").forEach((e) => e.style.removeProperty(cssProp));
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
        const withSel = (fn) => {
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
        const textBtn = (label, title, css, fn) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = label;
            b.title = title;
            b.setAttribute("aria-label", title); // "B"/"I" alone are not descriptive names
            if (css)
                b.style.cssText = css;
            b.addEventListener("click", () => withSel(fn));
            keepSel(b);
            return b;
        };
        const iconBtn = (svg, title, fn) => {
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
        el.append(textBtn("B", "Bold", "font-weight:bold", () => exec("bold")), textBtn("I", "Italic", "font-style:italic", () => exec("italic")));
        const color = document.createElement("input");
        color.type = "color";
        color.title = "Text color";
        color.setAttribute("aria-label", "Text color");
        color.value = "#000000";
        color.addEventListener("change", () => applyStyle("color", color.value));
        el.append(color);
        const font = document.createElement("select");
        font.title = "Font";
        font.setAttribute("aria-label", "Font family");
        for (const [v, label] of [["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"]]) {
            font.add(new Option(label, v));
        }
        font.addEventListener("change", () => applyStyle("font-family", cssFamily(font.value)));
        el.append(font);
        const size = document.createElement("input");
        size.type = "number";
        size.min = "4";
        size.max = "300";
        size.title = "Font size (pt)";
        size.setAttribute("aria-label", "Font size in points");
        size.addEventListener("change", () => {
            if (size.value)
                applyStyle("font-size", `${(Number(size.value) * scale).toFixed(2)}px`);
        });
        el.append(size);
        el.append(sep(), iconBtn(ICON.left, "Align left", () => setAlign("left")), iconBtn(ICON.center, "Align center", () => setAlign("center")), iconBtn(ICON.right, "Align right", () => setAlign("right")), iconBtn(ICON.justify, "Justify", () => setAlign("justify")), sep());
        const linkBtn = document.createElement("button");
        linkBtn.type = "button";
        linkBtn.textContent = "Link";
        linkBtn.title = "Add/edit link";
        linkBtn.setAttribute("aria-label", "Add or edit link");
        keepSel(linkBtn);
        linkBtn.addEventListener("click", () => {
            const url = prompt("Link URL (empty to remove):", "https://");
            if (url === null)
                return;
            withSel(() => {
                if (url === "")
                    exec("unlink");
                else
                    exec("createLink", url);
            });
        });
        el.append(linkBtn);
        const imgBtn = document.createElement("button");
        imgBtn.type = "button";
        imgBtn.textContent = "Image";
        imgBtn.title = "Insert image";
        imgBtn.setAttribute("aria-label", "Insert image");
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
            if (f)
                void insertImage(f);
            imageInput.value = "";
        });
        el.append(imageInput);
        // Zoom: a slider + a percentage input, kept in sync. Scales the displayed pages only.
        el.append(sep());
        const zoomWrap = document.createElement("span");
        zoomWrap.className = "pdfedit-zoom";
        const zlabel = document.createElement("span");
        zlabel.textContent = "Zoom";
        zlabel.setAttribute("aria-hidden", "true"); // controls below carry their own labels
        const zrange = document.createElement("input");
        zrange.type = "range";
        zrange.min = "25";
        zrange.max = "400";
        zrange.step = "5";
        zrange.value = "100";
        zrange.title = "Zoom";
        zrange.setAttribute("aria-label", "Zoom level (percent)");
        const znum = document.createElement("input");
        znum.type = "number";
        znum.min = "25";
        znum.max = "400";
        znum.value = "100";
        znum.title = "Zoom (%)";
        znum.setAttribute("aria-label", "Zoom percent");
        const zpct = document.createElement("span");
        zpct.textContent = "%";
        const setZoom = (pct) => {
            const p = Math.max(25, Math.min(400, Math.round(pct || 100)));
            zrange.value = String(p);
            znum.value = String(p);
            applyZoom(p / 100);
        };
        zrange.addEventListener("input", () => setZoom(Number(zrange.value)));
        znum.addEventListener("change", () => setZoom(Number(znum.value)));
        zoomWrap.append(zlabel, zrange, znum, zpct);
        el.append(zoomWrap);
        const update = (o) => {
            if (o.sizePt != null && isFinite(o.sizePt))
                size.value = String(Math.round(o.sizePt));
            if (o.family)
                font.value = o.family;
            if (o.colorHex)
                color.value = o.colorHex;
        };
        return { el, update };
    }
    function setAlign(a) {
        if (!activePara)
            return;
        activePara.align = a;
        activePara.el.style.textAlign = a;
        activePara.dirty = true;
        activePara.el.classList.add("pdfedit-edited");
        change();
    }
    async function insertImage(file) {
        const target = pageEls[0];
        if (!target)
            return;
        const bytesImg = new Uint8Array(await file.arrayBuffer());
        const box = document.createElement("div");
        box.className = "pdfedit-img";
        box.tabIndex = 0; // keyboard focusable
        box.setAttribute("role", "group");
        box.setAttribute("aria-label", "Inserted image. Arrow keys move it, plus and minus resize, Delete removes.");
        box.style.left = "40px";
        box.style.top = "40px";
        box.style.width = "160px";
        const img = document.createElement("img");
        img.src = URL.createObjectURL(new Blob([bytesImg], { type: file.type }));
        img.draggable = false;
        img.alt = "";
        const handle = document.createElement("div");
        handle.className = "pdfedit-img-handle";
        handle.title = "Drag to resize";
        handle.setAttribute("aria-hidden", "true"); // mouse affordance; keyboard uses +/- on the box
        const del = document.createElement("button");
        del.type = "button";
        del.className = "pdfedit-img-del";
        del.textContent = "×";
        del.title = "Delete image";
        del.setAttribute("aria-label", "Delete image");
        box.append(img, handle, del);
        target.el.appendChild(box);
        const rec = { page: target.index, bytes: bytesImg, mime: file.type, xPdf: 0, yPdf: 0, wPdf: 0, hPdf: 0, el: box };
        images.push(rec);
        img.addEventListener("load", () => updateImageRect(rec, target.viewport), { once: true });
        makeDraggable(box);
        makeResizable(box, handle, rec);
        const sync = () => {
            const vp = pageViewportOf(box);
            if (vp)
                updateImageRect(rec, vp);
            change();
        };
        const removeImage = () => {
            box.remove();
            const i = images.indexOf(rec);
            if (i >= 0)
                images.splice(i, 1);
            change();
        };
        const moveBy = (dx, dy) => {
            box.style.left = `${parseFloat(box.style.left) + dx}px`;
            box.style.top = `${parseFloat(box.style.top) + dy}px`;
            sync();
        };
        const resizeBy = (dw) => {
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
                case "ArrowLeft":
                    e.preventDefault();
                    moveBy(-step, 0);
                    break;
                case "ArrowRight":
                    e.preventDefault();
                    moveBy(step, 0);
                    break;
                case "ArrowUp":
                    e.preventDefault();
                    moveBy(0, -step);
                    break;
                case "ArrowDown":
                    e.preventDefault();
                    moveBy(0, step);
                    break;
                case "+":
                case "=":
                    e.preventDefault();
                    resizeBy(e.shiftKey ? 40 : 10);
                    break;
                case "-":
                case "_":
                    e.preventDefault();
                    resizeBy(e.shiftKey ? -40 : -10);
                    break;
                case "Delete":
                case "Backspace":
                    e.preventDefault();
                    removeImage();
                    break;
            }
        });
        box.focus(); // newly inserted image gets focus so it can be positioned by keyboard
        change();
    }
    const pageViewportOf = (el) => pageEls.find((p) => p.el === el.parentElement)?.viewport;
    function makeDraggable(box) {
        box.addEventListener("pointerdown", (e) => {
            if (e.target !== box && e.target.tagName !== "IMG")
                return; // not on handle/delete
            e.preventDefault();
            const startX = e.clientX;
            const startY = e.clientY;
            const left = parseFloat(box.style.left);
            const top = parseFloat(box.style.top);
            const move = (ev) => {
                box.style.left = `${left + ev.clientX - startX}px`;
                box.style.top = `${top + ev.clientY - startY}px`;
            };
            const up = () => {
                document.removeEventListener("pointermove", move);
                document.removeEventListener("pointerup", up);
                const rec = images.find((r) => r.el === box);
                const vp = pageViewportOf(box);
                if (rec && vp)
                    updateImageRect(rec, vp);
                change();
            };
            document.addEventListener("pointermove", move);
            document.addEventListener("pointerup", up);
        });
    }
    function makeResizable(box, handle, rec) {
        handle.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const startW = box.offsetWidth;
            const move = (ev) => {
                box.style.width = `${Math.max(20, startW + (ev.clientX - startX))}px`; // height is auto, keeps aspect
            };
            const up = () => {
                document.removeEventListener("pointermove", move);
                document.removeEventListener("pointerup", up);
                const vp = pageViewportOf(box);
                if (vp)
                    updateImageRect(rec, vp);
                change();
            };
            document.addEventListener("pointermove", move);
            document.addEventListener("pointerup", up);
        });
    }
    function updateImageRect(rec, viewport) {
        const left = parseFloat(rec.el.style.left);
        const top = parseFloat(rec.el.style.top);
        const w = rec.el.offsetWidth;
        const h = rec.el.offsetHeight;
        const tl = viewport.convertToPdfPoint(left, top);
        const br = viewport.convertToPdfPoint(left + w, top + h);
        rec.xPdf = Math.min(tl[0], br[0]);
        rec.yPdf = Math.min(tl[1], br[1]);
        rec.wPdf = Math.abs(br[0] - tl[0]);
        rec.hPdf = Math.abs(br[1] - tl[1]);
    }
    void (async () => {
        const doc = await pdfjsLib.getDocument({ data: bytes.slice(), fontExtraProperties: true }).promise;
        // Lazily parsed (pdf-lib) copy used only to recover original glyph codes for blocks whose
        // fonts have no usable Unicode. Loaded on first need so normal PDFs pay nothing.
        let glyphPdf = null;
        let glyphPdfFailed = false;
        const glyphsForPage = async (pageIndex) => {
            if (glyphPdfFailed)
                return [];
            try {
                if (!glyphPdf)
                    glyphPdf = await PDFDocument.load(bytes.slice());
                return pageGlyphs(glyphPdf, pageIndex);
            }
            catch {
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
            if (cctx)
                await page.render({ canvasContext: cctx, viewport, canvas }).promise;
            pageEl.appendChild(canvas);
            pageEls.push({ el: pageEl, viewport, index: p - 1 });
            const content = await page.getTextContent();
            const allItems = [];
            for (const item of content.items) {
                if (!("str" in item) || item.str === "")
                    continue;
                const t = item.transform;
                const norm = normalizePua(item.str);
                if (norm !== item.str)
                    puaFonts.add(item.fontName); // symbol font: remember for export
                allItems.push({ str: norm, x: t[4], y: t[5], w: item.width ?? 0, size: Math.hypot(t[2], t[3]) || 10, fontName: item.fontName });
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
                if (b.rec.data || b.rec.isType3)
                    return true;
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
                const fontStats = new Map();
                for (const it of items) {
                    const chars = [...it.str];
                    if (!chars.length)
                        continue;
                    // Invisible (white / render-mode-3) text is drawn but not shown. Decide this from
                    // the glyph at the item's origin (robust even when the run overlaps visible text,
                    // which would otherwise spoil the per-character count match below).
                    let originGlyph = null;
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
                    if (here.length !== chars.length)
                        continue; // mismatched mapping: leave un-anchored
                    const fg = cctx ? sampleRunStats(cctx, viewport, it.x, it.y, it.w, it.size).fg : { r: 0, g: 0, b: 0 };
                    const color = { r: fg.r / 255, g: fg.g / 255, b: fg.b / 255 };
                    it.anchors = here.map((g) => ({ fontRes: g.fontRes, hex: g.hex, width: g.width, size: g.size, color }));
                    const st = fontStats.get(it.fontName) ?? { alnum: 0, total: 0 };
                    for (const ch of chars) {
                        st.total++;
                        if (/[\p{L}\p{N}]/u.test(ch))
                            st.alnum++;
                    }
                    fontStats.set(it.fontName, st);
                }
                // A font whose decoded text is mostly NOT letters/digits is one whose Unicode is
                // unreliable (the glyphs have no real characters, only shapes). For those, swap the
                // displayed text for unique private codepoints and render the true outlines via a
                // built display font, so the overlay shows the real glyphs instead of mojibake.
                const unreliable = new Set();
                for (const [fn, st] of fontStats)
                    if (st.total >= 2 && st.alnum / st.total < 0.5)
                        unreliable.add(fn);
                for (const it of items) {
                    if (!it.anchors || !unreliable.has(it.fontName))
                        continue;
                    let cmap = displayFontChars.get(it.fontName);
                    if (!cmap)
                        displayFontChars.set(it.fontName, (cmap = new Map()));
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
                ? (ln) => {
                    const a = viewport.convertToViewportPoint(ln.minX, ln.y + ln.size * 0.85);
                    const b = viewport.convertToViewportPoint(ln.maxX, ln.y - ln.size * 0.3);
                    const left = Math.min(a[0], b[0]);
                    const top = Math.min(a[1], b[1]);
                    const w = Math.max(Math.abs(b[0] - a[0]), 2);
                    const h = Math.max(Math.abs(b[1] - a[1]), 4);
                    try {
                        return sampleColors(cctx, left, top, w, h).bg;
                    }
                    catch {
                        return null;
                    }
                }
                : undefined;
            for (const lines of buildParagraphs(items.filter((it) => !it.invisible), bgOf)) {
                const first = lines[0];
                if (lines.every((l) => l.text.trim() === ""))
                    continue;
                const boxX = Math.min(...lines.map((l) => l.minX));
                const boxRight = Math.max(...lines.map((l) => l.maxX));
                const size = first.size;
                const lineHeight = lines.length >= 2 ? Math.abs(lines[0].y - lines[1].y) || size * 1.2 : size * 1.2;
                const topY = first.y + size * 0.85;
                const bottomY = lines[lines.length - 1].y - size * 0.3;
                const align = detectAlign(lines, boxX, boxRight, pageW);
                // Soft wrap (flowing paragraph) vs hard line breaks (address / list): a flowing
                // paragraph's non-last lines each reach near the right edge (they broke because the
                // next word did not fit). If most lines instead end short, the breaks are intentional
                // and must be preserved as <br> rather than reflowed with a space.
                const bodyLines = lines.slice(0, -1);
                const fullCount = bodyLines.filter((l) => l.maxX >= boxRight - size * 2).length;
                const flowing = align === "justify" || (bodyLines.length >= 1 && fullCount >= Math.ceil(bodyLines.length * 0.6));
                const firstRec = getFontRec(page, first.items[0].fontName);
                const famCss = (rec) => (rec.cssName ? `'${rec.cssName}', ${cssFamily(rec.family)}` : cssFamily(rec.family));
                const tl = viewport.convertToViewportPoint(boxX, topY);
                const br = viewport.convertToViewportPoint(boxRight, bottomY);
                const left = Math.min(tl[0], br[0]);
                const top = Math.min(tl[1], br[1]);
                const dW = Math.abs(br[0] - tl[0]);
                const dH = Math.abs(br[1] - tl[1]);
                const { fg, bg } = cctx ? sampleColors(cctx, left, top, dW, Math.max(size * scale * 1.2, 4)) : { fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } };
                const origText = lines.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
                // Reproduce per-run styling (bold/italic/family/size/color) as styled spans so
                // editing keeps it. Consecutive items with the same style merge into one span;
                // soft-wrapped lines join with a space (the block reflows on its own).
                const fgHex = rgb255ToHex(fg);
                let html = "";
                let curKey = "";
                let curRec = firstRec;
                let curFontName = first.items[0].fontName;
                let curSize = size;
                let curColor = fgHex;
                let curText = "";
                // Built in lockstep with the block text (curText pieces + "\n" per <br>) so each
                // character keeps its original-glyph anchor for glyph-preserving export.
                let anchorText = "";
                const paraAnchors = [];
                let blockHasFragile = false;
                const fontCount = new Map(); // chars per font, to find the dominant one
                const flushSpan = () => {
                    if (!curText)
                        return;
                    const parts = [];
                    if (curRec.bold)
                        parts.push("font-weight:bold");
                    if (curRec.italic)
                        parts.push("font-style:italic");
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
                        if (it.str === "")
                            continue;
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
                        }
                        else if (prevEnd > -Infinity && gap > it.size * 0.2 && !/\s$/.test(curText) && !/^\s/.test(it.str)) {
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
                                if (perItemColor)
                                    curColor = rgb255ToHex(st.fg);
                                rec.inkSum = (rec.inkSum ?? 0) + st.ink;
                                rec.inkN = (rec.inkN ?? 0) + 1;
                            }
                            else
                                curColor = fgHex;
                        }
                        curText += it.str;
                        if (puaFonts.has(it.fontName))
                            blockHasFragile = true;
                        const chars = [...it.str];
                        for (let k = 0; k < chars.length; k++) {
                            anchorText += chars[k];
                            paraAnchors.push(it.anchors?.[k] ?? null);
                        }
                        prevEnd = it.x + itemWidth(it);
                    }
                    if (li !== lastLi) {
                        if (flowing) {
                            curText += " "; // soft wrap: reflow as one paragraph
                            anchorText += " ";
                            paraAnchors.push(null);
                        }
                        else {
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
                let baseFontName = first.items[0].fontName;
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
                const para = {
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
                    glyphPreserve: blockHasFragile && paraAnchors.length === anchorText.length && paraAnchors.some((a) => a !== null),
                };
                el.addEventListener("focus", () => {
                    activePara = para;
                    savedPara = para;
                    // Mark this paragraph active (keeps its border + visible overlay even after focus
                    // moves to a toolbar control); the native selection shows while it's focused.
                    for (const p of paragraphs)
                        p.el.classList.toggle("pdfedit-active", p === para);
                    clearHighlight();
                    toolbar.update({ sizePt: para.size, family: para.family });
                });
                // When focus moves to a toolbar control, keep this paragraph active and paint the
                // saved selection ourselves (the native highlight hides on blur). When focus leaves
                // the editor entirely, drop the active state so the page shows normally again.
                el.addEventListener("blur", (e) => {
                    const to = e.relatedTarget;
                    if (to && toolbar.el.contains(to)) {
                        showSavedHighlight();
                    }
                    else {
                        el.classList.remove("pdfedit-active");
                        clearHighlight();
                    }
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
        await applyDisplayFonts();
    })().catch((e) => console.error("[pdfedit] render failed", e));
    return {
        isDirty() {
            return images.length > 0 || paragraphs.some((p) => p.dirty);
        },
        async getBytes() {
            const editedParas = paragraphs.filter((p) => p.dirty);
            if (editedParas.length === 0 && images.length === 0)
                return original.slice();
            const pdf = await PDFDocument.load(original.slice());
            pdf.registerFontkit(fontkit);
            const pages = pdf.getPages();
            const stdCache = new Map();
            const getStd = async (k) => {
                let f = stdCache.get(k);
                if (!f) {
                    f = await pdf.embedFont(k);
                    stdCache.set(k, f);
                }
                return f;
            };
            // Re-embed the original font program once per source font.
            const embedCache = new Map();
            const getEmbedded = async (key) => {
                if (embedCache.has(key))
                    return embedCache.get(key);
                const rec = fontRecs.get(key);
                let font = null;
                if (rec?.data && rec.data.length) {
                    // Subset to keep the output small; some fonts can't be subset, so fall back to
                    // embedding the whole (already-subset) program.
                    try {
                        font = await pdf.embedFont(rec.data, { subset: true });
                    }
                    catch {
                        try {
                            font = await pdf.embedFont(rec.data, { subset: false });
                        }
                        catch {
                            font = null;
                        }
                    }
                }
                embedCache.set(key, font);
                return font;
            };
            // Whether an embedded font can render every (non-space) char in the text.
            const covers = (font, text) => {
                try {
                    const fk = font.embedder?.font;
                    if (!fk?.hasGlyphForCodePoint)
                        return false;
                    for (const ch of text) {
                        const cp = ch.codePointAt(0);
                        if (!cp || cp === 32 || cp === 9 || cp === 10 || cp === 13)
                            continue;
                        if (!fk.hasGlyphForCodePoint(cp))
                            return false;
                    }
                    return true;
                }
                catch {
                    return false;
                }
            };
            // Resolve a font per token: reuse the original embedded font when the run's style
            // is unchanged from the source and the font can render that word; otherwise a
            // standard font (WinAnsi). Per-word (not per-run) so one novel character only
            // affects its own word, not the whole paragraph.
            const resolveToken = async (run, part, space) => {
                const rec = run.fontKey ? fontRecs.get(run.fontKey) : undefined;
                // "Effective" original weight includes synthBold (a font that renders heavier than
                // its sibling). Matching it means the user didn't toggle, so reuse the real font.
                const effBold = rec ? rec.bold || !!rec.synthBold : run.bold;
                const styleSame = !!(rec && run.bold === effBold && run.italic === rec.italic);
                const std = await getStd(standardFont(rec ? rec.family : run.family, run.bold, run.italic));
                // Pick the embed source: the run's own font if it has a program, else a sibling
                // with the same base name that does (e.g. a Type3 font borrowing its CID twin).
                let embKey;
                if (run.fontKey && styleSame && rec) {
                    if (rec.data?.length)
                        embKey = run.fontKey;
                    else {
                        const donor = findDonor(rec.baseName, (r) => !!r.data?.length);
                        if (donor)
                            embKey = donor[0];
                    }
                }
                const emb = embKey ? await getEmbedded(embKey) : null;
                const embPua = !!(embKey && puaFonts.has(embKey));
                // A symbol font has glyphs at U+F0xx, not at ASCII; re-encode the text to reuse it.
                if (space)
                    return { font: emb && !embPua ? emb : std, text: " ", faux: false };
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
                if (!page)
                    continue;
                page.drawRectangle({ x: pp.x, y: pp.bottomY, width: Math.max(pp.w, 1), height: Math.max(pp.topY - pp.bottomY, 1), color: rgb(pp.bg.r, pp.bg.g, pp.bg.b) });
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
                await drawRuns(pdf, page, pp, runs, resolveToken);
            }
            for (const im of images) {
                const page = pages[im.page];
                if (!page || im.wPdf <= 0)
                    continue;
                try {
                    const embedded = /png/i.test(im.mime) ? await pdf.embedPng(im.bytes) : await pdf.embedJpg(im.bytes);
                    page.drawImage(embedded, { x: im.xPdf, y: im.yPdf, width: im.wPdf, height: im.hPdf });
                }
                catch (e) {
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
                }
                catch {
                    /* ignore */
                }
            }
            wrap.remove();
        },
    };
    // Re-emit a block's original glyphs for unchanged text, substituting only new characters.
    async function drawGlyphPreserving(page, pp, baseRec, getStd) {
        const bold = baseRec ? baseRec.bold || !!baseRec.synthBold : false;
        const italic = baseRec ? baseRec.italic : false;
        const std = await getStd(standardFont(pp.family, bold, italic));
        const measure = (ch, sz) => {
            try {
                return std.widthOfTextAtSize(ch, sz);
            }
            catch {
                return sz * 0.5;
            }
        };
        const edited = blockText(pp.el);
        const segs = planEditedBlock(pp.anchorText, pp.anchors, edited, { x: pp.x, firstBaseline: pp.firstBaseline, lineHeight: pp.lineHeight, width: pp.w, align: pp.align, size: pp.size }, measure, pp.color);
        for (const s of segs) {
            if (s.kind === "glyph") {
                // /<fontRes> <size> Tf  1 0 0 1 x y Tm  <codes> Tj  — original glyphs, verbatim.
                page.pushOperators(pushGraphicsState(), beginText(), setFillingRgbColor(s.color.r, s.color.g, s.color.b), setFontAndSize(s.fontRes, s.size), setTextMatrix(1, 0, 0, 1, s.x, s.y), showText(PDFHexString.of(s.hex)), endText(), popGraphicsState());
            }
            else if (s.text.trim() !== "") {
                try {
                    page.drawText(s.text, { x: s.x, y: s.y, size: s.size, font: std, color: rgb(s.color.r, s.color.g, s.color.b) });
                }
                catch {
                    /* glyph not encodable in the substitute font */
                }
            }
        }
    }
    async function drawRuns(pdf, page, pp, runs, resolveToken) {
        // Tokenize runs into words/spaces, resolving a font per token.
        const toks = [];
        const lineBreaks = [];
        for (const run of runs) {
            const parts = run.text.split(/(\s+)/);
            for (const part of parts) {
                if (part === "")
                    continue;
                const space = /^\s+$/.test(part);
                const { font, text, faux } = await resolveToken(run, part, space);
                let w = 0;
                try {
                    w = font.widthOfTextAtSize(text, run.size);
                }
                catch {
                    w = run.size * text.length * 0.5;
                }
                toks.push({ text, run, font, w, space, faux });
            }
            if (run.brAfter)
                lineBreaks.push(toks.length);
        }
        // Wrap into lines.
        const lines = [];
        let cur = [];
        let curW = 0;
        const flush = () => {
            while (cur.length && cur[cur.length - 1].space)
                cur.pop();
            lines.push(cur);
            cur = [];
            curW = 0;
        };
        toks.forEach((t, i) => {
            if (lineBreaks.includes(i))
                flush();
            if (!t.space && cur.length && curW + t.w > pp.w)
                flush();
            if (t.space && cur.length === 0)
                return;
            cur.push(t);
            curW += t.w;
        });
        if (cur.length)
            flush();
        const lastIdx = lines.length - 1;
        let y = pp.firstBaseline;
        lines.forEach((line, li) => {
            const lineW = line.reduce((a, t) => a + t.w, 0);
            const lineSize = Math.max(pp.size, ...line.map((t) => t.run.size));
            let x = pp.x;
            let spaceExtra = 0;
            if (pp.align === "center")
                x = pp.x + (pp.w - lineW) / 2;
            else if (pp.align === "right")
                x = pp.x + pp.w - lineW;
            else if (pp.align === "justify" && li !== lastIdx) {
                const nSpaces = line.filter((t) => t.space).length;
                if (nSpaces > 0 && pp.w > lineW)
                    spaceExtra = (pp.w - lineW) / nSpaces;
            }
            for (const t of line) {
                if (!t.space) {
                    try {
                        const col = rgb(t.run.color.r, t.run.color.g, t.run.color.b);
                        page.drawText(t.text, { x, y, size: t.run.size, font: t.font, color: col });
                        // Faux bold: redraw with a small horizontal offset to thicken the strokes.
                        if (t.faux)
                            page.drawText(t.text, { x: x + Math.max(t.run.size * 0.03, 0.2), y, size: t.run.size, font: t.font, color: col });
                    }
                    catch {
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
    function addLink(pdf, page, x, y, w, h, url) {
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
                annots = pdf.context.obj([]);
                page.node.set(PDFName.of("Annots"), annots);
            }
            annots.push(ref);
        }
        catch (e) {
            console.error("[pdfedit] link annot failed", e);
        }
    }
}
