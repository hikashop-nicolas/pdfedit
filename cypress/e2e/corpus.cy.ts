/// <reference types="cypress" />

// Real-file corpus: multipage.pdf is produced by a real engine (LibreOffice: 3 pages,
// an embedded LiberationSerif subset), not by pdf-lib like the other synthetic fixtures.
// It guards the multi-page render path and a no-edit save round-trip, which the
// single-page Helvetica fixtures never exercised.

const RENDER_TIMEOUT = 30000;

function openFixture(name: string) {
  cy.visit("/");
  cy.get("#file").selectFile(`cypress/fixtures/${name}`, { force: true });
  cy.get(".pdfedit-para", { timeout: RENDER_TIMEOUT }).should("have.length.greaterThan", 0);
}

// The visible text across every rendered paragraph, whitespace-collapsed.
function allParaText(): Cypress.Chainable<string> {
  return cy.get(".pdfedit-para").then(($p) => $p.toArray().map((el) => el.textContent ?? "").join(" ").replace(/\s+/g, " "));
}

describe("real-file corpus: multi-page PDF", () => {
  it("renders all three pages with their text", () => {
    openFixture("multipage.pdf");
    cy.get(".pdfedit-page", { timeout: RENDER_TIMEOUT }).should("have.length", 3);
    allParaText().should((t) => {
      expect(t).to.contain("PageOneMarker");
      expect(t).to.contain("PageTwoMarker");
      expect(t).to.contain("PageThreeMarker");
    });
  });

  it("preserves every page's text through a no-edit save round-trip", () => {
    openFixture("multipage.pdf");
    // Save the document unchanged, then reopen the produced bytes.
    cy.window()
      .then((win) => (win as unknown as { __pdfeditDemo: { getEditor(): { getBytes(): Promise<Uint8Array> } } }).__pdfeditDemo.getEditor().getBytes())
      .then((bytes) => {
        cy.get("#file").selectFile({ contents: Cypress.Buffer.from(bytes), fileName: "roundtrip.pdf" }, { force: true });
        cy.get(".pdfedit-para", { timeout: RENDER_TIMEOUT }).should("have.length.greaterThan", 0);
        cy.get(".pdfedit-page", { timeout: RENDER_TIMEOUT }).should("have.length", 3);
        allParaText().should((t) => {
          expect(t, "text survives the save round-trip").to.contain("PageOneMarker");
          expect(t).to.contain("PageTwoMarker");
          expect(t).to.contain("PageThreeMarker");
        });
      });
  });
});
