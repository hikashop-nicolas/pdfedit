/// <reference types="cypress" />

// End-to-end tests for the pdfedit toolbar against the demo, exercising the real
// interaction paths (clicking the color/size controls, which move focus off the
// paragraph) that the in-extension automation browser couldn't reliably drive.

const RENDER_TIMEOUT = 30000;

/** Open the fixture PDF and wait for the editor to render at least one paragraph. */
function openFixture() {
  cy.visit("/");
  cy.get("#file").selectFile("cypress/fixtures/test.pdf", { force: true });
  cy.get(".pdfedit-para", { timeout: RENDER_TIMEOUT }).should("have.length.greaterThan", 0);
}

/** Select `len` chars starting at `start` within the first text node long enough,
 *  in the first paragraph. Robust to the span splitting that styling introduces. */
function selectInFirstPara(start: number, len: number) {
  cy.window().then((win) => {
    const para = win.document.querySelector<HTMLElement>(".pdfedit-para")!;
    para.focus();
    const walker = win.document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
    let tn: Text | null = null;
    while (walker.nextNode()) {
      if ((walker.currentNode.textContent ?? "").length >= start + len) {
        tn = walker.currentNode as Text;
        break;
      }
    }
    expect(tn, "found a text node to select").to.not.eq(null);
    const r = win.document.createRange();
    r.setStart(tn!, start);
    r.setEnd(tn!, start + len);
    const sel = win.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  });
}

describe("pdfedit toolbar", () => {
  it("renders the PDF", () => {
    openFixture();
    cy.get(".pdfedit-page").should("have.length.greaterThan", 0);
    cy.get(".pdfedit-toolbar input[type=number]").should("exist");
    cy.get(".pdfedit-toolbar input[type=color]").should("exist");
  });

  it("applies font size to a selection and the value sticks (real click + type)", () => {
    openFixture();
    selectInFirstPara(0, 5);
    // Real interaction: clicking the number input blurs the paragraph.
    cy.get(".pdfedit-toolbar input[type=number]").clear().type("26{enter}");
    cy.get(".pdfedit-toolbar input[type=number]").should("have.value", "26");
    cy.window().then((win) => {
      const para = win.document.querySelector<HTMLElement>(".pdfedit-para")!;
      const big = [...para.querySelectorAll("span")].some((s) => parseFloat(getComputedStyle(s).fontSize) >= 30); // 26pt * 1.3
      expect(big, "a span resized to ~26pt").to.eq(true);
    });
  });

  it("applies a color to a selection", () => {
    openFixture();
    selectInFirstPara(0, 6);
    cy.get(".pdfedit-toolbar input[type=color]").invoke("val", "#cc0000").trigger("change");
    cy.window().then((win) => {
      const para = win.document.querySelector<HTMLElement>(".pdfedit-para")!;
      const reds = [...para.querySelectorAll("span")].filter((s) => getComputedStyle(s).color === "rgb(204, 0, 0)");
      expect(reds.length, "a span turned red").to.be.greaterThan(0);
    });
  });

  it("keeps the chosen color in the swatch across selections", () => {
    openFixture();
    selectInFirstPara(0, 6);
    cy.get(".pdfedit-toolbar input[type=color]").invoke("val", "#cc0000").trigger("change");
    // Select a different, longer piece of text; the swatch must keep the chosen color.
    selectInFirstPara(20, 6);
    cy.get(".pdfedit-toolbar input[type=color]").should("have.value", "#cc0000");
  });

  it("keeps the paragraph visible (active) while a toolbar control has focus", () => {
    openFixture();
    selectInFirstPara(0, 6);
    // Real click (sets relatedTarget) so the paragraph blur keeps it active + highlighted.
    cy.get(".pdfedit-toolbar input[type=number]").click();
    cy.get(".pdfedit-para.pdfedit-active").should("exist");
    cy.window().then((win) => {
      const hl = (win as unknown as { CSS?: { highlights?: { has(k: string): boolean } } }).CSS?.highlights;
      expect(hl?.has("pdfedit-sel"), "saved selection is highlighted").to.eq(true);
    });
  });
});
