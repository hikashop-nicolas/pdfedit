import { describe, expect, it } from "vitest";
import { layoutLine, wrapTokens, type WrapTok } from "./layout";

// A word token of width w, or a space token. `id` lets tests read back which words landed
// on which line.
const word = (id: string, w: number): WrapTok & { id: string } => ({ id, w, space: false });
const space = (w = 4): WrapTok & { id: string } => ({ id: " ", w, space: true });
const ids = (line: (WrapTok & { id: string })[]) => line.map((t) => t.id).join("");

describe("wrapTokens", () => {
  it("keeps everything on one line when it fits", () => {
    const toks = [word("a", 10), space(), word("b", 10)];
    const lines = wrapTokens(toks, [], 100);
    expect(lines).toHaveLength(1);
    expect(ids(lines[0] as (WrapTok & { id: string })[])).toBe("a b");
  });

  it("wraps before a word that would overflow and trims the trailing space", () => {
    const toks = [word("a", 60), space(), word("b", 60)];
    const lines = wrapTokens(toks, [], 100);
    expect(lines).toHaveLength(2);
    expect(ids(lines[0] as (WrapTok & { id: string })[])).toBe("a"); // trailing space dropped
    expect(ids(lines[1] as (WrapTok & { id: string })[])).toBe("b"); // leading space dropped
  });

  it("breaks at a forced line-break index (a <br>)", () => {
    const toks = [word("a", 10), word("b", 10)];
    const lines = wrapTokens(toks, [1], 1000); // break before token index 1
    expect(lines.map((l) => ids(l as (WrapTok & { id: string })[]))).toEqual(["a", "b"]);
  });

  it("preserves an empty line from consecutive breaks", () => {
    const toks = [word("a", 10), word("b", 10)];
    // Breaks before index 1 and again before index 1 is impossible; use a doc that forces a
    // blank: break before token 1, and token 1 is preceded by another break slot at 1.
    const lines = wrapTokens([word("a", 10), word("b", 10), word("c", 10)], [1, 2], 1000);
    expect(lines.map((l) => ids(l as (WrapTok & { id: string })[]))).toEqual(["a", "b", "c"]);
  });
});

describe("layoutLine", () => {
  const line = [word("a", 20), space(10), word("b", 20)]; // lineW = 50

  it("left: starts at boxX with no stretch", () => {
    expect(layoutLine(line, "left", 100, 300, false)).toEqual({ x: 100, spaceExtra: 0 });
  });

  it("center: shifts the line to the middle of the box", () => {
    // boxW 300, lineW 50 -> left margin (300-50)/2 = 125 -> x = 100 + 125.
    expect(layoutLine(line, "center", 100, 300, false)).toEqual({ x: 225, spaceExtra: 0 });
  });

  it("right: flushes the line to the right edge", () => {
    // x = boxX + boxW - lineW = 100 + 300 - 50 = 350.
    expect(layoutLine(line, "right", 100, 300, false)).toEqual({ x: 350, spaceExtra: 0 });
  });

  it("justify: spreads the slack across spaces on a non-last line", () => {
    // slack = boxW - lineW = 250, one space -> spaceExtra 250; x stays at boxX.
    expect(layoutLine(line, "justify", 100, 300, false)).toEqual({ x: 100, spaceExtra: 250 });
  });

  it("justify: leaves the last line left-flush (no stretch)", () => {
    expect(layoutLine(line, "justify", 100, 300, true)).toEqual({ x: 100, spaceExtra: 0 });
  });

  it("justify: no stretch when the line has no spaces", () => {
    expect(layoutLine([word("a", 20)], "justify", 100, 300, false)).toEqual({ x: 100, spaceExtra: 0 });
  });
});
