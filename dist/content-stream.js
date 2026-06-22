// Read text directly from a PDF page's raw content stream.
//
// pdf.js getTextContent decodes each glyph to Unicode (via ToUnicode / a fallback) and
// throws away the original byte codes and font resource. That is fine for display, but it
// means a glyph whose font has no usable Unicode/cmap (a subset CID font, a symbol font)
// can never be reproduced on export. This module keeps the original truth: for every shown
// glyph we record its page font resource (e.g. "F3"), its exact byte code, its position and
// size. Re-emitting those verbatim renders the original glyph exactly as the viewer does,
// with no decoding required, which is what lets edits preserve such glyphs.
//
// It is a focused content-stream interpreter: it tracks the graphics/text matrices and the
// current font, and emits a run per text-showing operator. It is pure (no DOM, no pdf.js).
const WS = " \t\r\n\f\0";
const DELIM = "()<>[]{}/%";
/** Tokenize a (decoded) content stream. Inline images (BI..EI) are skipped wholesale. */
export function tokenizeContentStream(s) {
    const toks = [];
    let i = 0;
    const n = s.length;
    while (i < n) {
        const c = s[i];
        if (WS.includes(c)) {
            i++;
            continue;
        }
        if (c === "%") {
            while (i < n && s[i] !== "\n" && s[i] !== "\r")
                i++;
            continue;
        }
        if (c === "(") {
            // literal string: balanced parens, backslash escapes
            let depth = 1;
            let j = i + 1;
            let str = "";
            while (j < n && depth > 0) {
                const ch = s[j];
                if (ch === "\\") {
                    str += s[j + 1] ?? "";
                    j += 2;
                    continue;
                }
                if (ch === "(")
                    depth++;
                else if (ch === ")") {
                    depth--;
                    if (depth === 0)
                        break;
                }
                str += ch;
                j++;
            }
            toks.push({ t: "str", v: str });
            i = j + 1;
            continue;
        }
        if (c === "<" && s[i + 1] === "<") {
            toks.push({ t: "op", v: "<<" });
            i += 2;
            continue;
        }
        if (c === ">" && s[i + 1] === ">") {
            toks.push({ t: "op", v: ">>" });
            i += 2;
            continue;
        }
        if (c === "<") {
            let j = i + 1;
            let h = "";
            while (j < n && s[j] !== ">") {
                if (!WS.includes(s[j]))
                    h += s[j];
                j++;
            }
            toks.push({ t: "hex", v: h });
            i = j + 1;
            continue;
        }
        if (c === "[" || c === "]") {
            toks.push({ t: "op", v: c });
            i++;
            continue;
        }
        if (c === "/") {
            let j = i + 1;
            let nm = "";
            while (j < n && !WS.includes(s[j]) && !DELIM.includes(s[j])) {
                nm += s[j];
                j++;
            }
            toks.push({ t: "name", v: nm });
            i = j;
            continue;
        }
        if (c === "-" || c === "+" || c === "." || (c >= "0" && c <= "9")) {
            let j = i;
            let num = "";
            while (j < n && "+-.0123456789eE".includes(s[j])) {
                num += s[j];
                j++;
            }
            toks.push({ t: "num", v: parseFloat(num) });
            i = j;
            continue;
        }
        // operator (also handles inline images: skip from BI to EI)
        let j = i;
        let op = "";
        while (j < n && !WS.includes(s[j]) && !DELIM.includes(s[j])) {
            op += s[j];
            j++;
        }
        if (op === "BI") {
            const ei = s.indexOf("EI", j);
            j = ei < 0 ? n : ei + 2;
        }
        toks.push({ t: "op", v: op });
        i = j;
    }
    return toks;
}
const mul = (A, B) => [
    A[0] * B[0] + A[1] * B[2],
    A[0] * B[1] + A[1] * B[3],
    A[2] * B[0] + A[3] * B[2],
    A[2] * B[1] + A[3] * B[3],
    A[4] * B[0] + A[5] * B[2] + B[4],
    A[4] * B[1] + A[5] * B[3] + B[5],
];
/**
 * Extract the text-showing runs from a decoded content stream, in document order, with the
 * original font resource, glyph codes and user-space position of each run.
 */
export function extractTextRuns(content) {
    const toks = tokenizeContentStream(content);
    const runs = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    let tm = [1, 0, 0, 1, 0, 0];
    let tlm = [1, 0, 0, 1, 0, 0];
    let leading = 0;
    let fontRes = "";
    let fontSize = 0;
    let operands = [];
    const nums = () => operands.filter((t) => t.t === "num").map((t) => t.v);
    for (const tk of toks) {
        if (tk.t !== "op") {
            operands.push(tk);
            continue;
        }
        const o = tk.v;
        // "[" / "]" delimit a TJ array; keep them as operands rather than clearing.
        if (o === "[" || o === "]") {
            operands.push(tk);
            continue;
        }
        const a = nums();
        switch (o) {
            case "q":
                stack.push(ctm.slice());
                break;
            case "Q":
                ctm = stack.pop() ?? ctm;
                break;
            case "cm":
                if (a.length >= 6)
                    ctm = mul([a[0], a[1], a[2], a[3], a[4], a[5]], ctm);
                break;
            case "BT":
                tm = [1, 0, 0, 1, 0, 0];
                tlm = [1, 0, 0, 1, 0, 0];
                break;
            case "Tf": {
                const nm = operands.filter((t) => t.t === "name").pop();
                if (nm)
                    fontRes = nm.v;
                if (a.length)
                    fontSize = a[a.length - 1];
                break;
            }
            case "TL":
                if (a.length)
                    leading = a[a.length - 1];
                break;
            case "Tm":
                if (a.length >= 6) {
                    tm = [a[0], a[1], a[2], a[3], a[4], a[5]];
                    tlm = tm.slice();
                }
                break;
            case "Td":
                if (a.length >= 2) {
                    tlm = mul([1, 0, 0, 1, a[0], a[1]], tlm);
                    tm = tlm.slice();
                }
                break;
            case "TD":
                if (a.length >= 2) {
                    leading = -a[1];
                    tlm = mul([1, 0, 0, 1, a[0], a[1]], tlm);
                    tm = tlm.slice();
                }
                break;
            case "T*":
                tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
                tm = tlm.slice();
                break;
            case "'":
            case '"':
            case "Tj":
            case "TJ": {
                if (o === "'" || o === '"') {
                    tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
                    tm = tlm.slice();
                }
                const M = mul(tm, ctm);
                const size = fontSize * Math.hypot(M[2], M[3]);
                const elements = [];
                let hex = "";
                for (const t of operands) {
                    if (t.t === "hex") {
                        elements.push({ hex: t.v });
                        hex += t.v;
                    }
                    else if (t.t === "str") {
                        const h = strToHex(t.v);
                        elements.push({ hex: h });
                        hex += h;
                    }
                    else if (t.t === "num") {
                        elements.push({ kern: t.v });
                    }
                }
                if (hex)
                    runs.push({ fontRes, size, x: M[4], y: M[5], hex, elements });
                break;
            }
            default:
                break;
        }
        operands = [];
    }
    return runs;
}
const strToHex = (s) => {
    let h = "";
    for (let i = 0; i < s.length; i++)
        h += s.charCodeAt(i).toString(16).padStart(2, "0");
    return h;
};
/**
 * Lay out every shown glyph with its user-space position and advance, using the per-font
 * advance widths. This resolves glyph positions inside a single big TJ (the common case),
 * which is what lets each glyph be anchored to the edited text and re-emitted on its own.
 */
export function layoutGlyphs(content, metricsOf) {
    const toks = tokenizeContentStream(content);
    const glyphs = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    let tm = [1, 0, 0, 1, 0, 0];
    let tlm = [1, 0, 0, 1, 0, 0];
    let leading = 0;
    let fontRes = "";
    let fontSize = 0;
    let tc = 0; // char spacing
    let tw = 0; // word spacing
    let th = 1; // horizontal scale (Tz/100)
    let tr = 0; // text render mode
    let fill = [0, 0, 0]; // non-stroking fill colour
    let operands = [];
    const nums = () => operands.filter((t) => t.t === "num").map((t) => t.v);
    const isVisible = () => {
        if (tr === 3 || tr === 7)
            return false; // invisible / clip-only text
        const hasFill = tr === 0 || tr === 2 || tr === 4 || tr === 6;
        const white = fill[0] >= 0.95 && fill[1] >= 0.95 && fill[2] >= 0.95;
        return !(hasFill && white); // white fill on a (white) page is invisible
    };
    const showElements = (els) => {
        const fm = metricsOf(fontRes);
        if (!fm)
            return;
        const bpc = fm.bytesPerCode;
        const visible = isVisible();
        for (const el of els) {
            if (el.t === "num") {
                // TJ kerning: shift left by num/1000 * size (in text space), scaled by th
                const tx = (-el.v / 1000) * fontSize * th;
                tm = mul([1, 0, 0, 1, tx, 0], tm);
                continue;
            }
            const hex = el.t === "hex" ? el.v : strToHex(el.v);
            for (let i = 0; i + bpc * 2 <= hex.length; i += bpc * 2) {
                const codeHex = hex.slice(i, i + bpc * 2);
                const code = parseInt(codeHex, 16);
                const M = mul(tm, ctm);
                const size = fontSize * Math.hypot(M[2], M[3]);
                const w0 = fm.width(code); // glyph-space (1000em)
                const isSpace = bpc === 1 && code === 32;
                const tx = ((w0 / 1000) * fontSize + tc + (isSpace ? tw : 0)) * th;
                const widthUser = tx * Math.hypot(M[0], M[1]);
                glyphs.push({ fontRes, code, hex: codeHex, x: M[4], y: M[5], width: widthUser, size, visible });
                tm = mul([1, 0, 0, 1, tx, 0], tm);
            }
        }
    };
    let arr = null;
    for (const tk of toks) {
        if (tk.t !== "op") {
            if (arr)
                arr.push(tk);
            else
                operands.push(tk);
            continue;
        }
        const o = tk.v;
        if (o === "[") {
            arr = [];
            continue;
        }
        if (o === "]") {
            operands.push({ t: "op", v: "__arr__" }); // marker; elements live in `arr`
            continue;
        }
        const a = nums();
        switch (o) {
            case "q":
                stack.push(ctm.slice());
                break;
            case "Q":
                ctm = stack.pop() ?? ctm;
                break;
            case "cm":
                if (a.length >= 6)
                    ctm = mul([a[0], a[1], a[2], a[3], a[4], a[5]], ctm);
                break;
            case "BT":
                tm = [1, 0, 0, 1, 0, 0];
                tlm = [1, 0, 0, 1, 0, 0];
                break;
            case "Tf": {
                const nm = operands.filter((t) => t.t === "name").pop();
                if (nm)
                    fontRes = nm.v;
                if (a.length)
                    fontSize = a[a.length - 1];
                break;
            }
            case "Tr":
                if (a.length)
                    tr = a[a.length - 1];
                break;
            case "rg":
                if (a.length >= 3)
                    fill = [a[a.length - 3], a[a.length - 2], a[a.length - 1]];
                break;
            case "g":
                if (a.length)
                    fill = [a[a.length - 1], a[a.length - 1], a[a.length - 1]];
                break;
            case "k": {
                if (a.length >= 4) {
                    const [c, m, y, kk] = a.slice(-4);
                    fill = [(1 - c) * (1 - kk), (1 - m) * (1 - kk), (1 - y) * (1 - kk)];
                }
                break;
            }
            case "Tc":
                if (a.length)
                    tc = a[a.length - 1];
                break;
            case "Tw":
                if (a.length)
                    tw = a[a.length - 1];
                break;
            case "Tz":
                if (a.length)
                    th = a[a.length - 1] / 100;
                break;
            case "TL":
                if (a.length)
                    leading = a[a.length - 1];
                break;
            case "Tm":
                if (a.length >= 6) {
                    tm = [a[0], a[1], a[2], a[3], a[4], a[5]];
                    tlm = tm.slice();
                }
                break;
            case "Td":
                if (a.length >= 2) {
                    tlm = mul([1, 0, 0, 1, a[0], a[1]], tlm);
                    tm = tlm.slice();
                }
                break;
            case "TD":
                if (a.length >= 2) {
                    leading = -a[1];
                    tlm = mul([1, 0, 0, 1, a[0], a[1]], tlm);
                    tm = tlm.slice();
                }
                break;
            case "T*":
                tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
                tm = tlm.slice();
                break;
            case "'":
            case '"':
            case "Tj":
            case "TJ": {
                if (o === "'" || o === '"') {
                    tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
                    tm = tlm.slice();
                }
                const els = arr ?? operands.filter((t) => t.t === "hex" || t.t === "str");
                showElements(els);
                break;
            }
            default:
                break;
        }
        operands = [];
        arr = null;
    }
    return glyphs;
}
