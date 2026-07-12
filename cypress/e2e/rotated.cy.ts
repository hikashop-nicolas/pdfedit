/// <reference types="cypress" />

// rotated.pdf is a /Rotate 90 page whose three lines are drawn with a pre-rotated text
// matrix so they DISPLAY upright (a landscape document stored as portrait + /Rotate). Its
// text-item transforms come back rotated in the page's unrotated user space, so the plain
// group-by-horizontal-baseline read heuristics used to merge the three lines into one narrow,
// vertical box and the export drew the replacement rotated and failed to cover the original.
// This guards the deskew-on-read / re-rotate-on-export path.

const RENDER_TIMEOUT = 30000;

function openFixture(name: string) {
  cy.visit("/");
  cy.get("#file").selectFile(`cypress/fixtures/${name}`, { force: true });
  cy.get(".pdfedit-para", { timeout: RENDER_TIMEOUT }).should("have.length.greaterThan", 0);
}

describe("rotated page (/Rotate 90, pre-rotated text matrix)", () => {
  it("groups the upright lines in reading order into a horizontal box", () => {
    openFixture("rotated.pdf");
    // The three display-lines read in order, space-joined. Before the deskew fix the rotated
    // baselines merged into one segment with no spaces ("FirstLine alphaSecondLine beta..."),
    // so requiring the spaced, in-order text guards the read-side grouping.
    cy.get(".pdfedit-para").should(($p) => {
      const text = $p.toArray().map((el) => el.textContent ?? "").join(" ");
      expect(text).to.match(/FirstLine alpha\s+SecondLine beta\s+ThirdLine gamma/);
    });
  });

  it("round-trips an edit through save without losing the page", () => {
    openFixture("rotated.pdf");
    cy.get(".pdfedit-para").first().click();
    cy.get(".pdfedit-para").first().type("{selectall}RotatedEdit", { force: true });
    cy.window()
      .then((win) => (win as unknown as { __pdfeditDemo: { getEditor(): { getBytes(): Promise<Uint8Array> } } }).__pdfeditDemo.getEditor().getBytes())
      .then((bytes) => {
        expect(bytes.byteLength).to.be.greaterThan(0);
        cy.get("#file").selectFile({ contents: Cypress.Buffer.from(bytes), fileName: "rt.pdf" }, { force: true });
        cy.get(".pdfedit-para", { timeout: RENDER_TIMEOUT }).should(($p) => {
          const text = $p.toArray().map((el) => el.textContent ?? "").join(" ");
          expect(text).to.contain("RotatedEdit");
        });
      });
  });
});
