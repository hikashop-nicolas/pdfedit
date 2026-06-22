# pdfedit

A standalone, framework-agnostic, client-side **PDF text editor**. It renders a PDF with
pdf.js, overlays an editable layer, and writes the edited PDF back with pdf-lib — entirely
in the browser. No server, no upload, no tracking.

**[▶ Live demo](https://hikashop-nicolas.github.io/pdfedit/)** — open a PDF, edit the text,
and download the result, all in your browser.

```ts
import { createPdfEditor } from "pdfedit";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url"; // your bundler resolves this

const editor = createPdfEditor(containerEl, pdfBytes, {
  workerSrc: workerUrl,        // the consumer provides the pdf.js worker URL
  onChange: () => console.log("edited"),
});

const editedBytes = await editor.getBytes(); // a valid PDF (Uint8Array)
editor.isDirty();                            // unsaved changes?
editor.destroy();                            // tear down
```

## What it does

- **Edit existing text in place** — click a paragraph and type. Per-selection **bold,
  italic, colour, font family, size**, and **alignment** (left / centre / right / justify)
  from a toolbar.
- **Keeps the document's own glyphs.** On save, unchanged text is re-emitted with its
  **original embedded font and glyph codes** (not a lookalike), so editing one part of a
  line leaves the rest pixel-identical — even for subset / symbol fonts that have no
  recoverable Unicode. Only genuinely new characters fall back to a matching standard font.
- **Add text in blank space** — double-click an empty spot to drop a new text box.
- **Images** — insert, then move / resize / delete (mouse or keyboard).
- **Links** — add or edit a URL on selected text.
- **Zoom** via a slider / percentage box; the level is remembered across sessions.
- **Faithful editing view** — the overlay shows the document's real glyph shapes (it builds
  a display font from the embedded outlines when a font's own encoding can't be used in
  HTML), and omits text the PDF draws invisibly (white fill / render mode 3).
- **Accessible** — labelled toolbar, keyboard-operable image boxes, visible focus rings.

Runtime dependencies: `pdfjs-dist`, `pdf-lib`, `@pdf-lib/fontkit`, `opentype.js`. The
heavier pieces (the content-stream glyph engine and the display-font builder) load on
demand, only for PDFs that need them; the consumer provides the pdf.js worker URL so it
resolves under their bundler.

## How it works (short version)

Render with pdf.js → build an editable overlay of styled, `contenteditable` paragraphs
(reconstructed from positioned text) → on save, diff each edited block against the
original, re-emit unchanged runs verbatim and draw new text in a standard font, with
pdf-lib. A small content-stream engine recovers each glyph's font resource, byte code and
position so the originals can be reproduced exactly, including through reflow.

## Scope / honest limitations

- **Scanned / image-only PDFs** have no text layer to edit (OCR would be needed).
- Editing reconstructs lines/paragraphs from positioned text; it is not a full re-flowing
  word processor.
- Covering the original text on export hides it visually, but the original bytes remain in
  the content stream (still extractable) — this is **not redaction**.
- Glyphs in obfuscated fonts that carry no Unicode render correctly and survive unchanged
  edits, but they aren't selectable / copyable as real characters.

## Develop

```
npm install
npm run dev       # standalone demo (open a PDF, edit, download)
npm run build     # compile the library to dist/ (tsc)
npm test          # unit tests (Vitest): content-stream engine + edit planner
npm run test:e2e  # end-to-end tests (Cypress, Chrome) against the built demo
```

`dist/` is committed so git-dependency consumers need no build step. Regenerate the e2e
fixture with `node cypress/gen-fixture.mjs`.

## Use from another local project

```
npm install ../pdfedit   # file: dependency; run `npm run build` in pdfedit after changes
```

License: MIT.
