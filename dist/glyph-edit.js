// Glyph-preserving edit planner.
//
// When a text block is edited, we want to keep the ORIGINAL glyphs for the parts the user
// did not change (re-emitting their exact font resource + byte code, which reproduces glyphs
// that have no usable Unicode/cmap) and only fall back to a substitute font for genuinely
// new text. This module is the pure core of that: diff the edited text against the original,
// then lay the result out into draw segments — either "glyph" (original codes in an original
// font resource) or "text" (new characters in a substitute font).
/**
 * For each character of b, the index of the character in a it was matched to (longest common
 * subsequence), or -1 if it is new. Bounded: returns all -1 if the product is huge.
 */
export function lcsMatch(a, b) {
    const n = a.length;
    const m = b.length;
    const res = new Int32Array(m).fill(-1);
    if (n === 0 || m === 0 || n * m > 4_000_000)
        return res;
    // dp[i][j] = LCS length of a[i:] and b[j:]
    const dp = [];
    for (let i = 0; i <= n; i++)
        dp.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        const row = dp[i];
        const next = dp[i + 1];
        for (let j = m - 1; j >= 0; j--) {
            row[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
        }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            res[j] = i;
            i++;
            j++;
        }
        else if (dp[i + 1][j] >= dp[i][j + 1]) {
            i++;
        }
        else {
            j++;
        }
    }
    return res;
}
const rgbEq = (a, b) => a.r === b.r && a.g === b.g && a.b === b.b;
/**
 * Plan how to draw the edited block: preserved original glyphs stay as glyph runs, new text
 * becomes substitute-font text runs. `measure` returns a substitute glyph's advance width.
 */
export function planEditedBlock(origText, anchors, editedText, geom, measure, newColor) {
    const match = lcsMatch(origText, editedText);
    // Per-character: the preserved anchor (if the char is unchanged and reusable), else null.
    const chars = [...editedText];
    // lcsMatch works on UTF-16 units; editedText here is expected to be BMP, so index alignment
    // holds. Map each char to its anchor.
    const perChar = [];
    {
        let u = 0; // utf-16 index
        for (const ch of chars) {
            const mi = match[u] ?? -1;
            perChar.push({ ch, anchor: mi >= 0 ? (anchors[mi] ?? null) : null });
            u += ch.length;
        }
    }
    // Split into lines on hard breaks.
    const lines = [[]];
    for (const c of perChar) {
        if (c.ch === "\n")
            lines.push([]);
        else
            lines[lines.length - 1].push(c);
    }
    const widthOf = (c) => c.anchor ? c.anchor.width : measure(c.ch, geom.size);
    const segs = [];
    lines.forEach((line, li) => {
        const y = geom.firstBaseline - li * geom.lineHeight;
        const lineW = line.reduce((a, c) => a + widthOf(c), 0);
        let x = geom.x;
        if (geom.align === "center")
            x = geom.x + (geom.width - lineW) / 2;
        else if (geom.align === "right")
            x = geom.x + geom.width - lineW;
        let i = 0;
        while (i < line.length) {
            const c = line[i];
            if (c.anchor) {
                // group consecutive preserved glyphs with the same font/size/color
                const a0 = c.anchor;
                let hex = "";
                const startX = x;
                while (i < line.length) {
                    const a = line[i].anchor;
                    if (!a || a.fontRes !== a0.fontRes || a.size !== a0.size || !rgbEq(a.color, a0.color))
                        break;
                    hex += a.hex;
                    x += a.width;
                    i++;
                }
                segs.push({ kind: "glyph", fontRes: a0.fontRes, size: a0.size, color: a0.color, x: startX, y, hex });
            }
            else {
                // group consecutive new characters
                let text = "";
                const startX = x;
                while (i < line.length && !line[i].anchor) {
                    text += line[i].ch;
                    x += widthOf(line[i]);
                    i++;
                }
                segs.push({ kind: "text", text, size: geom.size, color: newColor, x: startX, y });
            }
        }
    });
    return segs;
}
