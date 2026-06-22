import fontkit from "@pdf-lib/fontkit";
import opentype from "opentype.js";

// Build a browser display font that renders the given display characters using the embedded
// font program's ACTUAL glyph outlines, by re-mapping each displayed character to its
// original glyph id. Needed because these fonts' own cmap is unusable in HTML (it maps
// everything to .notdef), so a normal @font-face shows tofu; the saved PDF is unaffected
// (it reuses the original font directly). Display only.
//
// charToGid maps the character shown in the overlay (e.g. the normalized placeholder) to the
// original glyph id (= the content byte code for Identity-encoded CID fonts).

interface FkGlyph {
  advanceWidth: number;
  path: { commands: { command: string; args: number[] }[] };
}
interface FkFont {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  getGlyph(gid: number): FkGlyph;
}

export function buildDisplayFont(program: Uint8Array, charToGid: Map<string, number>, familyName: string): ArrayBuffer | null {
  let src: FkFont;
  try {
    src = (fontkit as unknown as { create(b: Uint8Array): FkFont }).create(program);
  } catch {
    return null;
  }
  const upm = src.unitsPerEm || 1000;
  const glyphs = [new opentype.Glyph({ name: ".notdef", unicode: 0, advanceWidth: upm, path: new opentype.Path() })];
  for (const [ch, gid] of charToGid) {
    const cp = ch.codePointAt(0);
    if (cp == null || cp === 0) continue;
    let g: FkGlyph;
    try {
      g = src.getGlyph(gid);
    } catch {
      continue;
    }
    if (!g?.path?.commands) continue;
    const path = new opentype.Path();
    try {
      for (const c of g.path.commands) {
        const a = c.args;
        if (c.command === "moveTo") path.moveTo(a[0]!, a[1]!);
        else if (c.command === "lineTo") path.lineTo(a[0]!, a[1]!);
        else if (c.command === "quadraticCurveTo") path.quadraticCurveTo(a[0]!, a[1]!, a[2]!, a[3]!);
        else if (c.command === "bezierCurveTo") path.curveTo(a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!);
        else if (c.command === "closePath") path.close();
      }
    } catch {
      continue;
    }
    glyphs.push(new opentype.Glyph({ name: `g${gid}`, unicode: cp, advanceWidth: g.advanceWidth || upm, path }));
  }
  if (glyphs.length <= 1) return null;
  try {
    const font = new opentype.Font({
      familyName,
      styleName: "Regular",
      unitsPerEm: upm,
      ascender: Math.round(src.ascent || upm * 0.8),
      descender: Math.round(src.descent || -upm * 0.2),
      glyphs,
    });
    return font.toArrayBuffer();
  } catch {
    return null;
  }
}
