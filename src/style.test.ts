// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { StandardFonts } from "pdf-lib";
import {
  blockText,
  clamp255,
  cssColorToRgb,
  cssFamily,
  escapeHtml,
  familyOf,
  hex2,
  norm,
  normalizeStd,
  parseRuns,
  rgb255ToHex,
  standardFont,
  type Family,
} from "./style";

describe("familyOf", () => {
  it("classifies mono, sans and serif font names", () => {
    expect(familyOf("Courier New")).toBe("mono");
    expect(familyOf("Menlo")).toBe("mono");
    expect(familyOf("Helvetica Neue")).toBe("sans");
    expect(familyOf("Times New Roman")).toBe("serif");
    expect(familyOf("Georgia")).toBe("serif");
  });
  it("does not misread the CSS keyword 'sans-serif' as serif", () => {
    expect(familyOf("sans-serif")).toBe("sans");
  });
  it("falls back to sans for an unknown name", () => {
    expect(familyOf("Wingdings Fantasy")).toBe("sans");
  });
});

describe("cssFamily", () => {
  it("maps each family to a CSS stack", () => {
    expect(cssFamily("serif")).toContain("Times New Roman");
    expect(cssFamily("mono")).toBe("monospace");
    expect(cssFamily("sans")).toContain("Helvetica");
  });
});

describe("standardFont", () => {
  it("picks the right pdf-lib standard font per family and weight", () => {
    expect(standardFont("serif", false, false)).toBe(StandardFonts.TimesRoman);
    expect(standardFont("serif", true, true)).toBe(StandardFonts.TimesRomanBoldItalic);
    expect(standardFont("mono", true, false)).toBe(StandardFonts.CourierBold);
    expect(standardFont("sans", false, true)).toBe(StandardFonts.HelveticaOblique);
    expect(standardFont("sans", false, false)).toBe(StandardFonts.Helvetica);
  });
});

describe("colour helpers", () => {
  it("clamps to the byte range", () => {
    expect(clamp255(-5)).toBe(0);
    expect(clamp255(300)).toBe(255);
    expect(clamp255(127.6)).toBe(128);
  });
  it("formats a two-digit hex byte", () => {
    expect(hex2(0)).toBe("00");
    expect(hex2(255)).toBe("ff");
    expect(hex2(15)).toBe("0f");
  });
  it("builds a #rrggbb string from a 0..255 RGB", () => {
    expect(rgb255ToHex({ r: 255, g: 0, b: 16 })).toBe("#ff0010");
  });
  it("normalises a 0..255 colour to 0..1", () => {
    expect(norm({ r: 255, g: 0, b: 128 })).toEqual({ r: 1, g: 0, b: 128 / 255 });
  });
});

describe("escapeHtml", () => {
  it("escapes the markup-significant characters", () => {
    expect(escapeHtml('a & b < c > d')).toBe("a &amp; b &lt; c &gt; d");
  });
});

describe("normalizeStd", () => {
  it("maps curly quotes, dashes, ellipsis and bullets to WinAnsi", () => {
    expect(normalizeStd("‘a’ “b” – — … •")).toBe("'a' \"b\" - - ... -");
  });
  it("leaves plain ASCII untouched", () => {
    expect(normalizeStd("plain text 123")).toBe("plain text 123");
  });
});

describe("cssColorToRgb", () => {
  it("parses a named / rgb colour to 0..1", () => {
    const red = cssColorToRgb("red", { r: 0, g: 0, b: 0 });
    expect(red.r).toBeCloseTo(1);
    expect(red.g).toBeCloseTo(0);
    expect(red.b).toBeCloseTo(0);
  });
  it("returns the fallback for an empty string", () => {
    const fb = { r: 0.5, g: 0.5, b: 0.5 };
    expect(cssColorToRgb("", fb)).toBe(fb);
  });
});

describe("blockText", () => {
  const el = (html: string): HTMLElement => {
    const d = document.createElement("div");
    d.innerHTML = html;
    return d;
  };
  it("turns <br> into a newline", () => {
    expect(blockText(el("a<br>b"))).toBe("a\nb");
  });
  it("inserts a newline before a block element", () => {
    expect(blockText(el("first<div>second</div>"))).toBe("first\nsecond");
  });
  it("returns plain text unchanged", () => {
    expect(blockText(el("just text"))).toBe("just text");
  });
});

describe("parseRuns", () => {
  const base = { bold: false, italic: false, family: "sans" as Family, size: 12, color: { r: 0, g: 0, b: 0 } };
  const el = (html: string): HTMLElement => {
    const d = document.createElement("div");
    d.innerHTML = html;
    return d;
  };

  it("keeps a plain run at the base style", () => {
    const runs = parseRuns(el("hello"), base, 1);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ text: "hello", bold: false, italic: false, size: 12 });
  });

  it("marks bold and italic from <b>/<i> and from inline styles", () => {
    const runs = parseRuns(el('<b>x</b><span style="font-style:italic">y</span>'), base, 1);
    expect(runs[0]).toMatchObject({ text: "x", bold: true });
    expect(runs[1]).toMatchObject({ text: "y", italic: true });
  });

  it("reads a font-weight number as bold above 600", () => {
    const runs = parseRuns(el('<span style="font-weight:700">heavy</span>'), base, 1);
    expect(runs[0]!.bold).toBe(true);
  });

  it("converts a px font size to pt using the scale", () => {
    // 24px at scale 2 -> 12pt.
    const runs = parseRuns(el('<span style="font-size:24px">z</span>'), base, 2);
    expect(runs[0]!.size).toBe(12);
  });

  it("carries an anchor href and a data-font key onto its run", () => {
    const runs = parseRuns(el('<a href="https://example.com" data-font="F7">link</a>'), base, 1);
    expect(runs[0]).toMatchObject({ text: "link", href: "https://example.com", fontKey: "F7" });
  });

  it("flags a <br> as brAfter on the preceding run", () => {
    const runs = parseRuns(el("a<br>b"), base, 1);
    expect(runs[0]).toMatchObject({ text: "a", brAfter: true });
    expect(runs[1]).toMatchObject({ text: "b" });
  });

  it("classifies an inline font-family", () => {
    const runs = parseRuns(el('<span style="font-family:Courier New">m</span>'), base, 1);
    expect(runs[0]!.family).toBe("mono");
  });
});
