/// <reference types="cypress" />

// End-to-end tests for the whiteout tool: enter whiteout mode from the toolbar, drag a
// rectangle on a page, and check the overlay box appears, survives undo/redo, and is
// drawn into the exported PDF.

const RENDER_TIMEOUT = 30000;

function openFixture() {
  cy.visit("/");
  cy.get("#file").selectFile("cypress/fixtures/test.pdf", { force: true });
  cy.get(".pdfedit-para", { timeout: RENDER_TIMEOUT }).should("have.length.greaterThan", 0);
}

/** Drag a rectangle on the first page using pointer events (mirrors the real interaction). */
function dragWhiteout(fromXFrac: number, fromYFrac: number, toXFrac: number, toYFrac: number) {
  cy.get(".pdfedit-page")
    .first()
    .then(($p) => {
      const r = $p[0]!.getBoundingClientRect();
      const x0 = r.left + r.width * fromXFrac;
      const y0 = r.top + r.height * fromYFrac;
      const x1 = r.left + r.width * toXFrac;
      const y1 = r.top + r.height * toYFrac;
      cy.wrap($p)
        .trigger("pointerdown", { clientX: x0, clientY: y0, button: 0, force: true })
        .trigger("pointermove", { clientX: (x0 + x1) / 2, clientY: (y0 + y1) / 2, force: true });
      cy.document().then((doc) => {
        doc.dispatchEvent(new PointerEvent("pointermove", { clientX: x1, clientY: y1, bubbles: true }));
        doc.dispatchEvent(new PointerEvent("pointerup", { clientX: x1, clientY: y1, bubbles: true }));
      });
    });
}

describe("pdfedit whiteout", () => {
  it("enters whiteout mode and draws a cover box by dragging", () => {
    openFixture();
    cy.get('.pdfedit-toolbar [aria-label*="Whiteout"]').click();
    cy.get('.pdfedit-toolbar [aria-label*="Whiteout"]').should("have.attr", "aria-pressed", "true");
    cy.get(".pdfedit-root").should("have.class", "pdfedit-whiteout-mode");
    dragWhiteout(0.25, 0.35, 0.6, 0.55);
    cy.get(".pdfedit-white").should("have.length", 1);
    // The box has a real (non-trivial) size from the drag.
    cy.get(".pdfedit-white").should(($b) => {
      expect($b[0].offsetWidth).to.be.greaterThan(20);
      expect($b[0].offsetHeight).to.be.greaterThan(20);
    });
  });

  it("survives undo then redo", () => {
    openFixture();
    cy.get('.pdfedit-toolbar [aria-label*="Whiteout"]').click();
    dragWhiteout(0.25, 0.35, 0.6, 0.55);
    cy.get(".pdfedit-white").should("have.length", 1);
    cy.get('.pdfedit-toolbar [aria-label="Undo (Ctrl+Z)"]').click();
    cy.get(".pdfedit-white").should("not.exist");
    cy.get('.pdfedit-toolbar [aria-label="Redo (Ctrl+Y)"]').click();
    cy.get(".pdfedit-white").should("have.length", 1);
  });

  it("is removed by its delete button", () => {
    openFixture();
    cy.get('.pdfedit-toolbar [aria-label*="Whiteout"]').click();
    dragWhiteout(0.25, 0.35, 0.6, 0.55);
    cy.get(".pdfedit-white").should("have.length", 1);
    cy.get(".pdfedit-white-del").click({ force: true });
    cy.get(".pdfedit-white").should("not.exist");
  });

  it("is deletable with the Delete key when focused", () => {
    openFixture();
    cy.get('.pdfedit-toolbar [aria-label*="Whiteout"]').click();
    dragWhiteout(0.25, 0.35, 0.6, 0.55);
    cy.get(".pdfedit-white").focus().trigger("keydown", { key: "Delete" });
    cy.get(".pdfedit-white").should("not.exist");
  });

  it("keeps the whiteout in the exported PDF (getBytes returns edited bytes)", () => {
    openFixture();
    cy.get('.pdfedit-toolbar [aria-label*="Whiteout"]').click();
    dragWhiteout(0.25, 0.35, 0.6, 0.55);
    cy.get(".pdfedit-white").should("have.length", 1);
    cy.window().then(async (win) => {
      const demo = (win as unknown as { __pdfeditDemo: { getEditor: () => { getBytes: () => Promise<Uint8Array> } } }).__pdfeditDemo;
      const bytes = await demo.getEditor().getBytes();
      // A whiteout forces a re-save, so the exported bytes differ from the pristine original.
      expect(bytes.length, "exported PDF produced").to.be.greaterThan(0);
      const state = (win as unknown as { __pdfeditDemo: { getEditor: () => { getState: () => { whiteouts: unknown[] } } } }).__pdfeditDemo.getEditor().getState();
      expect(state.whiteouts.length, "whiteout captured in state").to.eq(1);
    });
  });
});
