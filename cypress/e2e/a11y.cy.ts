/// <reference types="cypress" />

// Accessibility checks: every toolbar control has an accessible name, the toolbar is
// a labelled toolbar, and inserted images are keyboard operable (focus / resize / delete).

const RENDER_TIMEOUT = 30000;

function openFixture() {
  cy.visit("/");
  cy.get("#file").selectFile("cypress/fixtures/test.pdf", { force: true });
  cy.get(".pdfedit-para", { timeout: RENDER_TIMEOUT }).should("have.length.greaterThan", 0);
}

describe("pdfedit accessibility", () => {
  it("exposes a labelled toolbar where every control has an accessible name", () => {
    openFixture();
    cy.get(".pdfedit-toolbar").should("have.attr", "role", "toolbar").and("have.attr", "aria-label");
    const names = [
      "Undo (Ctrl+Z)",
      "Redo (Ctrl+Y)",
      "Bold",
      "Italic",
      "Text color",
      "Font family",
      "Font size in points",
      "Align left",
      "Align center",
      "Align right",
      "Justify",
      "Add or edit link",
      "Insert image",
      "Zoom level (percent)",
      "Zoom percent",
    ];
    for (const name of names) {
      cy.get(`.pdfedit-toolbar [aria-label="${name}"]`).should("exist");
    }
  });

  it("decorates icon buttons so the SVG is hidden from assistive tech", () => {
    openFixture();
    cy.get('.pdfedit-toolbar [aria-label="Align left"] svg').should("have.attr", "aria-hidden", "true");
  });

  it("makes an inserted image keyboard-focusable, resizable and deletable", () => {
    openFixture();
    cy.get('input[type=file][accept*="image"]').selectFile("cypress/fixtures/img.png", { force: true });
    cy.get(".pdfedit-img").should("exist").and("have.attr", "tabindex", "0").and("have.attr", "role", "group");
    cy.get(".pdfedit-img-del").should("match", "button").and("have.attr", "aria-label", "Delete image");

    // Resize via keyboard ("+").
    cy.get(".pdfedit-img").then(($b) => {
      const w0 = $b[0].offsetWidth;
      cy.get(".pdfedit-img").focus().trigger("keydown", { key: "+" });
      cy.get(".pdfedit-img").should(($b2) => expect($b2[0].offsetWidth).to.be.greaterThan(w0));
    });

    // Delete via keyboard.
    cy.get(".pdfedit-img").trigger("keydown", { key: "Delete" });
    cy.get(".pdfedit-img").should("not.exist");
  });
});
