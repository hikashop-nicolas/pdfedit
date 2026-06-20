import * as pdfjsLib from "pdfjs-dist";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
const STYLE_ID = "pdfedit-style";
function injectStyles() {
    if (document.getElementById(STYLE_ID))
        return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
    .pdfedit-root {
      height: 100%; overflow: auto; box-sizing: border-box;
      display: flex; flex-direction: column; align-items: center; gap: 16px;
      padding: 16px; background: #525659;
    }
    .pdfedit-page { position: relative; background: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.45); }
    .pdfedit-page canvas { display: block; }
    .pdfedit-para {
      position: absolute; box-sizing: border-box; cursor: text; outline: none;
      color: transparent; white-space: pre-wrap; word-break: break-word; overflow: visible;
    }
    .pdfedit-para:focus, .pdfedit-para.pdfedit-edited {
      color: var(--c, #000); background: var(--bg, #fff);
    }
    .pdfedit-para:focus { box-shadow: 0 0 0 2px #4f46e5; }
  `;
    document.head.appendChild(s);
}
const familyOf = (n) => /times|georgia|serif|roman|minion|garamond/i.test(n)
    ? "serif"
    : /courier|mono|consol|menlo/i.test(n)
        ? "mono"
        : "sans";
const cssFamily = (f) => f === "serif" ? "Times New Roman, serif" : f === "mono" ? "monospace" : "Helvetica, Arial, sans-serif";
function standardFont(f, bold, italic) {
    if (f === "serif")
        return bold && italic
            ? StandardFonts.TimesRomanBoldItalic
            : bold
                ? StandardFonts.TimesRomanBold
                : italic
                    ? StandardFonts.TimesRomanItalic
                    : StandardFonts.TimesRoman;
    if (f === "mono")
        return bold && italic
            ? StandardFonts.CourierBoldOblique
            : bold
                ? StandardFonts.CourierBold
                : italic
                    ? StandardFonts.CourierOblique
                    : StandardFonts.Courier;
    return bold && italic
        ? StandardFonts.HelveticaBoldOblique
        : bold
            ? StandardFonts.HelveticaBold
            : italic
                ? StandardFonts.HelveticaOblique
                : StandardFonts.Helvetica;
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
        return { fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } };
    }
    const bg = { r: data[0] ?? 255, g: data[1] ?? 255, b: data[2] ?? 255 };
    let fg = bg;
    let best = -1;
    for (let i = 0; i < data.length; i += 4) {
        if ((data[i + 3] ?? 0) < 128)
            continue;
        const dr = data[i] - bg.r;
        const dg = data[i + 1] - bg.g;
        const db = data[i + 2] - bg.b;
        const d = dr * dr + dg * dg + db * db;
        if (d > best) {
            best = d;
            fg = { r: data[i], g: data[i + 1], b: data[i + 2] };
        }
    }
    return { fg, bg };
}
const norm = (c) => ({ r: c.r / 255, g: c.g / 255, b: c.b / 255 });
const variance = (xs) => {
    if (xs.length < 2)
        return 0;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
};
/** Group runs into lines, then lines into paragraphs (heuristic). */
function buildParagraphs(items) {
    const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.y - it.y) <= last.size * 0.4) {
            last.items.push(it);
            last.minX = Math.min(last.minX, it.x);
            last.maxX = Math.max(last.maxX, it.x + it.w);
            last.size = Math.max(last.size, it.size);
        }
        else {
            lines.push({ items: [it], y: it.y, minX: it.x, maxX: it.x + it.w, size: it.size, text: "" });
        }
    }
    for (const ln of lines) {
        ln.items.sort((a, b) => a.x - b.x);
        ln.text = ln.items.map((i) => i.str).join("");
    }
    // Group consecutive lines with normal spacing + similar size into paragraphs.
    const paras = [];
    for (const ln of lines) {
        const group = paras[paras.length - 1];
        const prev = group?.[group.length - 1];
        const gap = prev ? prev.y - ln.y : Infinity;
        const sizeClose = prev ? Math.abs(prev.size - ln.size) <= prev.size * 0.35 : false;
        if (group && prev && gap > 0 && gap <= prev.size * 1.8 && sizeClose)
            group.push(ln);
        else
            paras.push([ln]);
    }
    return paras;
}
function detectAlign(lines, boxX, boxRight, pageW) {
    if (lines.length >= 2) {
        const lefts = lines.map((l) => l.minX);
        const rights = lines.map((l) => l.maxX);
        const centers = lines.map((l) => (l.minX + l.maxX) / 2);
        const lv = variance(lefts);
        const rv = variance(rights);
        const cv = variance(centers);
        if (cv < lv && cv < rv)
            return "center";
        if (rv < lv)
            return "right";
        return "left";
    }
    // Single line: infer from page margins.
    const leftM = boxX;
    const rightM = pageW - boxRight;
    if (leftM > pageW * 0.12 && Math.abs(leftM - rightM) < pageW * 0.08)
        return "center";
    if (rightM < pageW * 0.1 && leftM > pageW * 0.2)
        return "right";
    return "left";
}
/** Greedy word-wrap into lines that fit width, honoring hard newlines. */
function wrapLines(text, font, size, maxWidth) {
    const out = [];
    for (const para of text.split("\n")) {
        const words = para.split(/(\s+)/).filter((w) => w !== "");
        let cur = "";
        for (const w of words) {
            const trial = cur + w;
            if (cur && font.widthOfTextAtSize(trial, size) > maxWidth) {
                out.push(cur.trimEnd());
                cur = w.trim() === "" ? "" : w;
            }
            else {
                cur = trial;
            }
        }
        out.push(cur.trimEnd());
    }
    return out;
}
export function createPdfEditor(container, bytes, options = {}) {
    if (options.workerSrc)
        pdfjsLib.GlobalWorkerOptions.workerSrc = options.workerSrc;
    const scale = options.scale ?? 1.3;
    const original = bytes.slice();
    const paragraphs = [];
    let destroyed = false;
    injectStyles();
    const root = document.createElement("div");
    root.className = "pdfedit-root";
    container.appendChild(root);
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
            if (cctx)
                await page.render({ canvasContext: cctx, viewport, canvas }).promise;
            pageEl.appendChild(canvas);
            const content = await page.getTextContent();
            const items = [];
            for (const item of content.items) {
                if (!("str" in item) || item.str === "")
                    continue;
                const t = item.transform;
                items.push({
                    str: item.str,
                    x: t[4],
                    y: t[5],
                    w: item.width ?? 0,
                    size: Math.hypot(t[2], t[3]) || 10,
                    fontName: item.fontName,
                });
            }
            for (const lines of buildParagraphs(items)) {
                const first = lines[0];
                const firstItem = first.items[0];
                if (first.text.trim() === "" && lines.every((l) => l.text.trim() === ""))
                    continue;
                const boxX = Math.min(...lines.map((l) => l.minX));
                const boxRight = Math.max(...lines.map((l) => l.maxX));
                const size = first.size;
                const lineHeight = lines.length >= 2 ? Math.abs(lines[0].y - lines[1].y) || size * 1.2 : size * 1.2;
                const topY = first.y + size * 0.85;
                const bottomY = lines[lines.length - 1].y - size * 0.3;
                const align = detectAlign(lines, boxX, boxRight, pageW);
                // Font + style from the first run's loaded font.
                let bold = false;
                let italic = false;
                let family = "sans";
                let fontData;
                try {
                    if (page.commonObjs.has(firstItem.fontName)) {
                        const f = page.commonObjs.get(firstItem.fontName);
                        const nm = String(f?.name ?? "");
                        bold = /bold|black|semibold|heavy/i.test(nm) || f?.black === true;
                        italic = /italic|oblique/i.test(nm);
                        family = familyOf(nm);
                        if (f?.data instanceof Uint8Array)
                            fontData = f.data;
                    }
                }
                catch {
                    /* defaults */
                }
                const tl = viewport.convertToViewportPoint(boxX, topY);
                const br = viewport.convertToViewportPoint(boxRight, bottomY);
                const left = Math.min(tl[0], br[0]);
                const top = Math.min(tl[1], br[1]);
                const dW = Math.abs(br[0] - tl[0]);
                const dH = Math.abs(br[1] - tl[1]);
                const { fg, bg } = cctx
                    ? sampleColors(cctx, left, top, dW, Math.max(size * scale * 1.2, 4))
                    : { fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } };
                const origText = lines.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
                const el = document.createElement("div");
                el.className = "pdfedit-para";
                el.contentEditable = "true";
                el.spellcheck = false;
                el.textContent = origText;
                el.style.left = `${left}px`;
                el.style.top = `${top}px`;
                el.style.width = `${Math.max(dW, size * scale)}px`;
                el.style.minHeight = `${Math.max(dH, size * scale)}px`;
                el.style.fontSize = `${size * scale}px`;
                el.style.lineHeight = `${lineHeight * scale}px`;
                el.style.fontWeight = bold ? "bold" : "normal";
                el.style.fontStyle = italic ? "italic" : "normal";
                el.style.fontFamily = cssFamily(family);
                el.style.textAlign = align;
                el.style.setProperty("--c", `rgb(${fg.r},${fg.g},${fg.b})`);
                el.style.setProperty("--bg", `rgb(${bg.r},${bg.g},${bg.b})`);
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
                    bold,
                    italic,
                    family,
                    color: norm(fg),
                    bg: norm(bg),
                    fontKey: firstItem.fontName,
                    ...(fontData ? { fontData } : {}),
                    origText,
                    el,
                };
                const isEdited = () => (el.innerText.replace(/\s+/g, " ").trim()) !== origText;
                el.addEventListener("input", () => {
                    el.classList.toggle("pdfedit-edited", isEdited());
                    options.onChange?.();
                });
                pageEl.appendChild(el);
                paragraphs.push(para);
            }
            root.appendChild(pageEl);
        }
    })().catch((e) => console.error("[pdfedit] render failed", e));
    const editedParas = () => paragraphs.filter((pp) => pp.el.innerText.replace(/\s+/g, " ").trim() !== pp.origText);
    return {
        isDirty() {
            return editedParas().length > 0;
        },
        async getBytes() {
            const edited = editedParas();
            if (edited.length === 0)
                return original.slice();
            const pdf = await PDFDocument.load(original.slice());
            pdf.registerFontkit(fontkit);
            const pages = pdf.getPages();
            const stdCache = new Map();
            const embCache = new Map();
            const getStd = async (k) => {
                let f = stdCache.get(k);
                if (!f) {
                    f = await pdf.embedFont(k);
                    stdCache.set(k, f);
                }
                return f;
            };
            const getEmb = async (pp) => {
                if (!pp.fontData)
                    return null;
                if (embCache.has(pp.fontKey))
                    return embCache.get(pp.fontKey) ?? null;
                let f = null;
                try {
                    f = await pdf.embedFont(pp.fontData);
                }
                catch {
                    f = null;
                }
                embCache.set(pp.fontKey, f);
                return f;
            };
            for (const pp of edited) {
                const page = pages[pp.page];
                if (!page)
                    continue;
                page.drawRectangle({
                    x: pp.x,
                    y: pp.bottomY,
                    width: Math.max(pp.w, 1),
                    height: Math.max(pp.topY - pp.bottomY, 1),
                    color: rgb(pp.bg.r, pp.bg.g, pp.bg.b),
                });
                const text = pp.el.innerText.replace(/ /g, " ").replace(/\n{2,}/g, "\n").trim();
                if (!text)
                    continue;
                const std = await getStd(standardFont(pp.family, pp.bold, pp.italic));
                const embedded = await getEmb(pp);
                // Lay out with the embedded font if it can measure all glyphs, else standard.
                let font = std;
                let lines;
                try {
                    if (!embedded)
                        throw new Error("no embedded font");
                    lines = wrapLines(text, embedded, pp.size, pp.w);
                    font = embedded;
                }
                catch {
                    lines = wrapLines(text, std, pp.size, pp.w);
                    font = std;
                }
                const color = rgb(pp.color.r, pp.color.g, pp.color.b);
                let y = pp.firstBaseline;
                for (const line of lines) {
                    const lineW = font.widthOfTextAtSize(line, pp.size);
                    let x = pp.x;
                    if (pp.align === "center")
                        x = pp.x + (pp.w - lineW) / 2;
                    else if (pp.align === "right")
                        x = pp.x + pp.w - lineW;
                    try {
                        page.drawText(line, { x, y, size: pp.size, font, color });
                    }
                    catch {
                        /* skip a line the font cannot encode */
                    }
                    y -= pp.lineHeight;
                }
            }
            return new Uint8Array(await pdf.save());
        },
        destroy() {
            destroyed = true;
            root.remove();
        },
    };
}
