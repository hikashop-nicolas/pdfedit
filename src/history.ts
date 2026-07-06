// Snapshot-based undo/redo. The editor mutates state through many paths (typing,
// execCommand, Range surgery, image/box structure), so instead of per-operation
// inverse commands the stack stores full lightweight snapshots and the editor
// re-applies them wholesale. Snapshots share large payloads (image bytes) by
// reference, so a step costs only the dirty paragraphs' HTML strings.
//
// commit() with a coalesce key merges consecutive same-key commits into one step
// (a typing run undoes as a unit); breakRun() ends the current run so the next
// commit starts a new step even under the same key.

export class SnapHistory<S> {
  private undoStack: S[] = [];
  private redoStack: S[] = [];
  private cur: S;
  private curSig: string;
  private lastKey: string | null = null;

  constructor(
    private take: () => S,
    private sig: (s: S) => string,
    private cap = 100,
  ) {
    this.cur = take();
    this.curSig = sig(this.cur);
  }

  /** Record the current state as a step (or fold it into the active run). */
  commit(key?: string | null): void {
    const s = this.take();
    const g = this.sig(s);
    if (g === this.curSig) {
      this.lastKey = key ?? null;
      return;
    }
    if (key != null && key === this.lastKey) {
      this.cur = s;
      this.curSig = g;
      return;
    }
    this.undoStack.push(this.cur);
    if (this.undoStack.length > this.cap) this.undoStack.shift();
    this.cur = s;
    this.curSig = g;
    this.lastKey = key ?? null;
    this.redoStack.length = 0;
  }

  /** End the active coalescing run (focus change, discrete op, undo/redo). */
  breakRun(): void {
    this.lastKey = null;
  }

  /** Step back; returns the snapshot to re-apply, or null at the bottom. */
  undo(): S | null {
    if (!this.undoStack.length) return null;
    this.redoStack.push(this.cur);
    this.cur = this.undoStack.pop()!;
    this.curSig = this.sig(this.cur);
    this.lastKey = null;
    return this.cur;
  }

  /** Step forward; returns the snapshot to re-apply, or null at the top. */
  redo(): S | null {
    if (!this.redoStack.length) return null;
    this.undoStack.push(this.cur);
    this.cur = this.redoStack.pop()!;
    this.curSig = this.sig(this.cur);
    this.lastKey = null;
    return this.cur;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Drop all history and rebaseline on the current state (session restore). */
  reset(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.cur = this.take();
    this.curSig = this.sig(this.cur);
    this.lastKey = null;
  }
}
