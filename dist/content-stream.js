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
