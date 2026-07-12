/// <reference types="cypress" />

// Off-screen canvas eviction: a page whose raster <canvas> has scrolled far outside the
// viewport is dropped to bound memory, then redrawn when it returns. The text overlay
// (paragraphs, edits) must survive eviction and must NOT be rebuilt (no duplicates) on
// return. multipage.pdf is a real 3-page file (LibreOffice) with per-page markers.

const RENDER_TIMEOUT = 30000;

function openFixture(name: string) {
  cy.visit("/");
  cy.get("#file").selectFile(`cypress/fixtures/${name}`, { force: true });
  cy.get(".pdfedit-para", { timeout: RENDER_TIMEOUT }).should("have.length.greaterThan", 0);
}

// Drive the scroll container to an exact offset and fire the scroll event the eviction
// sweep listens for.
function scrollRootTo(top: number) {
  cy.get(".pdfedit-root").then(($root) => {
    const root = $root[0];
    root.scrollTop = top;
    root.dispatchEvent(new Event("scroll"));
  });
}

describe("off-screen canvas eviction", () => {
  it("drops a far page's canvas and restores it (with edits) on return", () => {
    openFixture("multipage.pdf");
    cy.get(".pdfedit-page", { timeout: RENDER_TIMEOUT }).should("have.length", 3);

    // Force every page's overlay to build so the last page is a fully-settled render before
    // it is scrolled away (only settled pages are eligible for eviction).
    cy.get(".pdfedit-page").each(($page) => cy.wrap($page).scrollIntoView());

    // The last page is rendered: it has a live raster canvas (non-zero bitmap) and its text.
    cy.get(".pdfedit-page").eq(2).find("canvas").should(($c) => expect($c[0].width).to.be.greaterThan(0));
    cy.get(".pdfedit-page").eq(2).should("contain.text", "PageThreeMarker");

    // Edit a paragraph on the last page to prove eviction never touches user edits.
    cy.get(".pdfedit-page")
      .eq(2)
      .find(".pdfedit-para")
      .contains("PageThreeMarker")
      .click()
      .type("{moveToEnd} ZZZSENTINEL");
    cy.get(".pdfedit-page").eq(2).should("contain.text", "ZZZSENTINEL");

    // Snapshot the last page's paragraph count so we can detect any duplication on return.
    cy.get(".pdfedit-page").eq(2).find(".pdfedit-para").its("length").as("p3count");

    // Scroll to the very top: the last page is now well below the keep margin.
    scrollRootTo(0);

    // The canvas bitmap under the last page is freed (width 0), but its overlay stays put.
    cy.get(".pdfedit-page").eq(2).find("canvas", { timeout: 10000 }).should(($c) => expect($c[0].width).to.eq(0));
    cy.get(".pdfedit-page").eq(2).should("contain.text", "PageThreeMarker");
    cy.get(".pdfedit-page").eq(2).should("contain.text", "ZZZSENTINEL");

    // Scroll the last page back into view: its canvas is redrawn (bitmap restored).
    cy.get(".pdfedit-page").eq(2).scrollIntoView();
    cy.get(".pdfedit-page").eq(2).find("canvas", { timeout: 10000 }).should(($c) => expect($c[0].width).to.be.greaterThan(0));

    // No duplicated paragraphs and the edit is intact after the round-trip.
    cy.get("@p3count").then((n) => {
      cy.get(".pdfedit-page").eq(2).find(".pdfedit-para").should("have.length", Number(n));
    });
    cy.get(".pdfedit-page").eq(2).should("contain.text", "ZZZSENTINEL");
    cy.get(".pdfedit-page").eq(2).should("contain.text", "PageThreeMarker");
  });
});
