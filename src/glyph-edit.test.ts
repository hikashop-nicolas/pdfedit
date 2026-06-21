import { describe, expect, it } from "vitest";
import { lcsMatch, planEditedBlock, type Anchor, type BlockGeom } from "./glyph-edit";

describe("lcsMatch", () => {
  it("matches unchanged characters and marks inserted ones as -1", () => {
    // remove "ab" prefix: "abXY" -> "XY"
    expect(Array.from(lcsMatch("abXY", "XY"))).toEqual([2, 3]);
    // insert: "XY" -> "XZY"
    expect(Array.from(lcsMatch("XY", "XZY"))).toEqual([0, -1, 1]);
  });
});

const C = (r: number, g: number, b: number) => ({ r, g, b });
const A = (fontRes: string, hex: string, width = 10): Anchor => ({ fontRes, hex, width, size: 10, color: C(0, 0, 0) });
const geom: BlockGeom = { x: 100, firstBaseline: 700, lineHeight: 12, width: 500, align: "left", size: 10 };

describe("planEditedBlock", () => {
  it("re-emits original glyphs verbatim for unchanged text", () => {
    // orig "AB" drawn by /F1 codes 0041 0042; edit leaves it unchanged
    const orig = "AB";
    const anchors = [A("F1", "0041"), A("F1", "0042")];
    const segs = planEditedBlock(orig, anchors, "AB", geom, () => 10, C(0, 0, 0));
    expect(segs).toEqual([{ kind: "glyph", fontRes: "F1", size: 10, color: C(0, 0, 0), x: 100, y: 700, hex: "00410042" }]);
  });

  it("preserves the kept tail's original glyphs when a prefix is deleted", () => {
    // orig "XYab" (a,b are special /F3 glyphs); user deletes "XY"
    const orig = "XYab";
    const anchors = [A("F1", "0058"), A("F1", "0059"), A("F3", "0005"), A("F3", "0006")];
    const segs = planEditedBlock(orig, anchors, "ab", geom, () => 10, C(0, 0, 0));
    // the kept "ab" must re-emit the original /F3 glyphs, now at the block's left edge
    expect(segs).toEqual([{ kind: "glyph", fontRes: "F3", size: 10, color: C(0, 0, 0), x: 100, y: 700, hex: "00050006" }]);
  });

  it("splits preserved glyphs from newly typed text", () => {
    // orig "ab" (/F3); user types "Z" before it -> "Zab"
    const orig = "ab";
    const anchors = [A("F3", "0005"), A("F3", "0006")];
    const segs = planEditedBlock(orig, anchors, "Zab", geom, () => 7, C(0.1, 0.1, 0.1));
    expect(segs).toEqual([
      { kind: "text", text: "Z", size: 10, color: C(0.1, 0.1, 0.1), x: 100, y: 700 },
      { kind: "glyph", fontRes: "F3", size: 10, color: C(0, 0, 0), x: 107, y: 700, hex: "00050006" },
    ]);
  });

  it("lays out hard line breaks on separate baselines", () => {
    const orig = "a\nb";
    const anchors = [A("F1", "0061"), null, A("F1", "0062")];
    const segs = planEditedBlock(orig, anchors, "a\nb", geom, () => 10, C(0, 0, 0));
    expect(segs).toEqual([
      { kind: "glyph", fontRes: "F1", size: 10, color: C(0, 0, 0), x: 100, y: 700, hex: "0061" },
      { kind: "glyph", fontRes: "F1", size: 10, color: C(0, 0, 0), x: 100, y: 688, hex: "0062" },
    ]);
  });
});
