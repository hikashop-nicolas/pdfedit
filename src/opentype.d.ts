// Minimal ambient types for opentype.js (only the font-building surface we use).
declare module "opentype.js" {
  export class Path {
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    quadraticCurveTo(x1: number, y1: number, x: number, y: number): void;
    curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void;
    close(): void;
  }
  export class Glyph {
    constructor(opts: { name: string; unicode?: number; advanceWidth: number; path: Path });
  }
  export class Font {
    constructor(opts: {
      familyName: string;
      styleName: string;
      unitsPerEm: number;
      ascender: number;
      descender: number;
      glyphs: Glyph[];
    });
    toArrayBuffer(): ArrayBuffer;
  }
  const opentype: { Path: typeof Path; Glyph: typeof Glyph; Font: typeof Font };
  export default opentype;
}
