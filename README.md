# pdfedit

A standalone, framework-agnostic, client-side **PDF text editor**. It renders a PDF
with pdf.js, overlays an editable text layer extracted from the document, and exports
the edited PDF with pdf-lib. No server, no upload.

```ts
import { createPdfEditor } from "pdfedit";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url"; // your bundler resolves this

const editor = createPdfEditor(containerEl, pdfBytes, {
  workerSrc: workerUrl,
  onChange: () => console.log("edited"),
});

// later, to save:
const editedBytes = await editor.getBytes();
```

`pdfjs-dist` and `pdf-lib` are dependencies; the consumer provides the pdf.js worker URL
(so it resolves correctly under the consumer's bundler).

## Scope / honest limitations

- Edits existing text runs in place and adds/removes text; on export, edited regions are
  covered and the new text is redrawn with an embedded **standard font** (so it won't
  always match the original typeface exactly).
- **Scanned/image-only PDFs** have no text layer to edit (OCR would be needed).
- No automatic paragraph **reflow**: you edit positioned text runs (the same model
  browser PDF editors use).

## Develop

```
npm install
npm run dev     # standalone demo (open a PDF, edit text, download)
npm run build   # compile the library to dist/ (tsc)
```

## Use from another local project

```
npm install ../pdfedit   # file: dependency; run `npm run build` in pdfedit after changes
```

License: MIT.
