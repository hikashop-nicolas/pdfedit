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
    cy.get('input[title="Font size (pt)"]').should("exist");
    cy.get(".pdfedit-toolbar input[type=color]").should("exist");
  });

  it("applies font size to a selection and the value sticks (real click + type)", () => {
    openFixture();
    selectInFirstPara(0, 5);
    // Real interaction: clicking the number input blurs the paragraph.
    cy.get('input[title="Font size (pt)"]').clear().type("26{enter}");
    cy.get('input[title="Font size (pt)"]').should("have.value", "26");
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

  it("zooms the page via the percentage input and the slider", () => {
    openFixture();
    // via the percentage input
    cy.get(".pdfedit-zoom input[type=number]").clear().type("200{enter}");
    cy.get(".pdfedit-page").first().should(($p) => expect($p[0].style.zoom).to.eq("2"));
    cy.get(".pdfedit-zoom input[type=range]").should("have.value", "200");
    // via the slider
    cy.get(".pdfedit-zoom input[type=range]").invoke("val", "50").trigger("input");
    cy.get(".pdfedit-page").first().should(($p) => expect($p[0].style.zoom).to.eq("0.5"));
    cy.get(".pdfedit-zoom input[type=number]").should("have.value", "50");
  });

  it("remembers the zoom level across a reload (localStorage)", () => {
    openFixture();
    cy.get(".pdfedit-zoom input[type=number]").clear().type("175{enter}");
    cy.get(".pdfedit-page").first().should(($p) => expect($p[0].style.zoom).to.eq("1.75"));
    // reload the app and reopen the document: the zoom should be restored
    cy.reload();
    cy.get("#file").selectFile("cypress/fixtures/test.pdf", { force: true });
    cy.get(".pdfedit-page", { timeout: RENDER_TIMEOUT }).should("have.length.greaterThan", 0);
    cy.get(".pdfedit-zoom input[type=number]").should("have.value", "175");
    cy.get(".pdfedit-page").first().should(($p) => expect($p[0].style.zoom).to.eq("1.75"));
  });

  it("keeps the paragraph visible (active) while a toolbar control has focus", () => {
    openFixture();
    selectInFirstPara(0, 6);
    // Real click (sets relatedTarget) so the paragraph blur keeps it active + highlighted.
    cy.get('input[title="Font size (pt)"]').click();
    cy.get(".pdfedit-para.pdfedit-active").should("exist");
    cy.window().then((win) => {
      const hl = (win as unknown as { CSS?: { highlights?: { has(k: string): boolean } } }).CSS?.highlights;
      expect(hl?.has("pdfedit-sel"), "saved selection is highlighted").to.eq(true);
    });
  });

  it("adds a text box on double-click in blank space and exports it", () => {
    openFixture();
    cy.window().then((win) => {
      (win as unknown as { __exported: Uint8Array | null }).__exported = null;
      const orig = win.URL.createObjectURL.bind(win.URL);
      win.URL.createObjectURL = (b: Blob) => {
        if (b instanceof win.Blob)
          void b.arrayBuffer().then((ab) => ((win as unknown as { __exported: Uint8Array }).__exported = new Uint8Array(ab)));
        return orig(b);
      };
    });
    // Double-click a blank area (lower part of the page, away from the text at the top).
    cy.get(".pdfedit-page")
      .first()
      .then(($p) => {
        const r = $p[0]!.getBoundingClientRect();
        cy.wrap($p).dblclick(r.width * 0.3, r.height * 0.45, { force: true });
      });
    cy.get(".pdfedit-para.pdfedit-active").should("exist");
    cy.focused().type("ADDEDTEXT");
    cy.get("#save").click();
    cy.window().its("__exported").should("exist");
    cy.window().then((win) => {
      const bytes = (win as unknown as { __exported: Uint8Array }).__exported;
      const file = new win.File([bytes as BlobPart], "x.pdf", { type: "application/pdf" });
      const dt = new win.DataTransfer();
      dt.items.add(file);
      const inp = win.document.getElementById("file") as HTMLInputElement;
      inp.files = dt.files;
      inp.dispatchEvent(new win.Event("change", { bubbles: true }));
    });
    cy.get(".pdfedit-para", { timeout: RENDER_TIMEOUT }).should("exist");
    cy.get("#editor").should("contain.text", "ADDEDTEXT");
  });

  it("keeps an Enter line break on its own line through export (Chrome inserts a <div>)", () => {
    openFixture();
    cy.window().then((win) => {
      (win as unknown as { __exported: Uint8Array | null }).__exported = null;
      const orig = win.URL.createObjectURL.bind(win.URL);
      win.URL.createObjectURL = (b: Blob) => {
        if (b instanceof win.Blob)
          void b.arrayBuffer().then((ab) => ((win as unknown as { __exported: Uint8Array }).__exported = new Uint8Array(ab)));
        return orig(b);
      };
    });
    // Add a new line at the end of the first paragraph, then type a marker.
    cy.get(".pdfedit-para").first().click().type("{moveToEnd}{enter}ZZNEWLINE");
    cy.get("#save").click();
    cy.window().its("__exported").should("exist");
    cy.window().then((win) => {
      const bytes = (win as unknown as { __exported: Uint8Array }).__exported;
      const file = new win.File([bytes as BlobPart], "x.pdf", { type: "application/pdf" });
      const dt = new win.DataTransfer();
      dt.items.add(file);
      const inp = win.document.getElementById("file") as HTMLInputElement;
      inp.files = dt.files;
      inp.dispatchEvent(new win.Event("change", { bubbles: true }));
    });
    cy.get(".pdfedit-para", { timeout: RENDER_TIMEOUT }).should("exist");
    // In the reopened document the marker must sit BELOW the original first line.
    cy.window().should((win) => {
      const root = win.document.getElementById("editor")!;
      const rectOf = (substr: string): DOMRect | null => {
        const walker = win.document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const n = walker.currentNode as Text;
          const i = (n.textContent ?? "").indexOf(substr);
          if (i >= 0) {
            const r = win.document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + substr.length);
            return r.getBoundingClientRect();
          }
        }
        return null;
      };
      const marker = rectOf("ZZNEWLINE");
      const first = rectOf("Premier");
      expect(marker, "marker survived export+reopen").to.not.eq(null);
      expect(first, "original text present").to.not.eq(null);
      expect(marker!.top, "marker is on a lower line than the original").to.be.greaterThan(first!.top + 4);
    });
  });
});
