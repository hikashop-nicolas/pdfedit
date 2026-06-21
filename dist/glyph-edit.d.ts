export interface RGB {
    r: number;
    g: number;
    b: number;
}
/** What originally drew one character of the block's text. null = no reusable glyph. */
export interface Anchor {
    fontRes: string;
    hex: string;
    width: number;
    size: number;
    color: RGB;
}
export interface BlockGeom {
    x: number;
    firstBaseline: number;
    lineHeight: number;
    width: number;
    align: "left" | "center" | "right" | "justify";
    size: number;
}
export type DrawSeg = {
    kind: "glyph";
    fontRes: string;
    size: number;
    color: RGB;
    x: number;
    y: number;
    hex: string;
} | {
    kind: "text";
    text: string;
    size: number;
    color: RGB;
    x: number;
    y: number;
};
/**
 * For each character of b, the index of the character in a it was matched to (longest common
 * subsequence), or -1 if it is new. Bounded: returns all -1 if the product is huge.
 */
export declare function lcsMatch(a: string, b: string): Int32Array;
/**
 * Plan how to draw the edited block: preserved original glyphs stay as glyph runs, new text
 * becomes substitute-font text runs. `measure` returns a substitute glyph's advance width.
 */
export declare function planEditedBlock(origText: string, anchors: (Anchor | null)[], editedText: string, geom: BlockGeom, measure: (ch: string, size: number) => number, newColor: RGB): DrawSeg[];
