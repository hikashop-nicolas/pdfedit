/// <reference types="cypress" />

// End-to-end coverage for the find bar, the style-toggle typeface preservation
// and the password-protected open path.

const RENDER_TIMEOUT = 30000;

function openFixture(name: string) {
  cy.visit("/");
  cy.get("#file").selectFile(`cypress/fixtures/${name}`, { force: true });
  cy.get(".pdfedit-para", { timeout: RENDER_TIMEOUT }).should("have.length.greaterThan", 0);
}

describe("find bar", () => {
  it("finds, counts, highlights and steps through matches", () => {
    openFixture("embedded.pdf");
    cy.get('.pdfedit-toolbar [aria-label="Find"]').click();
    cy.get(".pdfedit-findinput").type("euros");
    cy.get(".pdfedit-find-hl", { timeout: 10000 }).should("have.length", 1);
    cy.get(".pdfedit-findcount").should("contain.text", "1 / 1");
    // A broader query has several matches; Enter cycles the current one.
    cy.get(".pdfedit-findinput").clear().type("the");
    cy.get(".pdfedit-find-hl").should("have.length.greaterThan", 1);
    cy.get(".pdfedit-findcount")
      .invoke("text")
      .then((before) => {
        cy.get(".pdfedit-findinput").type("{enter}");
        cy.get(".pdfedit-findcount").invoke("text").should("not.eq", before);
      });
    // Escape closes and clears the highlights.
    cy.get(".pdfedit-findinput").type("{esc}");
    cy.get(".pdfedit-findbar").should("not.be.visible");
    cy.get(".pdfedit-find-hl").should("not.exist");
  });
});

describe("style toggles keep the embedded typeface", () => {
  it("bolding a word does not switch the export to Helvetica", () => {
    openFixture("embedded.pdf");
    // Select the word "Dupont" (wherever paragraph grouping put it) and toggle bold.
    cy.get(".pdfedit-para").then(($paras) => {
      let node: Text | null = null;
      let idx = -1;
      for (const el of $paras.toArray()) {
        const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const t = walker.currentNode as Text;
          idx = (t.textContent ?? "").indexOf("Dupont");
          if (idx !== -1) {
            node = t;
            break;
          }
        }
        if (node) break;
      }
      expect(node, "text node containing Dupont").to.not.eq(null);
      const range = node!.ownerDocument!.createRange();
      range.setStart(node!, idx);
      range.setEnd(node!, idx + "Dupont".length);
      const sel = node!.ownerDocument!.defaultView!.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    cy.get('.pdfedit-toolbar [aria-label="Bold"]').click();
    cy.window().then(async (win) => {
      const editor = (win as unknown as { __pdfeditDemo: { getEditor(): { getBytes(): Promise<Uint8Array> } } }).__pdfeditDemo.getEditor();
      const bytes = await editor.getBytes();
      // Font names live inside FlateDecode object streams; inflate every stream so
      // the assertion sees them (a raw scan sees only compressed bytes). Collect
      // whatever inflates before an error: trailing bytes after a zlib stream
      // reject a strict whole-stream read.
      const inflateLoose = async (seg: Uint8Array): Promise<string> => {
        const ds = new (win as unknown as { DecompressionStream: new (f: string) => { writable: WritableStream; readable: ReadableStream<Uint8Array> } }).DecompressionStream("deflate");
        const writer = ds.writable.getWriter();
        void writer.write(seg).catch(() => undefined);
        void writer.close().catch(() => undefined);
        const reader = ds.readable.getReader();
        const dec = new TextDecoder("latin1");
        let out = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            out += dec.decode(value, { stream: true });
          }
        } catch {
          /* partial output is fine */
        }
        return out;
      };
      const raw = new TextDecoder("latin1").decode(bytes);
      let combined = raw;
      const re = /stream\r?\n/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) {
        const start = m.index + m[0].length;
        const end = raw.indexOf("endstream", start);
        if (end === -1) continue;
        combined += await inflateLoose(bytes.subarray(start, end));
      }
      // The edited paragraph re-embeds the original NotoSans program; no standard
      // Helvetica variant may appear as a replacement for the bolded word.
      expect(combined).to.match(/NotoSansJP/);
      expect(combined).to.not.match(/Helvetica/);
    });
  });
});

describe("password-protected PDFs", () => {
  it("opens view-only after the password prompt", () => {
    cy.visit("/", {
      onBeforeLoad(win) {
        cy.stub(win, "prompt").returns("secret123");
      },
    });
    cy.get("#file").selectFile("cypress/fixtures/protected.pdf", { force: true });
    cy.get(".pdfedit-note", { timeout: RENDER_TIMEOUT }).should("contain.text", "view only");
    cy.get(".pdfedit-para", { timeout: RENDER_TIMEOUT }).should("have.length.greaterThan", 0);
    cy.get(".pdfedit-para").first().should("have.attr", "contenteditable", "false");
  });

  it("shows a password-specific error when the prompt is cancelled", () => {
    cy.visit("/", {
      onBeforeLoad(win) {
        cy.stub(win, "prompt").returns(null);
      },
    });
    cy.get("#file").selectFile("cypress/fixtures/protected.pdf", { force: true });
    cy.get(".pdfedit-error", { timeout: RENDER_TIMEOUT }).should("contain.text", "password");
  });
});
