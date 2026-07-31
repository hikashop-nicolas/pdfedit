/// <reference types="cypress" />

// Two editors on one page, wired together as a collaboration host wires them.
//
// The collaboration surface is small (a snapshot out, a snapshot in, and undo handed over)
// and every part of it is about two documents rather than one, so testing it against a
// single editor would prove almost nothing. What has broken in the other editors was always
// the seam: an apply that echoes back to its sender, an apply that steals the caret, an
// undo that takes back the other person's work.
//
// No network. A's snapshot goes straight to B, which is what the session does once a
// transport has delivered it.

const RENDER_TIMEOUT = 30000;

interface ParagraphEdit {
  page: number;
  index: number;
  html: string;
  align?: string;
}
interface Snapshot {
  edits: ParagraphEdit[];
  boxes: { id: string; page: number; html: string }[];
  images: { id: string }[];
  whiteouts: { id: string; page: number }[];
}
interface UndoHandler {
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}
interface Editor {
  getSnapshot(): Snapshot;
  applyRemote(snap: Snapshot): void;
  setChangeReporter(handler: ((snap: Snapshot) => void) | null): void;
  setUndoHandler(handler: UndoHandler | null): void;
  getState(): { original: Uint8Array };
  destroy(): void;
}
interface Demo {
  getEditor(): Editor;
  createPdfEditor(el: HTMLElement, bytes: Uint8Array, opts: Record<string, unknown>): Editor;
  workerSrc: string;
}

interface Pair {
  a: Editor;
  b: Editor;
  /** Every snapshot each side reported, in order. */
  sent: { a: Snapshot[]; b: Snapshot[] };
}

/**
 * Build a second editor from the same bytes and wire the two.
 *
 * The wiring is the smallest thing that deserves the name: a reported snapshot is handed
 * straight to the other side. That is what the session does with a CRDT in between.
 */
function pair(): Cypress.Chainable<Pair> {
  return cy.window().then((w) => {
    const demo = (w as unknown as { __pdfeditDemo: Demo }).__pdfeditDemo;
    const a = demo.getEditor();
    const original = a.getState().original;

    const host = w.document.createElement("div");
    host.id = "second-editor";
    w.document.body.appendChild(host);

    const state: Pair = { a, b: null as unknown as Editor, sent: { a: [], b: [] } };
    let applying = false;

    state.b = demo.createPdfEditor(host, original.slice(), { workerSrc: demo.workerSrc });

    const wire = (from: Editor, to: () => Editor, side: "a" | "b"): void => {
      from.setChangeReporter((snap) => {
        // Counted before the guard, deliberately. The guard below exists so this harness
        // cannot loop; counting after it would mean the echo test measured the harness
        // rather than the editor, and would pass even with the editor's own guard removed.
        state.sent[side].push(snap);
        if (applying) return;
        applying = true;
        try {
          to().applyRemote(snap);
        } finally {
          applying = false;
        }
      });
    };
    wire(state.a, () => state.b, "a");
    wire(state.b, () => state.a, "b");
    return state;
  });
}

function openFixture() {
  cy.visit("/");
  cy.get("#file").selectFile("cypress/fixtures/test.pdf", { force: true });
  cy.get(".pdfedit-para", { timeout: RENDER_TIMEOUT }).should("have.length.greaterThan", 0);
}

/** Type into a paragraph the way a person does: focus it, put text in, let it commit. */
function typeInto(selector: string, index: number, text: string) {
  cy.get(selector).eq(index).click().type(text);
  cy.get(selector).eq(index).blur();
}

const parasA = "#editor .pdfedit-para";
const parasB = "#second-editor .pdfedit-para";

/** Drag a rectangle on a page, the way the whiteout tool is really used. */
function dragOn(pageSelector: string, x0f: number, y0f: number, x1f: number, y1f: number) {
  cy.get(pageSelector)
    .first()
    .then(($p) => {
      const r = $p[0]!.getBoundingClientRect();
      const x0 = r.left + r.width * x0f;
      const y0 = r.top + r.height * y0f;
      const x1 = r.left + r.width * x1f;
      const y1 = r.top + r.height * y1f;
      cy.wrap($p)
        .trigger("pointerdown", { clientX: x0, clientY: y0, button: 0, force: true })
        .trigger("pointermove", { clientX: (x0 + x1) / 2, clientY: (y0 + y1) / 2, force: true });
      cy.document().then((doc) => {
        doc.dispatchEvent(new PointerEvent("pointermove", { clientX: x1, clientY: y1, bubbles: true }));
        doc.dispatchEvent(new PointerEvent("pointerup", { clientX: x1, clientY: y1, bubbles: true }));
      });
    });
}

describe("two pdf editors wired together", () => {
  // One pair per test, built once: calling pair() again would wire up a third editor.
  let p: Pair;

  beforeEach(() => {
    openFixture();
    pair().then((made) => {
      p = made;
    });
    // The second editor renders the same PDF, which takes a moment.
    cy.get(parasB, { timeout: RENDER_TIMEOUT }).should("have.length.greaterThan", 0);
  });

  it("carries an edit from one editor to the other", () => {
    typeInto(parasA, 0, " Edited on A.");
    cy.get(parasB).eq(0).should("contain.text", "Edited on A.");
  });

  // The echo. Applying a peer's snapshot must not count as a local change, or each side
  // would hand it back and the two would trade it forever.
  it("does not report a peer's edit back to them", () => {
    cy.wrap(null).then(() => {
      const before = p.sent.b.length;
      typeInto(parasA, 0, " From A.");
      cy.get(parasB).eq(0).should("contain.text", "From A.");
      cy.wrap(null).then(() => {
        expect(p.sent.b.length, "applying is not editing").to.equal(before);
      });
    });
  });

  // The focus. pdfedit's own undo focuses whatever it restored and selects its contents,
  // which is right for undo and wrong for a peer: it would pull this person out of what
  // they are doing every time the other one types.
  //
  // Asserted around applyRemote itself rather than around a click, because both editors
  // live in one document here and therefore share one focus: clicking into A would move
  // the focus away from B for reasons that have nothing to do with the code under test.
  // Two real peers are two documents; applyRemote not touching focus is the property that
  // makes that work.
  it("does not touch the focus when a peer's edit lands", () => {
    cy.get('#second-editor .pdfedit-toolbar [aria-label*="Whiteout"]').click();
    dragOn("#second-editor .pdfedit-page", 0.2, 0.6, 0.5, 0.75);
    cy.get("#second-editor .pdfedit-white").should("have.length", 1);

    typeInto(parasA, 0, " Ada types.");
    cy.get(parasB).eq(0).should("contain.text", "Ada types.");

    cy.get("#second-editor .pdfedit-white").focus();
    cy.get("#second-editor .pdfedit-white").then(($white) => {
      const mine = $white[0];
      cy.document().then((doc) => {
        expect(doc.activeElement, "focused to begin with").to.equal(mine);
        p.b.applyRemote(p.a.getSnapshot());
        expect(doc.activeElement, "and still focused after the peer's edit").to.equal(mine);
      });
    });
  });

  // An added object has no position to be named by, so it carries an id. The id is what
  // makes two people each adding one end up with two objects rather than one.
  it("carries an added whiteout, under the id its author gave it", () => {
    cy.get('#editor .pdfedit-toolbar [aria-label*="Whiteout"]').click();
    dragOn("#editor .pdfedit-page", 0.2, 0.2, 0.5, 0.35);

    cy.wrap(null).then(() => {
      const mine = p.a.getSnapshot().whiteouts;
      expect(mine.length, "A drew one").to.equal(1);
      expect(mine[0].id, "and it has an id").to.be.a("string").and.not.equal("");
      const theirs = p.b.getSnapshot().whiteouts;
      expect(theirs.map((w) => w.id), "B has it under the same id").to.deep.equal([mine[0].id]);
    });
    cy.get("#second-editor .pdfedit-white").should("have.length", 1);
  });

  it("hands undo to a host that asks for it, on either side", () => {
    cy.wrap(null).then(() => {
      const calls: string[] = [];
      p.b.setUndoHandler({
        undo: () => calls.push("undo"),
        redo: () => calls.push("redo"),
        canUndo: () => true,
        canRedo: () => true,
      });

      cy.get(parasB).eq(0).click().type("{ctrl}z");
      cy.get(parasB).eq(0).type("{ctrl}{shift}z");
      cy.wrap(null).then(() => {
        expect(calls, "the session's stack, not the editor's").to.deep.equal(["undo", "redo"]);
      });
    });
  });

  it("gives undo back when the session ends", () => {
    cy.wrap(null).then(() => {
      p.b.setUndoHandler({
        undo: () => undefined,
        redo: () => undefined,
        canUndo: () => true,
        canRedo: () => true,
      });
      p.b.setUndoHandler(null);

      typeInto(parasB, 0, " B typed this.");
      cy.get(parasB).eq(0).should("contain.text", "B typed this.");
      cy.get(parasB).eq(0).click().type("{ctrl}z");
      cy.get(parasB).eq(0).should("not.contain.text", "B typed this.");
    });
  });
});
