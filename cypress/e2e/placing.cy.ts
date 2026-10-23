/// <reference types="cypress" />

// Placing things on a page: an added text box can be moved, a new image goes where the person is
// looking, and both follow the pointer exactly, including when the page is zoomed (the CSS zoom
// scales the page, so a box that tracks the pointer has to divide its travel by it).

const RENDER_TIMEOUT = 30000;

function open(fixture: string, zoomPct?: number) {
  cy.viewport(1100, 900);
  cy.visit("/", {
    onBeforeLoad(win) {
      if (zoomPct) win.localStorage.setItem("pdfedit:zoom", String(zoomPct));
      else win.localStorage.removeItem("pdfedit:zoom");
    },
  });
  cy.get("#file").selectFile(`cypress/fixtures/${fixture}`, { force: true });
  cy.get(".pdfedit-para", { timeout: RENDER_TIMEOUT }).should("have.length.greaterThan", 0);
}

/** Press on an element and drag by (dx, dy) screen px, the way the editor's drags are driven. */
function dragBy(selector: string, dx: number, dy: number) {
  cy.get(selector).then(($el) => {
    const r = $el[0]!.getBoundingClientRect();
    const x0 = r.left + r.width / 2;
    const y0 = r.top + r.height / 2;
    cy.wrap($el).trigger("pointerdown", { clientX: x0, clientY: y0, button: 0, force: true });
    cy.document().then((doc) => {
      doc.dispatchEvent(new PointerEvent("pointermove", { clientX: x0 + dx / 2, clientY: y0 + dy / 2, bubbles: true }));
      doc.dispatchEvent(new PointerEvent("pointermove", { clientX: x0 + dx, clientY: y0 + dy, bubbles: true }));
      doc.dispatchEvent(new PointerEvent("pointerup", { clientX: x0 + dx, clientY: y0 + dy, bubbles: true }));
    });
  });
}

const leftOf = (sel: string) => cy.get(sel).then(($e) => $e[0]!.getBoundingClientRect().left);
const topOf = (sel: string) => cy.get(sel).then(($e) => $e[0]!.getBoundingClientRect().top);

describe("an added text box", () => {
  it("can be moved by its handle, and the move undoes", () => {
    open("test.pdf");
    // A blank spot low on the page, well below the fixture's text.
    cy.get(".pdfedit-page").first().dblclick(200, 640, { force: true });
    cy.focused().type("Moved text");
    cy.get(".pdfedit-grip").should("have.length", 1).and("have.attr", "aria-label");
    const box = ".pdfedit-para.pdfedit-edited";
    leftOf(box).then((before) => {
      topOf(box).then((topBefore) => {
        dragBy(".pdfedit-grip", 60, 30);
        leftOf(box).should((now) => expect(now - before).to.be.closeTo(60, 1.5));
        topOf(box).should((now) => expect(now - topBefore).to.be.closeTo(30, 1.5));
        cy.get(".pdfedit-grip").then(($g) => expect($g[0]!.getBoundingClientRect().left).to.be.closeTo(before + 60, 1.5));
        cy.get('.pdfedit-toolbar [aria-label*="Undo"]').click();
        leftOf(box).should((now) => expect(now).to.be.closeTo(before, 1.5));
      });
    });
  });

  it("moves with the arrow keys from its handle", () => {
    open("test.pdf");
    cy.get(".pdfedit-page").first().dblclick(200, 640, { force: true });
    cy.focused().type("Keyed");
    const box = ".pdfedit-para.pdfedit-edited";
    leftOf(box).then((before) => {
      cy.get(".pdfedit-grip").focus().type("{rightarrow}{rightarrow}{shift}{rightarrow}");
      leftOf(box).should((now) => expect(now - before).to.be.closeTo(30, 1.5)); // 5 + 5 + 20
    });
  });

  it("is not added when the double-click lands on the handle", () => {
    open("test.pdf");
    cy.get(".pdfedit-page").first().dblclick(200, 640, { force: true });
    cy.focused().type("One");
    cy.get(".pdfedit-grip").dblclick({ force: true });
    cy.get(".pdfedit-para.pdfedit-edited").should("have.length", 1);
  });
});

describe("an inserted image", () => {
  for (const zoom of [100, 150]) {
    it(`goes to the middle of the page in view and follows the pointer at ${zoom}%`, () => {
      open("multipage.pdf", zoom);
      cy.get(".pdfedit-page").eq(1).scrollIntoView({ offset: { top: 0, left: 0 } });
      cy.get('.pdfedit-toolbar input[type="file"]').selectFile("cypress/fixtures/img.png", { force: true });
      cy.get(".pdfedit-img").should("have.length", 1);
      // On the second page, which is the one on screen, and not at its top-left corner.
      cy.get(".pdfedit-img").then(($i) => {
        const doc = $i[0]!.ownerDocument;
        const pages = Array.from(doc.querySelectorAll(".pdfedit-page"));
        expect(pages.indexOf($i[0]!.parentElement!)).to.equal(1);
        const img = $i[0]!.getBoundingClientRect();
        const page = $i[0]!.parentElement!.getBoundingClientRect();
        expect(img.left, "not parked in the page's corner").to.be.greaterThan(page.left + 80);
        expect(img.top, "inside what is on screen").to.be.within(0, doc.defaultView!.innerHeight);
      });
      leftOf(".pdfedit-img").then((l0) => {
        topOf(".pdfedit-img").then((t0) => {
          dragBy(".pdfedit-img", 70, 25);
          leftOf(".pdfedit-img").should((l1) => expect(l1 - l0).to.be.closeTo(70, 1.5));
          topOf(".pdfedit-img").should((t1) => expect(t1 - t0).to.be.closeTo(25, 1.5));
        });
      });
    });
  }
});
