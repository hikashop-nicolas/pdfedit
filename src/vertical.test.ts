import { describe, it, expect } from "vitest";
import { detectVertical, buildVerticalBlocks, layoutVerticalGlyphs } from "./vertical";

// A RunItem-shaped glyph (only the fields the grouping reads).
const g = (str: string, x: number, y: number, size = 12) => ({ str, x, y, w: size, size, fontName: "f1" });

// Three columns of five kanji each, glyphs stepping down (y decreasing), columns
// right-to-left. Items are pushed in reading order (down the rightmost column first).
function tategaki() {
  const cols = [
    { x: 100, chars: ["一", "二", "三", "四", "五"] },
    { x: 86, chars: ["六", "七", "八", "九", "十"] },
    { x: 72, chars: ["百", "千", "万", "億", "兆"] },
  ];
  const items: ReturnType<typeof g>[] = [];
  for (const c of cols) c.chars.forEach((ch, i) => items.push(g(ch, c.x, 200 - i * 12)));
  return items;
}

describe("vertical (tategaki) detection and grouping", () => {
  it("detects a page of down-stepping single glyphs as vertical", () => {
    expect(detectVertical(tategaki())).toBe(true);
  });

  it("does not misclassify horizontal prose (multi-char items) as vertical", () => {
    const words = ["The", "quick", "brown", "fox", "jumps", "over", "the", "lazy", "dog"];
    let x = 50;
    const items = words.map((w) => {
      const it = g(w, x, 200, 12);
      x += w.length * 7 + 6;
      return it;
    });
    expect(detectVertical(items)).toBe(false);
  });

  it("does not misclassify horizontal single glyphs (stepping right) as vertical", () => {
    const items = "一二三四五六七八九十百千".split("").map((ch, i) => g(ch, 50 + i * 12, 200));
    expect(detectVertical(items)).toBe(false);
  });

  it("groups glyphs into right-to-left columns, each read top-to-bottom", () => {
    const blocks = buildVerticalBlocks(tategaki());
    expect(blocks.length).toBe(1);
    const cols = blocks[0]!;
    expect(cols.map((c) => c.x)).toEqual([100, 86, 72]); // right-to-left
    expect(cols.map((c) => c.text)).toEqual(["一二三四五", "六七八九十", "百千万億兆"]);
    // top-to-bottom within a column: first glyph has the largest y
    expect(cols[0]!.items[0]!.str).toBe("一");
    expect(cols[0]!.maxY).toBeGreaterThan(cols[0]!.minY);
  });

  it("splits far-apart column groups into separate blocks", () => {
    const near = tategaki();
    const far = near.map((it) => ({ ...it, x: it.x - 400 })); // a second group well to the left
    const blocks = buildVerticalBlocks([...near, ...far]);
    expect(blocks.length).toBe(2);
  });

  it("splits into separate blocks when the column spacing changes", () => {
    // Paragraph A: 3 columns at pitch 20; paragraph B: 3 columns at pitch 32, a wider gap apart.
    const col = (x: number, chars: string[]) => chars.map((ch, i) => g(ch, x, 200 - i * 12));
    const items = [
      ...col(200, ["あ", "い", "う"]),
      ...col(180, ["か", "き", "く"]),
      ...col(160, ["さ", "し", "す"]),
      ...col(100, ["た", "ち", "つ"]),
      ...col(68, ["な", "に", "ぬ"]),
      ...col(36, ["は", "ひ", "ふ"]),
    ];
    const blocks = buildVerticalBlocks(items);
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.map((c) => c.x)).toEqual([200, 180, 160]);
    expect(blocks[1]!.map((c) => c.x)).toEqual([100, 68, 36]);
  });
});

describe("vertical export layout", () => {
  const P = { startX: 100, topY: 200, pitch: 14, bottom: 152 }; // column spans y=200..152 (5 glyphs of 12)

  it("places glyphs down a column, then columns right-to-left on <br>", () => {
    const runs = [
      { text: "一二三", size: 12, brAfter: true },
      { text: "四五六", size: 12 },
    ];
    const g = layoutVerticalGlyphs(runs, P);
    expect(g.map((x) => x.ch)).toEqual(["一", "二", "三", "四", "五", "六"]);
    // column 1 at startX, stepping down by size
    expect(g.slice(0, 3)).toEqual([
      { runIndex: 0, ch: "一", x: 100, y: 200 },
      { runIndex: 0, ch: "二", x: 100, y: 188 },
      { runIndex: 0, ch: "三", x: 100, y: 176 },
    ]);
    // column 2 (after <br>) is one pitch to the left, back at the top
    expect(g[3]).toEqual({ runIndex: 1, ch: "四", x: 86, y: 200 });
    expect(g[5]).toEqual({ runIndex: 1, ch: "六", x: 86, y: 176 });
  });

  it("wraps a long column past the bottom to the next column left", () => {
    const runs = [{ text: "一二三四五六七", size: 12 }]; // column holds 5 (y=200..152); 六 overflows
    const g = layoutVerticalGlyphs(runs, P);
    expect(g.find((x) => x.ch === "一")!.x).toBe(100);
    const wrapped = g.find((x) => x.ch === "六")!;
    expect(wrapped).toEqual({ runIndex: 0, ch: "六", x: 86, y: 200 }); // next column left, back at top
    expect(g.find((x) => x.ch === "七")!).toEqual({ runIndex: 0, ch: "七", x: 86, y: 188 });
  });
});
