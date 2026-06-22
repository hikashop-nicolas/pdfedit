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
/** Advance metrics for one font resource. width is in 1000-unit glyph space. */
export interface FontMetrics {
    bytesPerCode: number;
    width(code: number): number;
}
export interface PlacedGlyph {
    fontRes: string;
    code: number;
    hex: string;
    x: number;
    y: number;
    width: number;
    size: number;
    visible: boolean;
}
/**
 * Lay out every shown glyph with its user-space position and advance, using the per-font
 * advance widths. This resolves glyph positions inside a single big TJ (the common case),
 * which is what lets each glyph be anchored to the edited text and re-emitted on its own.
 */
export declare function layoutGlyphs(content: string, metricsOf: (fontRes: string) => FontMetrics | undefined): PlacedGlyph[];
