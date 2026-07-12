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

  it("zooms with Ctrl/Cmd + wheel", () => {
    openFixture();
    cy.get(".pdfedit-zoom input[type=number]").clear().type("100{enter}");
    // Wheel up (negative deltaY) with ctrl held zooms in past 100%.
    cy.get(".pdfedit-page").first().trigger("wheel", { deltaY: -120, ctrlKey: true, force: true });
    cy.get(".pdfedit-zoom input[type=number]").invoke("val").then((v) => expect(Number(v)).to.be.greaterThan(100));
    // Wheel down zooms back out below the raised level.
    cy.get(".pdfedit-zoom input[type=number]").invoke("val").then((up) => {
      cy.get(".pdfedit-page").first().trigger("wheel", { deltaY: 120, ctrlKey: true, force: true });
      cy.get(".pdfedit-zoom input[type=number]").invoke("val").then((down) => expect(Number(down)).to.be.lessThan(Number(up)));
    });
    // A plain wheel (no modifier) must NOT change the zoom.
    cy.get(".pdfedit-zoom input[type=number]").invoke("val").then((before) => {
      cy.get(".pdfedit-page").first().trigger("wheel", { deltaY: -120, force: true });
      cy.get(".pdfedit-zoom input[type=number]").should("have.value", String(before));
    });
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

  it("inserts an image dropped onto a page", () => {
    openFixture();
    cy.fixture("img.png", "base64").then((b64) => {
      cy.get(".pdfedit-page")
        .first()
        .then(($p) => {
          const win = $p[0]!.ownerDocument.defaultView!;
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const file = new win.File([bytes], "img.png", { type: "image/png" });
          const dt = new win.DataTransfer();
          dt.items.add(file);
          const r = $p[0]!.getBoundingClientRect();
          cy.wrap($p)
            .trigger("dragover", { dataTransfer: dt, force: true })
            .trigger("drop", { dataTransfer: dt, clientX: r.left + 60, clientY: r.top + 60, force: true });
        });
    });
    cy.get(".pdfedit-img").should("have.length.greaterThan", 0);
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

  it("undoes and redoes typing via the toolbar buttons", () => {
    openFixture();
    cy.get(".pdfedit-para").first().click().type("{moveToEnd} ZZUNDO");
    cy.get("#editor").should("contain.text", "ZZUNDO");
    // The whole typing run is one step: a single undo removes it and clears dirty.
    cy.get('.pdfedit-toolbar [aria-label="Undo (Ctrl+Z)"]').click();
    cy.get("#editor").should("not.contain.text", "ZZUNDO");
    cy.get(".pdfedit-para.pdfedit-edited").should("not.exist");
    cy.get('.pdfedit-toolbar [aria-label="Redo (Ctrl+Y)"]').click();
    cy.get("#editor").should("contain.text", "ZZUNDO");
    cy.get(".pdfedit-para.pdfedit-edited").should("exist");
  });

  it("undoes typing with Ctrl+Z inside the paragraph", () => {
    openFixture();
    cy.get(".pdfedit-para").first().click().type("{moveToEnd} ZZKEYS");
    cy.get("#editor").should("contain.text", "ZZKEYS");
    cy.get(".pdfedit-para").first().type("{ctrl}z");
    cy.get("#editor").should("not.contain.text", "ZZKEYS");
    cy.get(".pdfedit-para").first().type("{ctrl}y");
    cy.get("#editor").should("contain.text", "ZZKEYS");
  });

  it("undoes a styling change applied through the Range-surgery path", () => {
    openFixture();
    selectInFirstPara(0, 6);
    cy.get(".pdfedit-toolbar input[type=color]").invoke("val", "#cc0000").trigger("change");
    cy.window().then((win) => {
      const para = win.document.querySelector<HTMLElement>(".pdfedit-para")!;
      const reds = [...para.querySelectorAll("span")].filter((s) => getComputedStyle(s).color === "rgb(204, 0, 0)");
      expect(reds.length, "a span turned red").to.be.greaterThan(0);
    });
    cy.get('.pdfedit-toolbar [aria-label="Undo (Ctrl+Z)"]').click();
    cy.window().then((win) => {
      const para = win.document.querySelector<HTMLElement>(".pdfedit-para")!;
      const reds = [...para.querySelectorAll("span")].filter((s) => getComputedStyle(s).color === "rgb(204, 0, 0)");
      expect(reds.length, "the red span is gone after undo").to.eq(0);
    });
    cy.get(".pdfedit-para.pdfedit-edited").should("not.exist");
  });

  it("undoes an image insertion and a keyboard move as separate steps", () => {
    openFixture();
    cy.get('input[type=file][accept*="image"]').selectFile("cypress/fixtures/img.png", { force: true });
    cy.get(".pdfedit-img").should("exist");
    // A run of arrow presses coalesces into one step.
    cy.get(".pdfedit-img").focus().trigger("keydown", { key: "ArrowRight" }).trigger("keydown", { key: "ArrowRight" });
    cy.get(".pdfedit-img").should(($b) => expect(parseFloat($b[0].style.left)).to.eq(50));
    cy.get('.pdfedit-toolbar [aria-label="Undo (Ctrl+Z)"]').click();
    cy.get(".pdfedit-img").should(($b) => expect(parseFloat($b[0].style.left)).to.eq(40));
    cy.get('.pdfedit-toolbar [aria-label="Undo (Ctrl+Z)"]').click();
    cy.get(".pdfedit-img").should("not.exist");
    cy.get('.pdfedit-toolbar [aria-label="Redo (Ctrl+Y)"]').click();
    cy.get(".pdfedit-img").should("exist").and(($b) => expect(parseFloat($b[0].style.left)).to.eq(40));
  });

  it("undoes a text box added in blank space back to nothing", () => {
    openFixture();
    cy.get(".pdfedit-page")
      .first()
      .then(($p) => {
        const r = $p[0]!.getBoundingClientRect();
        cy.wrap($p).dblclick(r.width * 0.3, r.height * 0.45, { force: true });
      });
    cy.get(".pdfedit-para.pdfedit-active").should("exist");
    cy.focused().type("ZZBOX");
    // Two steps: the typed content, then the box creation itself.
    cy.get('.pdfedit-toolbar [aria-label="Undo (Ctrl+Z)"]').click();
    cy.get("#editor").should("not.contain.text", "ZZBOX");
    cy.get('.pdfedit-toolbar [aria-label="Undo (Ctrl+Z)"]').click();
    cy.get(".pdfedit-para").each(($el) => expect($el.text()).to.not.contain("ZZBOX"));
  });

  it("restores an editing session from saved state (re-render pristine + replay edits)", () => {
    openFixture();
    // Append a marker to the first paragraph (keeps the original text too).
    cy.get(".pdfedit-para").first().click().type("{moveToEnd} ZZSTATE");
    // Snapshot the session, then destroy + recreate from that state (what history Restore does).
    let saved: unknown;
    cy.window().then((win) => {
      saved = (win as unknown as { __pdfeditDemo: { getEditor: () => { getState: () => unknown } } }).__pdfeditDemo.getEditor().getState();
    });
    cy.window().then((win) => {
      (win as unknown as { __pdfeditDemo: { restore: (s: unknown) => void } }).__pdfeditDemo.restore(saved);
    });
    cy.get(".pdfedit-para", { timeout: RENDER_TIMEOUT }).should("exist");
    // The edit survived and the original text is present exactly once (no doubling, no loss).
    cy.get("#editor").invoke("text").should((t) => {
      expect(t, "edit replayed").to.contain("ZZSTATE");
      expect(t, "original text preserved").to.contain("Premier");
      expect((t.match(/Premier/g) || []).length, "no doubled text").to.eq(1);
    });
  });
});
