import { describe, expect, it } from "vitest";
import { extractTextRuns, tokenizeContentStream } from "./content-stream";

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
