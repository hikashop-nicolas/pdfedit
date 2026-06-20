import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// pdfedit: a standalone, framework-agnostic PDF text editor.
//
// It renders each page with pdf.js (raster) and overlays an editable text layer
// extracted from getTextContent. Unedited tokens are invisible (the rendered page
// shows through); editing a token covers the original and draws the new text. On
// export, pdf-lib loads the original PDF, whites out each edited token's box, and
// redraws the new text with an embedded font, returning new bytes.
//
// Honest limitations: edited/new text uses a standard font (not the original
// typeface); scanned (image-only) PDFs have no text layer to edit; there is no
// automatic paragraph reflow (you edit positioned text runs).

export interface PdfEditorOptions {
  /** URL of the pdf.js worker (the consumer's bundler resolves this). */
  workerSrc?: string;
  /** Render scale (device px per PDF pt). Default 1.3. */
  scale?: number;
  /** Called whenever the document is edited. */
  onChange?: () => void;
}

export interface PdfEditor {
  /** Export the edited PDF as bytes (original bytes if nothing changed). */
  getBytes(): Promise<Uint8Array>;
  /** Whether anything has been edited. */
  isDirty(): boolean;
  destroy(): void;
}

interface TextToken {
  page: number; // 0-based
  orig: string;
  x: number; // PDF user space (pt), baseline-left, y-up
  y: number;
  width: number; // pt
  size: number; // pt
  el: HTMLSpanElement;
}

const STYLE_ID = "pdfedit-style";

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
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
      color: transparent; background: transparent; cursor: text; outline: none;
      font-family: Helvetica, Arial, sans-serif;
    }
    .pdfedit-tok:focus, .pdfedit-tok.pdfedit-edited { color: #000; background: #fff; }
    .pdfedit-tok:focus { box-shadow: 0 0 0 2px #4f46e5; }
  `;
  document.head.appendChild(s);
}

export function createPdfEditor(
  container: HTMLElement,
  bytes: Uint8Array,
  options: PdfEditorOptions = {},
): PdfEditor {
  if (options.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = options.workerSrc;
  const scale = options.scale ?? 1.3;
  const original = bytes.slice();
  const tokens: TextToken[] = [];
  let destroyed = false;

  injectStyles();
  const root = document.createElement("div");
  root.className = "pdfedit-root";
  container.appendChild(root);

  void (async () => {
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
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
      if (cctx) await page.render({ canvasContext: cctx, viewport, canvas }).promise;
      pageEl.appendChild(canvas);

      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!("str" in item) || item.str.trim() === "") continue;
        const t = item.transform as number[]; // [a,b,c,d,e,f] in PDF user space
        const dev = pdfjsLib.Util.transform(viewport.transform, t); // device space
        const fontPx = Math.hypot(dev[2]!, dev[3]!);
        const span = document.createElement("span");
        span.className = "pdfedit-tok";
        span.contentEditable = "true";
        span.spellcheck = false;
        span.textContent = item.str;
        span.style.left = `${dev[4]}px`;
        span.style.top = `${dev[5]! - fontPx}px`;
        span.style.fontSize = `${fontPx}px`;
        span.style.lineHeight = `${fontPx}px`;

        const token: TextToken = {
          page: p - 1,
          orig: item.str,
          x: t[4]!,
          y: t[5]!,
          width: item.width ?? 0,
          size: Math.hypot(t[2]!, t[3]!) || fontPx / scale,
          el: span,
        };
        span.addEventListener("input", () => {
          const changed = (span.textContent ?? "") !== token.orig;
          span.classList.toggle("pdfedit-edited", changed);
          options.onChange?.();
        });
        pageEl.appendChild(span);
        tokens.push(token);
      }
      root.appendChild(pageEl);
    }
  })().catch((e: unknown) => console.error("[pdfedit] render failed", e));

  return {
    isDirty() {
      return tokens.some((t) => (t.el.textContent ?? "") !== t.orig);
    },
    async getBytes() {
      const edited = tokens.filter((t) => (t.el.textContent ?? "") !== t.orig);
      if (edited.length === 0) return original.slice();
      const pdf = await PDFDocument.load(original.slice());
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const pages = pdf.getPages();
      for (const t of edited) {
        const page = pages[t.page];
        if (!page) continue;
        page.drawRectangle({
          x: t.x,
          y: t.y - t.size * 0.25,
          width: Math.max(t.width, 1),
          height: t.size * 1.25,
          color: rgb(1, 1, 1),
        });
        const text = t.el.textContent ?? "";
        if (text) page.drawText(text, { x: t.x, y: t.y, size: t.size, font, color: rgb(0, 0, 0) });
      }
      return new Uint8Array(await pdf.save());
    },
    destroy() {
      destroyed = true;
      root.remove();
    },
  };
}
