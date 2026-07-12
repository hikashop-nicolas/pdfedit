import { describe, expect, it } from "vitest";
import { extractTextRuns, layoutGlyphs, tokenizeContentStream, type FontMetrics } from "./content-stream";

describe("tokenizeContentStream", () => {
  it("tokenizes numbers, names, hex/literal strings and operators", () => {
    const toks = tokenizeContentStream("/F1 12 Tf <0041> Tj (Bd) Tj");
    expect(toks).toEqual([
      { t: "name", v: "F1" },
      { t: "num", v: 12 },
      { t: "op", v: "Tf" },
      { t: "hex", v: "0041" },
      { t: "op", v: "Tj" },
      { t: "str", v: "Bd" },
      { t: "op", v: "Tj" },
    ]);
  });

  it("skips inline images and comments", () => {
    const toks = tokenizeContentStream("% a comment\nBI /W 1 ID \x00\x01 EI 5 g");
    expect(toks).toEqual([
      { t: "op", v: "BI" },
      { t: "num", v: 5 },
      { t: "op", v: "g" },
    ]);
  });

  it("decodes octal and named escapes in a literal string", () => {
    // \101 = octal 'A', \t = tab, \\ = backslash, \) = ), \n = newline.
    const toks = tokenizeContentStream("(\\101\\t\\\\\\)\\n) Tj");
    expect(toks[0]).toEqual({ t: "str", v: "A\t\\)\n" });
  });

  it("treats backslash-newline as a line continuation (dropped)", () => {
    expect(tokenizeContentStream("(ab\\\ncd) Tj")[0]).toEqual({ t: "str", v: "abcd" });
    expect(tokenizeContentStream("(ab\\\r\ncd) Tj")[0]).toEqual({ t: "str", v: "abcd" });
  });

  it("stops an octal escape at three digits", () => {
    // \1015 -> octal '101' ('A') then a literal '5'.
    expect(tokenizeContentStream("(\\1015) Tj")[0]).toEqual({ t: "str", v: "A5" });
  });
});

describe("extractTextRuns", () => {
  it("captures font resource, position, size and codes from a Tm/TJ run", () => {
    const cs = "BT /F3 10 Tf 1 0 0 1 100 200 Tm [<0005>-4<0006>] TJ ET";
    const runs = extractTextRuns(cs);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ fontRes: "F3", size: 10, x: 100, y: 200, hex: "00050006" });
    expect(runs[0]!.elements).toEqual([{ hex: "0005" }, { kern: -4 }, { hex: "0006" }]);
  });

  it("applies the CTM scale to position and size", () => {
    // cm scales by 0.5 and translates; size and origin scale with it
    const cs = "q 0.5 0 0 0.5 10 20 cm BT /F1 20 Tf 1 0 0 1 40 60 Tm <0041> Tj ET Q";
    const runs = extractTextRuns(cs);
    expect(runs).toHaveLength(1);
    // origin: (40,60) under Tm then cm -> (0.5*40+10, 0.5*60+20) = (30, 50); size 20*0.5 = 10
    expect(runs[0]).toMatchObject({ fontRes: "F1", x: 30, y: 50, size: 10, hex: "0041" });
  });

  it("advances lines with Td/TD/T* and tracks the font across runs", () => {
    const cs = "BT /F2 12 Tf 0 700 Td (a) Tj 0 -14 TD (b) Tj T* (c) Tj ET";
    const runs = extractTextRuns(cs);
    expect(runs.map((r) => [r.x, r.y, r.hex])).toEqual([
      [0, 700, "61"], // a
      [0, 686, "62"], // b (TD by -14)
      [0, 672, "63"], // c (T* uses leading 14 from TD)
    ]);
    expect(runs.every((r) => r.fontRes === "F2")).toBe(true);
  });
});

describe("layoutGlyphs", () => {
  const simple: FontMetrics = { bytesPerCode: 1, width: () => 500 };
  const cid: FontMetrics = { bytesPerCode: 2, width: () => 1000 };
  const metrics = (r: string) => (r === "C" ? cid : simple);

  it("places simple-font glyphs left to right using advance widths", () => {
    const g = layoutGlyphs("BT /F1 10 Tf 1 0 0 1 100 200 Tm (AB) Tj ET", metrics);
    expect(g.map((x) => [x.fontRes, x.hex, x.x, x.y, x.width, x.size])).toEqual([
      ["F1", "41", 100, 200, 5, 10], // A: advance 500/1000*10 = 5
      ["F1", "42", 105, 200, 5, 10], // B starts at 105
    ]);
  });

  it("splits a composite font's hex into 2-byte codes", () => {
    const g = layoutGlyphs("BT /C 10 Tf 1 0 0 1 0 0 Tm <00050006> Tj ET", metrics);
    expect(g.map((x) => [x.hex, x.code, x.x])).toEqual([
      ["0005", 5, 0], // advance 1000/1000*10 = 10
      ["0006", 6, 10],
    ]);
  });

  it("applies TJ kerning between glyphs", () => {
    const g = layoutGlyphs("BT /C 10 Tf 1 0 0 1 0 0 Tm [<0005>100<0006>] TJ ET", metrics);
    // 0005 at 0 (advance 10), kern 100 -> -1, 0006 at 10-1 = 9
    expect(g.map((x) => x.x)).toEqual([0, 9]);
  });

  it("marks white text invisible whether set via rg, g or scn", () => {
    const white = (setColor: string) => layoutGlyphs(`BT /F1 10 Tf 1 0 0 1 0 0 Tm ${setColor} (A) Tj ET`, metrics)[0]!.visible;
    expect(white("1 1 1 rg")).toBe(false);
    expect(white("1 g")).toBe(false);
    expect(white("1 1 1 scn")).toBe(false); // scn rgb white — previously missed
    expect(white("0 0 0 0 scn")).toBe(false); // scn cmyk 0,0,0,0 -> white
    expect(white("0 0 0 1 scn")).toBe(true); // scn cmyk key=1 -> black, visible
    expect(white("0 0 0 rg")).toBe(true); // black stays visible
  });

  it("keeps a pattern-filled (scn /P) run visible (not mistaken for white)", () => {
    const g = layoutGlyphs("BT /F1 10 Tf 1 0 0 1 0 0 Tm /P0 scn (A) Tj ET", metrics);
    expect(g[0]!.visible).toBe(true);
  });
});
