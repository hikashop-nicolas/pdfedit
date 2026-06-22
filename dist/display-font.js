import fontkit from "@pdf-lib/fontkit";
import opentype from "opentype.js";
export function buildDisplayFont(program, charToGid, familyName) {
    let src;
    try {
        src = fontkit.create(program);
    }
    catch {
        return null;
    }
    const upm = src.unitsPerEm || 1000;
    const glyphs = [new opentype.Glyph({ name: ".notdef", unicode: 0, advanceWidth: upm, path: new opentype.Path() })];
    for (const [ch, gid] of charToGid) {
        const cp = ch.codePointAt(0);
        if (cp == null || cp === 0)
            continue;
        let g;
        try {
            g = src.getGlyph(gid);
        }
        catch {
            continue;
        }
        if (!g?.path?.commands)
            continue;
        const path = new opentype.Path();
        try {
            for (const c of g.path.commands) {
                const a = c.args;
                if (c.command === "moveTo")
                    path.moveTo(a[0], a[1]);
                else if (c.command === "lineTo")
                    path.lineTo(a[0], a[1]);
                else if (c.command === "quadraticCurveTo")
                    path.quadraticCurveTo(a[0], a[1], a[2], a[3]);
                else if (c.command === "bezierCurveTo")
                    path.curveTo(a[0], a[1], a[2], a[3], a[4], a[5]);
                else if (c.command === "closePath")
                    path.close();
            }
        }
        catch {
            continue;
        }
        glyphs.push(new opentype.Glyph({ name: `g${gid}`, unicode: cp, advanceWidth: g.advanceWidth || upm, path }));
    }
    if (glyphs.length <= 1)
        return null;
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
    }
    catch {
        return null;
    }
}
