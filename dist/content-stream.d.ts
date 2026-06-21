/** Affine matrix [a, b, c, d, e, f] (row-vector convention: [x y 1] x M). */
export type Matrix = [number, number, number, number, number, number];
export interface Token {
    t: "num" | "str" | "hex" | "name" | "op";
    v: string | number;
}
/** One element of a TJ array: a shown string (hex bytes) or a kerning adjustment. */
export type RunElement = {
    hex: string;
} | {
    kern: number;
};
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
/** Tokenize a (decoded) content stream. Inline images (BI..EI) are skipped wholesale. */
export declare function tokenizeContentStream(s: string): Token[];
/**
 * Extract the text-showing runs from a decoded content stream, in document order, with the
 * original font resource, glyph codes and user-space position of each run.
 */
export declare function extractTextRuns(content: string): TextRun[];
