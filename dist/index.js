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
    .pdfedit-tok {
      position: absolute; white-space: pre; transform-origin: left top;
      color: transparent; cursor: text; outline: none;
    }
    .pdfedit-tok:focus, .pdfedit-tok.pdfedit-edited { color: var(--tok-color, #000); background: var(--tok-bg, #fff); }
    .pdfedit-tok:focus { box-shadow: 0 0 0 2px #4f46e5; }
  `;
    document.head.appendChild(s);
}
function familyOf(name) {
    if (/times|georgia|serif|roman|minion|garamond/i.test(name))
        return "serif";
    if (/courier|mono|consol|menlo/i.test(name))
        return "mono";
    return "sans";
}
function cssFamily(f) {
    return f === "serif" ? "Times New Roman, serif" : f === "mono" ? "monospace" : "Helvetica, Arial, sans-serif";
}
function standardFont(f, bold, italic) {
    if (f === "serif") {
        return bold && italic
            ? StandardFonts.TimesRomanBoldItalic
            : bold
                ? StandardFonts.TimesRomanBold
                : italic
                    ? StandardFonts.TimesRomanItalic
                    : StandardFonts.TimesRoman;
    }
    if (f === "mono") {
        return bold && italic
            ? StandardFonts.CourierBoldOblique
            : bold
                ? StandardFonts.CourierBold
                : italic
                    ? StandardFonts.CourierOblique
                    : StandardFonts.Courier;
    }
    return bold && italic
        ? StandardFonts.HelveticaBoldOblique
        : bold
            ? StandardFonts.HelveticaBold
            : italic
                ? StandardFonts.HelveticaOblique
                : StandardFonts.Helvetica;
}
/** Sample a token's foreground (glyph) and background colors from the rendered canvas. */
function sampleColors(ctx, x, y, w, h) {
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const sx = Math.max(0, Math.min(Math.floor(x), cw - 1));
    const sy = Math.max(0, Math.min(Math.floor(y), ch - 1));
    const sw = Math.max(1, Math.min(Math.floor(w), cw - sx));
    const sh = Math.max(1, Math.min(Math.floor(h), ch - sy));
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    let data;
    try {
        data = ctx.getImageData(sx, sy, sw, sh).data;
    }
    catch {
        return { fg: black, bg: white };
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
export function createPdfEditor(container, bytes, options = {}) {
    if (options.workerSrc)
        pdfjsLib.GlobalWorkerOptions.workerSrc = options.workerSrc;
    const scale = options.scale ?? 1.3;
    const original = bytes.slice();
    const tokens = [];
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
            for (const item of content.items) {
                if (!("str" in item) || item.str.trim() === "")
                    continue;
                const t = item.transform;
                const dev = pdfjsLib.Util.transform(viewport.transform, t);
                const fontPx = Math.hypot(dev[2], dev[3]);
                const left = dev[4];
                const top = dev[5] - fontPx;
                const devW = Math.max((item.width ?? 0) * scale, fontPx);
                // Font + style from the loaded font object.
                let bold = false;
                let italic = false;
                let family = "sans";
                let fontData;
                try {
                    if (page.commonObjs.has(item.fontName)) {
                        const f = page.commonObjs.get(item.fontName);
                        const nm = String(f?.name ?? "");
                        bold = /bold|black|semibold|heavy/i.test(nm) || f?.black === true;
                        italic = /italic|oblique/i.test(nm);
                        family = familyOf(nm);
                        if (f?.data instanceof Uint8Array)
                            fontData = f.data;
                    }
                }
                catch {
                    /* font not available; use defaults */
                }
                const { fg, bg } = cctx
                    ? sampleColors(cctx, left, top, devW, fontPx * 1.2)
                    : { fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } };
                const color = norm(fg);
                const bgN = norm(bg);
                const span = document.createElement("span");
                span.className = "pdfedit-tok";
                span.contentEditable = "true";
                span.spellcheck = false;
                span.textContent = item.str;
                span.style.left = `${left}px`;
                span.style.top = `${top}px`;
                span.style.fontSize = `${fontPx}px`;
                span.style.lineHeight = `${fontPx}px`;
                span.style.fontWeight = bold ? "bold" : "normal";
                span.style.fontStyle = italic ? "italic" : "normal";
                span.style.fontFamily = cssFamily(family);
                span.style.setProperty("--tok-color", `rgb(${fg.r},${fg.g},${fg.b})`);
                span.style.setProperty("--tok-bg", `rgb(${bg.r},${bg.g},${bg.b})`);
                const token = {
                    page: p - 1,
                    orig: item.str,
                    x: t[4],
                    y: t[5],
                    width: item.width ?? 0,
                    size: Math.hypot(t[2], t[3]) || fontPx / scale,
                    bold,
                    italic,
                    family,
                    color,
                    bg: bgN,
                    fontKey: item.fontName,
                    ...(fontData ? { fontData } : {}),
                    el: span,
                };
                span.addEventListener("input", () => {
                    span.classList.toggle("pdfedit-edited", (span.textContent ?? "") !== token.orig);
                    options.onChange?.();
                });
                pageEl.appendChild(span);
                tokens.push(token);
            }
            root.appendChild(pageEl);
        }
    })().catch((e) => console.error("[pdfedit] render failed", e));
    return {
        isDirty() {
            return tokens.some((t) => (t.el.textContent ?? "") !== t.orig);
        },
        async getBytes() {
            const edited = tokens.filter((t) => (t.el.textContent ?? "") !== t.orig);
            if (edited.length === 0)
                return original.slice();
            const pdf = await PDFDocument.load(original.slice());
            pdf.registerFontkit(fontkit);
            const pages = pdf.getPages();
            const stdCache = new Map();
            const embCache = new Map();
            const getStd = async (key) => {
                let f = stdCache.get(key);
                if (!f) {
                    f = await pdf.embedFont(key);
                    stdCache.set(key, f);
                }
                return f;
            };
            const getEmbedded = async (t) => {
                if (!t.fontData)
                    return null;
                if (embCache.has(t.fontKey))
                    return embCache.get(t.fontKey) ?? null;
                let f = null;
                try {
                    f = await pdf.embedFont(t.fontData);
                }
                catch {
                    f = null;
                }
                embCache.set(t.fontKey, f);
                return f;
            };
            for (const t of edited) {
                const page = pages[t.page];
                if (!page)
                    continue;
                page.drawRectangle({
                    x: t.x,
                    y: t.y - t.size * 0.25,
                    width: Math.max(t.width, 1),
                    height: t.size * 1.25,
                    color: rgb(t.bg.r, t.bg.g, t.bg.b),
                });
                const text = t.el.textContent ?? "";
                if (!text)
                    continue;
                const opts = { x: t.x, y: t.y, size: t.size, color: rgb(t.color.r, t.color.g, t.color.b) };
                const embedded = await getEmbedded(t);
                let drawn = false;
                if (embedded) {
                    try {
                        page.drawText(text, { ...opts, font: embedded });
                        drawn = true;
                    }
                    catch {
                        drawn = false; // subset font can't render the new characters
                    }
                }
                if (!drawn) {
                    page.drawText(text, { ...opts, font: await getStd(standardFont(t.family, t.bold, t.italic)) });
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
