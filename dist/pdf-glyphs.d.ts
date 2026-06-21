import { type PDFDocument } from "pdf-lib";
import { type PlacedGlyph } from "./content-stream";
/** Placed glyphs (font resource, byte code, user-space position) for one page. */
export declare function pageGlyphs(pdf: PDFDocument, pageIndex: number): PlacedGlyph[];
