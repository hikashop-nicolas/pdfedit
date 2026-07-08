import { describe, expect, it } from "vitest";
import { findMatches, type SearchItem } from "./search";

const item = (str: string, x: number, y: number, w = str.length * 6): SearchItem => ({ str, x, y, w, size: 10 });

describe("findMatches", () => {
  it("finds case-insensitive matches within an item", () => {
    const m = findMatches([[item("Hello World", 0, 700)]], "world");
    expect(m.length).toBe(1);
    expect(m[0]!.page).toBe(0);
    expect(m[0]!.rects.length).toBe(1);
    // "World" starts at 6/11 of the item.
    expect(m[0]!.rects[0]!.startFrac).toBeCloseTo(6 / 11);
    expect(m[0]!.rects[0]!.endFrac).toBeCloseTo(1);
  });

  it("finds matches spanning adjacent items on the same line", () => {
    const m = findMatches([[item("data", 0, 700), item("base", 24, 700)]], "database");
    expect(m.length).toBe(1);
    expect(m[0]!.rects.length).toBe(2);
    expect(m[0]!.rects[0]!.startFrac).toBe(0);
    expect(m[0]!.rects[1]!.endFrac).toBe(1);
  });

  it("does not match across different lines", () => {
    const m = findMatches([[item("data", 0, 700), item("base", 0, 680)]], "database");
    expect(m.length).toBe(0);
  });

  it("reports every occurrence across pages", () => {
    const pages = [[item("alpha beta alpha", 0, 700)], [item("alpha", 0, 700)]];
    const m = findMatches(pages, "alpha");
    expect(m.length).toBe(3);
    expect(m.map((x) => x.page)).toEqual([0, 0, 1]);
  });

  it("empty query matches nothing", () => {
    expect(findMatches([[item("abc", 0, 0)]], "")).toEqual([]);
  });
});
