import { describe, expect, it } from "vitest";
import {
  buildLines,
  buildParagraphs,
  detectAlign,
  itemWidth,
  joinItems,
  median,
  normalizePua,
  toPua,
  variance,
  wantSpace,
  type RunItem,
} from "./reflow";

// A run item at (x, y) with an explicit reported width; size defaults to 10.
const run = (str: string, x: number, y: number, w = str.length * 5, size = 10): RunItem => ({ str, x, y, w, size, fontName: "F" });

describe("PUA normalization", () => {
  it("maps Private Use Area codes to ASCII and back", () => {
    const pua = String.fromCharCode(0xf041, 0xf042); // 'A','B' in a symbol font's PUA
    expect(normalizePua(pua)).toBe("AB");
    expect(toPua("AB")).toBe(pua);
  });
  it("leaves plain text untouched (fast path)", () => {
    expect(normalizePua("hello")).toBe("hello");
  });
});

describe("itemWidth", () => {
  it("trusts a plausible reported width", () => {
    expect(itemWidth(run("hi", 0, 0, 12))).toBe(12);
  });
  it("falls back to an estimate when the reported width is garbage", () => {
    // A subset font reporting 9999 for a 2-char run at size 10 is implausible.
    expect(itemWidth(run("hi", 0, 0, 9999))).toBe(2 * 10 * 0.5);
  });
  it("estimates when width is zero or negative", () => {
    expect(itemWidth(run("abcd", 0, 0, 0))).toBe(4 * 10 * 0.5);
  });
});

describe("wantSpace", () => {
  it("inserts a space across a positional gap", () => {
    expect(wantSpace(5, 10, "Label:", "value")).toBe(true); // gap > size*0.2
  });
  it("inserts a space across a strong overlap", () => {
    expect(wantSpace(-8, 10, "a", "b")).toBe(true); // gap < -size*0.5
  });
  it("does not double up when whitespace already borders the seam", () => {
    expect(wantSpace(5, 10, "Label: ", "value")).toBe(false);
    expect(wantSpace(5, 10, "Label:", " value")).toBe(false);
  });
  it("does not insert for a tight gap", () => {
    expect(wantSpace(1, 10, "a", "b")).toBe(false);
  });
});

describe("joinItems", () => {
  it("joins adjacent runs with no gap into one word", () => {
    expect(joinItems([run("Hel", 0, 0, 15), run("lo", 15, 0, 10)])).toBe("Hello");
  });
  it("inserts a space where a label meets a value with a positional gap", () => {
    // "Name" ends at x=20; value starts at x=40 -> gap of 20 (> size*0.2).
    expect(joinItems([run("Name", 0, 0, 20), run("Ada", 40, 0, 15)])).toBe("Name Ada");
  });
});

describe("stats", () => {
  it("median handles even, odd and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
  it("variance is zero for fewer than two samples", () => {
    expect(variance([5])).toBe(0);
    expect(variance([2, 2, 2])).toBe(0);
    expect(variance([0, 10])).toBe(25);
  });
});

describe("buildLines", () => {
  it("groups items on the same baseline into one line, top-to-bottom", () => {
    const lines = buildLines([run("world", 30, 100), run("hello", 0, 100), run("second", 0, 80)]);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.text).toBe("hello world"); // higher y first, x-sorted, spaced by gap
    expect(lines[1]!.text).toBe("second");
  });
  it("tolerates a small baseline wobble (sub/superscript jitter)", () => {
    const lines = buildLines([run("a", 0, 100), run("b", 12, 102)]); // 2px < size*0.4
    expect(lines).toHaveLength(1);
  });
  it("splits a baseline at a wide horizontal gap (column boundary)", () => {
    // A footer label at x=0 and a page number far right share a baseline but are separate.
    const lines = buildLines([run("Footer", 0, 50, 30), run("12", 200, 50, 10)]);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.text).sort()).toEqual(["12", "Footer"]);
  });
});

describe("buildParagraphs", () => {
  const line = (text: string, x: number, y: number, size = 10): RunItem => run(text, x, y, text.length * 5, size);

  it("joins evenly-spaced, left-aligned lines of one size into a single block", () => {
    const paras = buildParagraphs([line("line one", 0, 100), line("line two", 0, 85), line("line three", 0, 70)]);
    expect(paras).toHaveLength(1);
    expect(paras[0]).toHaveLength(3);
  });
  it("starts a new block when the font size changes (heading over body)", () => {
    const paras = buildParagraphs([line("Heading", 0, 100, 20), line("body text", 0, 78, 10)]);
    expect(paras).toHaveLength(2);
  });
  it("keeps side-by-side columns as separate blocks", () => {
    const paras = buildParagraphs([
      line("left a", 0, 100),
      line("left b", 0, 85),
      line("right a", 300, 100),
      line("right b", 300, 85),
    ]);
    expect(paras).toHaveLength(2);
  });
  it("splits blocks across a large vertical gap", () => {
    const paras = buildParagraphs([line("para one", 0, 200), line("para one cont", 0, 185), line("far below", 0, 40)]);
    expect(paras.length).toBeGreaterThan(1);
  });
});

describe("detectAlign", () => {
  const L = (minX: number, maxX: number, size = 10): { items: RunItem[]; y: number; minX: number; maxX: number; size: number; text: string } => ({
    items: [],
    y: 0,
    minX,
    maxX,
    size,
    text: "x",
  });

  it("detects left alignment (flush left, ragged right)", () => {
    expect(detectAlign([L(0, 100), L(0, 60), L(0, 90)], 0, 100, 600)).toBe("left");
  });
  it("detects right alignment (flush right, ragged left)", () => {
    expect(detectAlign([L(0, 100), L(40, 100), L(10, 100)], 0, 100, 600)).toBe("right");
  });
  it("detects justified text (both edges flush; last line ignored)", () => {
    expect(detectAlign([L(0, 100), L(0, 100), L(0, 40)], 0, 100, 600)).toBe("justify");
  });
  it("detects centered text (centers align, edges ragged)", () => {
    // Centers all at 50, but the left and right edges vary well beyond tolerance,
    // so neither edge reads as flush and center wins over justify.
    expect(detectAlign([L(20, 80), L(40, 60), L(10, 90)], 10, 90, 600)).toBe("center");
  });
});
