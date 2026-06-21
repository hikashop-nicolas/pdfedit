// Generates cypress/fixtures/test.pdf: a small PDF with bold + regular text used by the
// e2e tests. Uses the standard Helvetica fonts (not embedded) so nothing licensed is
// committed. Run with: node cypress/gen-fixture.mjs
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync } from "node:fs";

const pdf = await PDFDocument.create();
const page = pdf.addPage([595, 842]);
const reg = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
const size = 12;
let x = 70;
let y = 760;
const segs = [
  { t: "Premier document", b: true },
  { t: " avec plusieurs mots distincts pour tester couleur taille selection visible.", b: false },
];
const words = [];
for (const s of segs) for (const p of s.t.split(/(\s+)/)) if (p !== "") words.push({ t: p, b: s.b, sp: /^\s+$/.test(p) });
for (const w of words) {
  const f = w.b ? bold : reg;
  const wd = f.widthOfTextAtSize(w.t === " " ? " " : w.t, size);
  if (!w.sp && x + wd > 525) {
    x = 70;
    y -= 18;
  }
  if (!w.sp) page.drawText(w.t, { x, y, size, font: f, color: rgb(0, 0, 0) });
  x += wd;
}
writeFileSync(new URL("./fixtures/test.pdf", import.meta.url), await pdf.save());
console.log("wrote cypress/fixtures/test.pdf");
