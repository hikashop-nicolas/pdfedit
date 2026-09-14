import { describe, expect, it } from "vitest";
import { fitZoomPct } from "./zoom";

// With no zoom saved, a page opened at 100% on a phone: 773px of page in a 400px column, cut off
// on the right. The first page now opens at the zoom that fits the width it has.
describe("the zoom a page opens at", () => {
  it("fits a wide page into a phone's width, on the slider's step", () => {
    expect(fitZoomPct(400, 773)).toBe(50); // 51.7% rounded down to a 5% step
  });

  it("never enlarges a page that already fits", () => {
    expect(fitZoomPct(1400, 773)).toBe(100);
  });

  it("stays within the slider's range", () => {
    expect(fitZoomPct(40, 2000)).toBe(25);
  });

  it("keeps 100% when there is nothing to measure (no layout yet)", () => {
    expect(fitZoomPct(0, 773)).toBe(100);
    expect(fitZoomPct(400, 0)).toBe(100);
  });
});
