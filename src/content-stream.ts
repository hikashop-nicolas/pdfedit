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

/** Affine matrix [a, b, c, d, e, f] (row-vector convention: [x y 1] x M). */
export type Matrix = [number, number, number, number, number, number];

export interface Token {
  t: "num" | "str" | "hex" | "name" | "op";
  v: string | number;
}

/** One element of a TJ array: a shown string (hex bytes) or a kerning adjustment. */
export type RunElement = { hex: string } | { kern: number };

export interface TextRun {
  /** Page font resource name without the leading slash, e.g. "F3". */
  fontRes: string;
  /** Effective font size in user space (font size times the matrix scale). */
  size: number;
  /** Run origin (baseline start) in PDF user space. */
  x: number;
  y: number;
  /** All shown bytes concatenated as hex (kerning removed) — the glyph codes. */
  hex: string;
  /** The TJ structure (strings + kerns), enough to re-emit the run verbatim. */
  elements: RunElement[];
}

const WS = " \t\r\n\f\0";
const DELIM = "()<>[]{}/%";

/** Tokenize a (decoded) content stream. Inline images (BI..EI) are skipped wholesale. */
export function tokenizeContentStream(s: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (WS.includes(c)) {
      i++;
      continue;
    }
    if (c === "%") {
      while (i < n && s[i] !== "\n" && s[i] !== "\r") i++;
      continue;
    }
    if (c === "(") {
      // literal string: balanced parens with backslash escapes (PDF 7.3.4.2). Escapes must be
      // decoded here, not passed through raw, or e.g. "\101" (octal 'A') and "\n" (a newline)
      // would be read as the literal characters '1','0','1' and 'n' and corrupt the glyph bytes.
      let depth = 1;
      let j = i + 1;
      let str = "";
      while (j < n && depth > 0) {
        const ch = s[j]!;
        if (ch === "\\") {
          const e = s[j + 1] ?? "";
          if (e >= "0" && e <= "7") {
            // octal escape \ddd, 1-3 digits
            let oct = e;
            let k = j + 2;
            while (k < n && oct.length < 3 && s[k]! >= "0" && s[k]! <= "7") {
              oct += s[k];
              k++;
            }
            str += String.fromCharCode(parseInt(oct, 8) & 0xff);
            j = k;
            continue;
          }
          switch (e) {
            case "n": str += "\n"; break;
            case "r": str += "\r"; break;
            case "t": str += "\t"; break;
            case "b": str += "\b"; break;
            case "f": str += "\f"; break;
            case "\r": if (s[j + 2] === "\n") j++; break; // line continuation (CR or CRLF): drop
            case "\n": break; // line continuation (LF): drop the newline
            default: str += e; break; // \( \) \\ and any other char: keep the char verbatim
          }
          j += 2;
          continue;
        }
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) break;
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
        if (!WS.includes(s[j]!)) h += s[j];
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
      while (j < n && !WS.includes(s[j]!) && !DELIM.includes(s[j]!)) {
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
      while (j < n && "+-.0123456789eE".includes(s[j]!)) {
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
    while (j < n && !WS.includes(s[j]!) && !DELIM.includes(s[j]!)) {
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

const mul = (A: Matrix, B: Matrix): Matrix => [
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
export function extractTextRuns(content: string): TextRun[] {
  const toks = tokenizeContentStream(content);
  const runs: TextRun[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let tm: Matrix = [1, 0, 0, 1, 0, 0];
  let tlm: Matrix = [1, 0, 0, 1, 0, 0];
  let leading = 0;
  let fontRes = "";
  let fontSize = 0;
  let operands: Token[] = [];
  const nums = () => operands.filter((t) => t.t === "num").map((t) => t.v as number);

  for (const tk of toks) {
    if (tk.t !== "op") {
      operands.push(tk);
      continue;
    }
    const o = tk.v as string;
    // "[" / "]" delimit a TJ array; keep them as operands rather than clearing.
    if (o === "[" || o === "]") {
      operands.push(tk);
      continue;
    }
    const a = nums();
    switch (o) {
      case "q":
        stack.push(ctm.slice() as Matrix);
        break;
      case "Q":
        ctm = stack.pop() ?? ctm;
        break;
      case "cm":
        if (a.length >= 6) ctm = mul([a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!], ctm);
        break;
      case "BT":
        tm = [1, 0, 0, 1, 0, 0];
        tlm = [1, 0, 0, 1, 0, 0];
        break;
      case "Tf": {
        const nm = operands.filter((t) => t.t === "name").pop();
        if (nm) fontRes = nm.v as string;
        if (a.length) fontSize = a[a.length - 1]!;
        break;
      }
      case "TL":
        if (a.length) leading = a[a.length - 1]!;
        break;
      case "Tm":
        if (a.length >= 6) {
          tm = [a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!];
          tlm = tm.slice() as Matrix;
        }
        break;
      case "Td":
        if (a.length >= 2) {
          tlm = mul([1, 0, 0, 1, a[0]!, a[1]!], tlm);
          tm = tlm.slice() as Matrix;
        }
        break;
      case "TD":
        if (a.length >= 2) {
          leading = -a[1]!;
          tlm = mul([1, 0, 0, 1, a[0]!, a[1]!], tlm);
          tm = tlm.slice() as Matrix;
        }
        break;
      case "T*":
        tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm.slice() as Matrix;
        break;
      case "'":
      case '"':
      case "Tj":
      case "TJ": {
        if (o === "'" || o === '"') {
          tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
          tm = tlm.slice() as Matrix;
        }
        const M = mul(tm, ctm);
        const size = fontSize * Math.hypot(M[2], M[3]);
        const elements: RunElement[] = [];
        let hex = "";
        for (const t of operands) {
          if (t.t === "hex") {
            elements.push({ hex: t.v as string });
            hex += t.v as string;
          } else if (t.t === "str") {
            const h = strToHex(t.v as string);
            elements.push({ hex: h });
            hex += h;
          } else if (t.t === "num") {
            elements.push({ kern: t.v as number });
          }
        }
        if (hex) runs.push({ fontRes, size, x: M[4], y: M[5], hex, elements });
        break;
      }
      default:
        break;
    }
    operands = [];
  }
  return runs;
}

const strToHex = (s: string): string => {
  let h = "";
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(2, "0");
  return h;
};

// ---------------------------------------------------------------------------
// Per-glyph layout
// ---------------------------------------------------------------------------

/** Advance metrics for one font resource. width is in 1000-unit glyph space. */
export interface FontMetrics {
  bytesPerCode: number; // 1 (simple) or 2 (Identity composite)
  width(code: number): number;
}

export interface PlacedGlyph {
  fontRes: string;
  code: number;
  hex: string; // exactly bytesPerCode*2 hex chars (the original byte code)
  x: number; // user-space origin
  y: number;
  width: number; // advance in user space
  size: number; // effective size in user space
  visible: boolean; // false for invisible text (render mode 3/7, or white fill on a white page)
}

/**
 * Lay out every shown glyph with its user-space position and advance, using the per-font
 * advance widths. This resolves glyph positions inside a single big TJ (the common case),
 * which is what lets each glyph be anchored to the edited text and re-emitted on its own.
 */
export function layoutGlyphs(content: string, metricsOf: (fontRes: string) => FontMetrics | undefined): PlacedGlyph[] {
  const toks = tokenizeContentStream(content);
  const glyphs: PlacedGlyph[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let tm: Matrix = [1, 0, 0, 1, 0, 0];
  let tlm: Matrix = [1, 0, 0, 1, 0, 0];
  let leading = 0;
  let fontRes = "";
  let fontSize = 0;
  let tc = 0; // char spacing
  let tw = 0; // word spacing
  let th = 1; // horizontal scale (Tz/100)
  let tr = 0; // text render mode
  let fill: [number, number, number] = [0, 0, 0]; // non-stroking fill colour
  let operands: Token[] = [];
  const nums = () => operands.filter((t) => t.t === "num").map((t) => t.v as number);

  const isVisible = (): boolean => {
    if (tr === 3 || tr === 7) return false; // invisible / clip-only text
    const hasFill = tr === 0 || tr === 2 || tr === 4 || tr === 6;
    const white = fill[0] >= 0.95 && fill[1] >= 0.95 && fill[2] >= 0.95;
    return !(hasFill && white); // white fill on a (white) page is invisible
  };

  const showElements = (els: Token[]) => {
    const fm = metricsOf(fontRes);
    if (!fm) return;
    const bpc = fm.bytesPerCode;
    const visible = isVisible();
    for (const el of els) {
      if (el.t === "num") {
        // TJ kerning: shift left by num/1000 * size (in text space), scaled by th
        const tx = (-(el.v as number) / 1000) * fontSize * th;
        tm = mul([1, 0, 0, 1, tx, 0], tm);
        continue;
      }
      const hex = el.t === "hex" ? (el.v as string) : strToHex(el.v as string);
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

  let arr: Token[] | null = null;
  for (const tk of toks) {
    if (tk.t !== "op") {
      if (arr) arr.push(tk);
      else operands.push(tk);
      continue;
    }
    const o = tk.v as string;
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
        stack.push(ctm.slice() as Matrix);
        break;
      case "Q":
        ctm = stack.pop() ?? ctm;
        break;
      case "cm":
        if (a.length >= 6) ctm = mul([a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!], ctm);
        break;
      case "BT":
        tm = [1, 0, 0, 1, 0, 0];
        tlm = [1, 0, 0, 1, 0, 0];
        break;
      case "Tf": {
        const nm = operands.filter((t) => t.t === "name").pop();
        if (nm) fontRes = nm.v as string;
        if (a.length) fontSize = a[a.length - 1]!;
        break;
      }
      case "Tr":
        if (a.length) tr = a[a.length - 1]!;
        break;
      case "rg":
        if (a.length >= 3) fill = [a[a.length - 3]!, a[a.length - 2]!, a[a.length - 1]!];
        break;
      case "g":
        if (a.length) fill = [a[a.length - 1]!, a[a.length - 1]!, a[a.length - 1]!];
        break;
      case "k": {
        if (a.length >= 4) {
          const [c, m, y, kk] = a.slice(-4) as [number, number, number, number];
          fill = [(1 - c) * (1 - kk), (1 - m) * (1 - kk), (1 - y) * (1 - kk)];
        }
        break;
      }
      case "sc":
      case "scn": {
        // Generic fill colour in the current colour space. Infer from the operand count the
        // same way g/rg/k do (1 = gray, 3 = rgb, 4 = cmyk); a pattern (scn /P with no numbers)
        // is left as-is so it is not mistaken for white.
        if (a.length === 4) {
          const [c, m, y, kk] = a.slice(-4) as [number, number, number, number];
          fill = [(1 - c) * (1 - kk), (1 - m) * (1 - kk), (1 - y) * (1 - kk)];
        } else if (a.length === 3) {
          fill = [a[a.length - 3]!, a[a.length - 2]!, a[a.length - 1]!];
        } else if (a.length === 1) {
          fill = [a[0]!, a[0]!, a[0]!];
        }
        break;
      }
      case "Tc":
        if (a.length) tc = a[a.length - 1]!;
        break;
      case "Tw":
        if (a.length) tw = a[a.length - 1]!;
        break;
      case "Tz":
        if (a.length) th = a[a.length - 1]! / 100;
        break;
      case "TL":
        if (a.length) leading = a[a.length - 1]!;
        break;
      case "Tm":
        if (a.length >= 6) {
          tm = [a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!];
          tlm = tm.slice() as Matrix;
        }
        break;
      case "Td":
        if (a.length >= 2) {
          tlm = mul([1, 0, 0, 1, a[0]!, a[1]!], tlm);
          tm = tlm.slice() as Matrix;
        }
        break;
      case "TD":
        if (a.length >= 2) {
          leading = -a[1]!;
          tlm = mul([1, 0, 0, 1, a[0]!, a[1]!], tlm);
          tm = tlm.slice() as Matrix;
        }
        break;
      case "T*":
        tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm.slice() as Matrix;
        break;
      case "'":
      case '"':
      case "Tj":
      case "TJ": {
        if (o === "'" || o === '"') {
          tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
          tm = tlm.slice() as Matrix;
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
