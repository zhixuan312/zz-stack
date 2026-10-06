/**
 * The document panel: a document from the team's store, in the page a client renders beside
 * `document_present`'s result — inside a conversation with an agent, not on its own.
 *
 * That is the premise of every choice here. The person reviews with the agent, so the panel's job
 * is to make that collaboration exact: show the whole document however long, keep them oriented
 * (a sticky bar with the section, the share read and the minutes left; a jump list with each
 * section's length; a rail on a wide panel; each document's place kept), tell the agent what they
 * see (context.ts), turn a selection into a question or a note (review.ts), mark what changed since
 * the version before so a re-review reads only what moved, and take the approval through the same
 * `document_approve` a model would call. Layout follows the panel's own width, not the window's.
 *
 * One theme and one register, the console's: cream ground, hairlines not shadows, one accent for
 * the one primary action, green/amber/red for approved/waiting/refused and nothing else, the kit
 * blue for what changed. The `state-approved` mascot appears for its one job.
 */
import { minutesOf, compareSections, renderMarkdown } from "./render.ts";
import { schedule, tellModel } from "./context.ts";
import { addNote, dropNote, dropPick, explain, loadNotes, notesBlock, selbar, sendNotes, startNote, syncSelection } from "./review.ts";
import { answer, app, current, esc, root, state, type Approval, type PanelDocument, type Shown, type Slot } from "./state.ts";
import approvedArt from "./brand/state-approved.png";
import wordmark from "./brand/wordmark.png";

const DOCS_KEY = "zz-core/documents";
/** Past this many words a document is one a person should be offered the whole screen for. */
const LONG_WORDS = 2000;
let jumpOpen = false;

const humanName = (name: string): string => {
  const base = name.replace(/\.md$/, "").replace(/[-_]+/g, " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
};
const day = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

/** What the header's pill says, and in which of the three reserved tones. */
function standing(s: Slot): { label: string; tone: "green" | "amber" | "neutral" } {
  const d = s.doc;
  if (!d.latest) return { label: "Earlier version", tone: "neutral" };
  if (s.approval === "done" || d.status === "approved") return { label: "Approved", tone: "green" };
  if (d.gate) return { label: "Written", tone: "neutral" };
  return { label: "Awaiting approval", tone: "amber" };
}

/** What moved since the version before, in one line of the header's facts. */
function changeFact(s: Slot): string | null {
  if (!s.doc.previous) return null;
  const changed = [...s.marks.values()].filter((m) => m === "changed").length;
  const added = [...s.marks.values()].filter((m) => m === "new").length;
  const parts = [changed && `${changed} changed`, added && `${added} new`, s.removed.length && `${s.removed.length} removed`].filter(Boolean);
  return `<span class="fact-change">${parts.length ? parts.join(", ") : "no section changed"} since v${s.doc.previous.version}</span>`;
}

function header(s: Slot): string {
  const d = s.doc;
  const pill = standing(s);
  const title = s.view.title ?? humanName(d.name);
  const sections = s.view.outline.filter((o) => o.level === 2).length;
  // The file's name, unless the tabs below already say it.
  const facts = [...(state.slots.length > 1 ? [] : [`<span class="mono chip">${esc(d.name)}</span>`]),
                 `v${d.version}`, `${minutesOf(s.view.words)} min read`];
  if (sections) facts.push(`${sections} section${sections === 1 ? "" : "s"}`);
  const change = changeFact(s);
  if (change) facts.push(change);
  const tabs = state.slots.length > 1
    ? `<nav class="tabs" aria-label="Documents">${state.slots.map((t, i) =>
        `<button class="tab" data-tab="${i}" aria-current="${i === state.active}">${esc(t.doc.name)}</button>`).join("")}</nav>`
    : "";
  // One control for the screen: a long document is offered the whole of it in words; leaving it
  // is always offered.
  const mode = !state.canFullscreen ? ""
    : state.fullscreen ? `<button class="btn-link" data-act="mode">Exit full screen</button>`
    : s.view.words > LONG_WORDS ? `<button class="btn-link" data-act="mode">Read full screen</button>`
    : `<button class="icon-btn" data-act="mode" aria-label="Read full screen" title="Read full screen">↗</button>`;
  return `<header class="head">
    <div class="eyebrow"><img class="wordmark" src="${wordmark}" alt="" /><span>${esc(d.initiative)}</span>${mode}</div>
    <div class="title-row"><h1 class="title">${esc(title)}</h1><span class="pill pill-${pill.tone}">${pill.label}</span></div>
    <p class="facts">${facts.join('<span class="sep">·</span>')}</p>
    ${tabs}
  </header>`;
}

/** The sections, each with its own length and what changed: the rail on a wide panel, the jump list on any. */
function sectionList(s: Slot, cls: string): string {
  return s.view.outline.map((o) => {
    const mark = s.marks.get(o.id);
    return `<a class="${cls}-${o.level}" href="#${o.id}" data-section="${o.id}"><span>${esc(o.text)}</span>` +
      (mark ? `<span class="mark">${mark}</span>` : "") +
      (o.level === 2 ? `<span class="mins">${minutesOf(o.words)} min</span>` : "") + `</a>`;
  }).join("");
}

/** The reading pane's own head: which section this is, how far through, and the way to the others. */
function bar(s: Slot): string {
  const listed = s.view.outline.length > 1;
  const toggle = s.marks.size
    ? `<button class="bar-toggle" data-act="only-changes" aria-pressed="${s.onlyChanges}">${s.onlyChanges ? "Show all" : "Changes only"}</button>` : "";
  return `<div class="bar">
    ${listed ? `<button class="bar-section" data-act="jump" aria-expanded="${jumpOpen}" aria-controls="jump">
      <span class="bar-label">Beginning</span><span class="caret" aria-hidden="true">▾</span></button>`
      : `<span class="bar-section"><span class="bar-label">${esc(s.view.title ?? humanName(s.doc.name))}</span></span>`}
    <span class="bar-meta" aria-live="off"></span>
    ${toggle}
    <button class="bar-top" data-act="top" hidden>↑ Top</button>
    <div class="progress" aria-hidden="true"><i></i></div>
    ${listed ? `<nav id="jump" class="jump" aria-label="Sections" ${jumpOpen ? "" : "hidden"}>${sectionList(s, "jp")}</nav>` : ""}
  </div>`;
}

/** The first `# ` heading is the title, and the header already shows it: said once. */
const withoutTitle = (s: Slot): string =>
  s.view.title === null ? s.view.html : s.view.html.replace(/<h1 id="[^"]*">[\s\S]*?<\/h1>\n?/, "");

function footer(s: Slot): string {
  const d = s.doc;
  const who = d.approvedBy ? ` by ${esc(d.approvedBy)}` : "";
  if (!d.latest) {
    return `<footer class="foot"><p class="note">${d.version === d.current
      ? `This is an earlier snapshot of v${d.version}. Only its current one can be approved — open the document again.`
      : `This is version ${d.version}. Only the current version, v${d.current ?? "?"}, can be approved.`}</p></footer>`;
  }
  if (s.approval === "done") {
    return `<footer class="foot foot-done" role="status">
      <img class="mascot" src="${approvedArt}" alt="" />
      <div><p class="done-title">Approved</p><p class="note">v${d.version} carries your signature. The conversation has been told.</p></div>
    </footer>`;
  }
  const shown = s.shown === "recorded"
    ? `<span class="dot dot-green"></span>Shown to you in full`
    : s.shown === "pending" ? `<span class="dot"></span>Recording that you have it in front of you…`
    : `<span class="dot dot-red"></span>${esc(s.shown.failed)}`;
  const status = d.status === "approved"
    ? `<span class="dot dot-green"></span>Approved${who}${d.approvedAt ? ` on ${esc(day(d.approvedAt))}` : ""}.`
    : s.sent ?? shown;
  const failed = typeof s.approval === "object" ? `<p class="error" role="alert">${esc(s.approval.failed)}</p>` : "";
  const busy = s.approval === "busy";
  const n = s.notes.length;
  // One primary act at a time: with notes waiting, sending them is what comes next.
  const canApprove = !d.gate && d.status !== "approved";
  const acts = s.noting ? "" : `<div class="row">
      <button class="btn btn-quiet" data-act="note-doc" ${busy ? "disabled" : ""}>Add a note</button>
      ${n ? `<button class="btn btn-primary" data-act="send-notes">Send ${n} note${n === 1 ? "" : "s"}</button>` : ""}
      ${canApprove ? `<button class="btn ${n ? "btn-quiet" : "btn-primary"}" data-act="sign" ${busy || s.shown !== "recorded" ? "disabled" : ""}>
        ${busy ? "Approving…" : `Approve v${d.version}`}</button>` : ""}</div>`;
  return `<footer class="foot">
    <p class="note" role="status">${status}</p>
    ${d.gate && d.status !== "approved" ? `<p class="note">No approval: this document carries no gate.</p>` : ""}
    ${failed}
    ${notesBlock(s)}
    ${acts}
  </footer>`;
}

/** The document last drawn. A redraw of the same one — a click, an approval in flight — must not
 *  replay its arrival; a new document, or another tab, arrives. */
let lastDrawn: Slot | null = null;

function draw(): void {
  const s = current();
  if (!state.received) {
    root.innerHTML = `<div class="panel" aria-busy="true"><div class="head"><div class="sk sk-line"></div>
      <div class="sk sk-title"></div></div><div class="body"><div class="read">
      <div class="sk sk-line"></div><div class="sk sk-line"></div><div class="sk sk-short"></div></div></div></div>`;
    return;
  }
  if (!s) {
    // A part the assistant read for itself draws no panel: one line says where the document is.
    root.innerHTML = state.reading
      ? `<p class="reading-note">The assistant read part of this document. The whole of it is in the panel above.</p>`
      : `<div class="panel"><p class="empty">document_present returned no document to show.</p></div>`;
    return;
  }
  const rail = s.view.outline.length > 1
    ? `<nav class="rail" aria-label="Sections"><p class="eyebrow-text">In this document</p>${sectionList(s, "rl")}</nav>` : "";
  const removed = s.onlyChanges && s.removed.length
    ? `<p class="removed">Removed since v${s.doc.previous?.version}: ${s.removed.map(esc).join("; ")}</p>` : "";
  const arrive = s !== lastDrawn;
  lastDrawn = s;
  root.innerHTML = `<div class="panel ${state.fullscreen ? "is-full" : ""} ${arrive ? "arrive" : ""}" style="--pane-h:${state.paneHeight}px">
    ${header(s)}
    <div class="body">${rail}<div class="read" tabindex="0">${bar(s)}${removed}
      <article class="prose ${s.onlyChanges ? "only-changes" : ""}">${withoutTitle(s)}</article>${selbar()}</div></div>
    ${footer(s)}
  </div>`;
  const since = s.doc.previous?.version;
  for (const [id, mark] of s.marks) {
    const sec = root.querySelector<HTMLElement>(`section[data-sec="${CSS.escape(id)}"]`);
    if (sec) { sec.dataset.mark = mark; sec.dataset.since = String(since ?? ""); }
  }
  const read = root.querySelector<HTMLElement>(".read");
  if (read) {
    read.scrollTop = s.scroll;
    read.addEventListener("scroll", () => { s.scroll = read.scrollTop; follow(); }, { passive: true });
  }
  follow();
}

/** Keep the bar, the rail and the jump list on the section being read. Runs once a frame at most. */
let queued = false;
function follow(): void {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    const s = current();
    const read = root.querySelector<HTMLElement>(".read");
    if (!s || !read) return;
    const barH = read.querySelector<HTMLElement>(".bar")?.offsetHeight ?? 0;
    const span = read.scrollHeight - read.clientHeight;
    const share = span > 0 ? Math.min(1, read.scrollTop / span) : 1;
    let here: (typeof s.view.outline)[number] | undefined;
    for (const o of s.view.outline) {
      const el = read.querySelector<HTMLElement>(`[id="${CSS.escape(o.id)}"]`);
      if (!el || el.offsetParent === null) continue;   // hidden by "Changes only"
      if (top(el, read) <= read.scrollTop + barH + 12) here = o; else break;
    }
    const top2 = here?.level === 3
      ? s.view.outline.slice(0, s.view.outline.indexOf(here) + 1).reverse().find((o) => o.level === 2) : here;
    // The section, and the subsection within it: "2. The roots / skills/".
    const label = read.querySelector(".bar-label");
    if (label && s.view.outline.length > 1) {
      label.innerHTML = esc(top2?.text ?? "Beginning") +
        (here && here !== top2 ? `<span class="sub"> / ${esc(here.text)}</span>` : "");
    }
    const left = Math.round((1 - share) * s.view.words / 220);
    const meta = read.querySelector(".bar-meta");
    if (meta) meta.textContent = share >= 0.99 ? "End" : `${Math.round(share * 100)}% · ${Math.max(1, left)} min left`;
    const fill = read.querySelector<HTMLElement>(".progress i");
    if (fill) fill.style.width = `${share * 100}%`;
    read.querySelector<HTMLElement>(".bar-top")?.toggleAttribute("hidden", read.scrollTop < read.clientHeight);
    const passed = new Set(s.view.outline.slice(0, here ? s.view.outline.indexOf(here) : 0).map((o) => o.id));
    for (const a of root.querySelectorAll<HTMLElement>("[data-section]")) {
      a.classList.toggle("is-here", a.dataset.section === here?.id || a.dataset.section === top2?.id);
      a.classList.toggle("is-passed", passed.has(a.dataset.section ?? ""));
    }
    root.querySelector(".rail .is-here")?.scrollIntoView({ block: "nearest" });
    tellModel(here, top2, share);
  });
}

/** An element's offset from the top of the reading pane's content, through any wrapping section. */
function top(el: HTMLElement, read: HTMLElement): number {
  return el.getBoundingClientRect().top - read.getBoundingClientRect().top + read.scrollTop;
}

/** Scroll the reading pane to a heading, below the sticky bar rather than under it. */
function goTo(id: string): void {
  const read = root.querySelector<HTMLElement>(".read");
  const el = read?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
  if (!read || !el) return;
  const barH = read.querySelector<HTMLElement>(".bar")?.offsetHeight ?? 0;
  const to = top(el, read) - barH - 8;
  // A short hop glides, so the reader sees where they went; a long one lands at once — twenty
  // screens of text streaming past is disorienting, and slow.
  read.scrollTo({ top: to, behavior: Math.abs(to - read.scrollTop) > 2 * read.clientHeight ? "instant" : "smooth" });
}

/** Record the active document as shown, once it is on screen. Nothing records for history, for a
 *  document with no ticket, or twice. */
async function recordShown(s: Slot): Promise<void> {
  if (s.shown !== "pending") return;
  if (!s.doc.ticket || !s.doc.latest) { s.shown = "recorded"; draw(); return; }
  try {
    const r = answer(await app.callServerTool({ name: "document_shown",
      arguments: { path: s.doc.path, version: s.doc.version, ticket: s.doc.ticket } }));
    s.shown = r.ok ? "recorded" : { failed: r.said };
  } catch (err) {
    s.shown = { failed: `This client would not record it: ${err instanceof Error ? err.message : String(err)}` };
  }
  draw();
}
const show = (i: number): void => {
  state.active = i;
  state.pick = null;
  jumpOpen = false;
  draw();
  requestAnimationFrame(() => void recordShown(state.slots[state.active]!));
};

async function sign(s: Slot): Promise<void> {
  s.approval = "busy"; draw();
  try {
    const r = answer(await app.callServerTool({ name: "document_approve", arguments: { path: s.doc.path } }));
    if (!r.ok) { s.approval = { failed: r.said }; draw(); return; }
    s.approval = "done";
    draw();
    await app.sendMessage({ role: "user", content: [{ type: "text",
      text: `I approved ${s.doc.path} (v${s.doc.version}) in the document panel.` }] });
  } catch (err) {
    s.approval = { failed: err instanceof Error ? err.message : String(err) };
    draw();
  }
}

/** The jump list, opened and closed in place: redrawing the page would lose the reader's place. */
function setJump(open: boolean): void {
  jumpOpen = open;
  root.querySelector("#jump")?.toggleAttribute("hidden", !open);
  root.querySelector(".bar-section")?.setAttribute("aria-expanded", String(open));
  if (!open) return;
  // Opened on the section being read, not on the first one: the list is a way onward from here.
  const list = root.querySelector<HTMLElement>("#jump");
  const here = root.querySelector<HTMLElement>("#jump .is-here") ?? root.querySelector<HTMLElement>("#jump a");
  if (list && here) list.scrollTop = here.offsetTop - list.clientHeight / 2;
  here?.focus({ preventScroll: true });
}

// A button acting on the selection must not take the selection away by being pressed.
root.addEventListener("mousedown", (e) => { if ((e.target as HTMLElement).closest(".selbar button")) e.preventDefault(); });
root.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act], [data-tab], a[href]");
  if (!el) { if (jumpOpen) setJump(false); return; }
  const s = current();
  if (el.dataset.tab !== undefined) { show(Number(el.dataset.tab)); return; }
  if (el instanceof HTMLAnchorElement) {
    e.preventDefault();
    const href = el.getAttribute("href") ?? "";
    if (href.startsWith("#")) { goTo(href.slice(1)); setJump(false); }
    else if (/^(https?:|mailto:)/i.test(href)) void app.openLink({ url: href });
    return;
  }
  if (!s) return;
  switch (el.dataset.act) {
    case "sign": void sign(s); break;
    case "jump": setJump(!jumpOpen); break;
    case "top": root.querySelector<HTMLElement>(".read")?.scrollTo({ top: 0, behavior: "smooth" }); break;
    case "only-changes": s.onlyChanges = !s.onlyChanges; s.scroll = 0; draw(); break;
    case "explain": void explain(s); break;
    case "close-pick": dropPick(); break;
    case "note-sel": startNote(s, true); draw(); root.querySelector<HTMLTextAreaElement>("#note")?.focus(); break;
    case "note-doc": startNote(s, false); draw(); root.querySelector<HTMLTextAreaElement>("#note")?.focus(); break;
    case "cancel-note": s.noting = null; draw(); break;
    case "drop-note": dropNote(s, Number(el.dataset.i)); draw(); break;
    case "send-notes": void sendNotes(s).then(draw); break;
    case "mode":
      void app.requestDisplayMode({ mode: state.fullscreen ? "inline" : "fullscreen" })
        .then((r) => { state.fullscreen = r.mode === "fullscreen"; draw(); });
      break;
  }
});
root.addEventListener("keydown", (e) => { if (e.key === "Escape" && jumpOpen) setJump(false); });
root.addEventListener("submit", (e) => {
  e.preventDefault();
  const s = current();
  const text = root.querySelector<HTMLTextAreaElement>("#note")?.value ?? "";
  if (!s) return;
  addNote(s, text);
  draw();
});
document.addEventListener("selectionchange", syncSelection);

/** Take what the host says about the space and the modes it offers, and say what that changes:
 *  the page's shape (a redraw), only the pane's height (set in place), or nothing. A host sends this
 *  often — ChatGPT on a phone, whenever its own chrome moves — and a redraw for each clears the
 *  reader's selection and their phone's own Copy menu with it. */
function hostSays(ctx: ReturnType<typeof app.getHostContext>): "redraw" | "resize" | "none" {
  if (!ctx) return "none";
  const before = { can: state.canFullscreen, full: state.fullscreen, pane: state.paneHeight };
  if (ctx.availableDisplayModes) state.canFullscreen = ctx.availableDisplayModes.includes("fullscreen");
  if (ctx.displayMode) state.fullscreen = ctx.displayMode === "fullscreen";
  const dims = ctx.containerDimensions as { maxHeight?: number; height?: number } | undefined;
  const room = dims?.maxHeight ?? dims?.height;
  // The head and the foot take about 230px; the pane gets the rest, within reason either way.
  if (typeof room === "number" && room > 0) state.paneHeight = Math.max(320, Math.min(720, room - 230));
  if (before.can !== state.canFullscreen || before.full !== state.fullscreen) return "redraw";
  return before.pane !== state.paneHeight ? "resize" : "none";
}

app.ontoolresult = (result) => {
  const docs = (result._meta?.[DOCS_KEY] ?? []) as PanelDocument[];
  state.reading = result._meta?.["zz-core/reading"] === true;
  state.received = true;
  state.slots = docs.map((doc) => {
    const view = renderMarkdown(doc.body);
    const cmp = doc.previous ? compareSections(view, renderMarkdown(doc.previous.body)) : null;
    const slot: Slot = { doc, view, shown: "pending" as Shown, approval: "idle" as Approval, scroll: 0,
      marks: cmp?.marks ?? new Map(), removed: cmp?.removed ?? [], onlyChanges: false,
      notes: [], sent: null, noting: null };
    loadNotes(slot);
    return slot;
  });
  show(0);
  schedule(1200);
};
app.onhostcontextchanged = (ctx) => {
  const change = hostSays(ctx);
  if (change === "redraw") draw();
  else if (change === "resize") root.querySelector<HTMLElement>(".panel")?.style.setProperty("--pane-h", `${state.paneHeight}px`);
};

draw();
await app.connect();
hostSays(app.getHostContext());
draw();
