import { describe, expect, it } from "vitest";
import { SnapHistory } from "./history";

// The editor state is faked as a mutable box; take() copies it like takeSnapshot does.
function setup() {
  const state = { v: "" };
  const h = new SnapHistory(
    () => ({ v: state.v }),
    (s) => s.v,
  );
  return { state, h };
}

describe("SnapHistory", () => {
  it("starts with nothing to undo or redo", () => {
    const { h } = setup();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBeNull();
  });

  it("records distinct steps and walks them back and forward", () => {
    const { state, h } = setup();
    state.v = "a";
    h.commit(null);
    state.v = "ab";
    h.commit(null);
    expect(h.undo()?.v).toBe("a");
    expect(h.undo()?.v).toBe("");
    expect(h.undo()).toBeNull();
    expect(h.redo()?.v).toBe("a");
    expect(h.redo()?.v).toBe("ab");
    expect(h.redo()).toBeNull();
  });

  it("coalesces a same-key run into one step", () => {
    const { state, h } = setup();
    for (const v of ["h", "he", "hel", "hell", "hello"]) {
      state.v = v;
      h.commit("t:1");
    }
    expect(h.undo()?.v).toBe("");
    expect(h.redo()?.v).toBe("hello");
  });

  it("breakRun splits two runs under the same key", () => {
    const { state, h } = setup();
    state.v = "one";
    h.commit("t:1");
    h.breakRun();
    state.v = "one two";
    h.commit("t:1");
    expect(h.undo()?.v).toBe("one");
    expect(h.undo()?.v).toBe("");
  });

  it("a different key starts a new step", () => {
    const { state, h } = setup();
    state.v = "text";
    h.commit("t:1");
    state.v = "text+img";
    h.commit("imv:1");
    expect(h.undo()?.v).toBe("text");
  });

  it("ignores commits that do not change the state", () => {
    const { state, h } = setup();
    state.v = "a";
    h.commit(null);
    h.commit(null);
    h.commit(null);
    h.undo();
    expect(h.canUndo).toBe(false);
  });

  it("a no-op commit under a fresh key still ends the previous run", () => {
    const { state, h } = setup();
    state.v = "a";
    h.commit("t:1");
    h.commit(null); // e.g. an op that turned out to change nothing
    state.v = "ab";
    h.commit("t:1");
    expect(h.undo()?.v).toBe("a");
  });

  it("new commits clear the redo branch", () => {
    const { state, h } = setup();
    state.v = "a";
    h.commit(null);
    h.undo();
    state.v = "b";
    h.commit(null);
    expect(h.canRedo).toBe(false);
    expect(h.undo()?.v).toBe("");
  });

  it("caps the stack depth", () => {
    const state = { v: "" };
    const h = new SnapHistory(
      () => ({ v: state.v }),
      (s) => s.v,
      3,
    );
    for (let i = 1; i <= 10; i++) {
      state.v = String(i);
      h.commit(null);
    }
    let n = 0;
    while (h.undo()) n++;
    expect(n).toBe(3);
  });

  it("reset drops history and rebaselines", () => {
    const { state, h } = setup();
    state.v = "restored";
    h.commit(null);
    h.reset();
    expect(h.canUndo).toBe(false);
    state.v = "restored+edit";
    h.commit(null);
    expect(h.undo()?.v).toBe("restored");
  });
});
