import { t } from "./i18n";

// Find bar: searches the document's extracted text (pdf.js text items, cached
// per page by the host) and highlights matches with absolutely-positioned
// overlays on the page shells, which exist for every page before its content
// renders. Non-invasive by design: the editable overlays are never mutated, so
// searching can never dirty a document or leak markup into an export.
// Limitation: text typed in this session is searched only after the document
// is saved and reopened (the index reads the original text).

export interface SearchItem {
  str: string;
  x: number; // PDF-space baseline origin
  y: number;
  w: number;
  size: number;
}

export interface SearchMatch {
  page: number;
  /** One rectangle per text item the match overlaps (a match can span items). */
  rects: { item: SearchItem; startFrac: number; endFrac: number }[];
}

/** Pure matcher: case-insensitive query over concatenated page items. Items on
    different baselines are separated so matches never leak across lines. */
export function findMatches(pages: SearchItem[][], query: string): SearchMatch[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: SearchMatch[] = [];
  pages.forEach((items, page) => {
    let text = "";
    const spans: { start: number; end: number; item: SearchItem }[] = [];
    let prevY: number | null = null;
    for (const item of items) {
      if (prevY != null && Math.abs(item.y - prevY) > item.size * 0.5) text += "\n";
      prevY = item.y;
      const start = text.length;
      text += item.str.toLowerCase();
      spans.push({ start, end: text.length, item });
    }
    let idx = text.indexOf(q);
    while (idx !== -1) {
      const end = idx + q.length;
      const rects: SearchMatch["rects"] = [];
      for (const sp of spans) {
        if (sp.end <= idx || sp.start >= end) continue;
        const len = sp.end - sp.start || 1;
        rects.push({
          item: sp.item,
          startFrac: Math.max(0, idx - sp.start) / len,
          endFrac: Math.min(len, end - sp.start) / len,
        });
      }
      if (rects.length) out.push({ page, rects });
      idx = text.indexOf(q, idx + 1);
    }
  });
  return out;
}

export interface SearchDeps {
  /** Container the bar is inserted into (after the toolbar). */
  barParent: HTMLElement;
  beforeEl: HTMLElement | null;
  pageShell(index: number): { el: HTMLElement; viewport: { convertToViewportPoint(x: number, y: number): number[] } } | undefined;
  pageCount(): number;
  getPageItems(index: number): Promise<SearchItem[]>;
}

export function setupSearch(deps: SearchDeps) {
  const bar = document.createElement("div");
  bar.className = "pdfedit-findbar";
  bar.hidden = true;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "pdfedit-findinput";
  input.setAttribute("aria-label", t("find"));
  input.placeholder = t("find");
  const count = document.createElement("span");
  count.className = "pdfedit-findcount";
  count.setAttribute("aria-live", "polite");
  const mkBtn = (label: string, title: string, fn: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", fn);
    return b;
  };
  const prevBtn = mkBtn("‹", t("findPrev"), () => step(-1));
  const nextBtn = mkBtn("›", t("findNext"), () => step(1));
  const closeBtn = mkBtn("✕", t("findClose"), () => hide());
  bar.append(input, count, prevBtn, nextBtn, closeBtn);
  deps.barParent.insertBefore(bar, deps.beforeEl);

  let matches: SearchMatch[] = [];
  let current = -1;
  let highlights: HTMLElement[] = [];
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const clearHighlights = () => {
    for (const h of highlights) h.remove();
    highlights = [];
  };

  const drawMatch = (m: SearchMatch, isCurrent: boolean): HTMLElement | null => {
    const shell = deps.pageShell(m.page);
    if (!shell) return null;
    let first: HTMLElement | null = null;
    for (const r of m.rects) {
      const { item } = r;
      const x0 = item.x + item.w * r.startFrac;
      const x1 = item.x + item.w * r.endFrac;
      const p0 = shell.viewport.convertToViewportPoint(x0, item.y + item.size);
      const p1 = shell.viewport.convertToViewportPoint(x1, item.y - item.size * 0.25);
      const div = document.createElement("div");
      div.className = "pdfedit-find-hl" + (isCurrent ? " is-current" : "");
      div.style.left = `${Math.min(p0[0]!, p1[0]!)}px`;
      div.style.top = `${Math.min(p0[1]!, p1[1]!)}px`;
      div.style.width = `${Math.max(2, Math.abs(p1[0]! - p0[0]!))}px`;
      div.style.height = `${Math.abs(p1[1]! - p0[1]!)}px`;
      shell.el.appendChild(div);
      highlights.push(div);
      first ??= div;
    }
    return first;
  };

  const render = (scrollToCurrent: boolean) => {
    clearHighlights();
    let currentEl: HTMLElement | null = null;
    matches.forEach((m, i) => {
      const el = drawMatch(m, i === current);
      if (i === current) currentEl = el;
    });
    count.textContent = matches.length ? t("findCount", { i: current + 1, n: matches.length }) : input.value ? t("findNone") : "";
    if (scrollToCurrent && currentEl) (currentEl as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const run = async () => {
    const q = input.value;
    if (!q) {
      matches = [];
      current = -1;
      render(false);
      return;
    }
    const pages: SearchItem[][] = [];
    for (let i = 0; i < deps.pageCount(); i++) pages.push(await deps.getPageItems(i));
    matches = findMatches(pages, q);
    current = matches.length ? 0 : -1;
    render(true);
  };

  const step = (dir: 1 | -1) => {
    if (!matches.length) return;
    current = (current + dir + matches.length) % matches.length;
    render(true);
  };

  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => void run(), 200);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      hide();
    }
  });

  const show = () => {
    bar.hidden = false;
    input.focus();
    input.select();
  };
  const hide = () => {
    bar.hidden = true;
    clearHighlights();
  };
  const toggle = () => (bar.hidden ? show() : hide());

  return {
    toggle,
    show,
    hidden: () => bar.hidden,
    teardown() {
      clearTimeout(debounce);
      clearHighlights();
      bar.remove();
    },
  };
}
