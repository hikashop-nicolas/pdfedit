import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { createPdfEditor, type PdfEditor } from "../src/index";

const fileInput = document.getElementById("file") as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;
const editorEl = document.getElementById("editor") as HTMLElement;

let editor: PdfEditor | null = null;
let filename = "edited.pdf";

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  filename = file.name;
  editor?.destroy();
  editorEl.innerHTML = "";
  const bytes = new Uint8Array(await file.arrayBuffer());
  editor = createPdfEditor(editorEl, bytes, {
    workerSrc: workerUrl,
    onChange: () => {
      saveBtn.disabled = false;
      statusEl.textContent = "edited";
    },
  });
  saveBtn.disabled = false;
  statusEl.textContent = "loaded";
});

saveBtn.addEventListener("click", async () => {
  if (!editor) return;
  const out = await editor.getBytes();
  const blob = new Blob([out as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
});
