/**
 * The document panel, in the page a client renders beside `document_present`'s result.
 *
 * What it does, in order: take the documents `document_present` put in its result's `_meta`,
 * draw the active one whole, tell the platform it did (`document_shown`, with the ticket that came
 * with it), and — where the document gates and this is its current revision — offer the approval,
 * through the same `document_approve` a model would call. After an approval, or a request for
 * changes, the conversation is told in the person's own voice, because the flow continues there.
 *
 * Built for the documents this platform actually holds, which run to an hour of reading. A reader
 * keeps going when they always know three things: where they are, how much is left, and how to get
 * to the part that matters. So the reading pane carries a sticky bar naming the section they are in,
 * with the share read and the minutes left; the section name opens a jump list with each section's
 * own length; a wide panel keeps that list open as a rail that follows the reading; and each
 * document keeps its place across a tab or a mode switch. Layout follows the panel's own width
 * (container queries), not the window's, because the same page is framed in a chat column, full
 * screen and on a phone.
 *
 * One theme and one register, the console's: cream ground, hairlines not shadows, one accent for
 * the one primary action, green/amber/red for approved/waiting/refused and nothing else. The
 * `state-approved` mascot appears for its one job, an approval that just succeeded.
 */
import { App } from "@modelcontextprotocol/ext-apps";

import { minutesOf, renderMarkdown, type Rendered } from "./render.ts";
import approvedArt from "./brand/state-approved.png";
import wordmark from "./brand/wordmark.png";

/** What `document_present` hands over. COUPLED: `PanelDocument` in src/document-panel.ts. */
interface PanelDocument {
  path: string; initiative: string; name: string;
  version: number; current: number | null;
  status: string | null; approvedBy: string | null; approvedAt: string | null;
  gate: string | null;
  history: { version: number; approvedBy: string | null; approvedAt: string | null }[];
  body: string; ticket: string | null;
}
type Shown = "pending" | "recorded" | { failed: string };
type Approval = "idle" | "busy" | "done" | { failed: string };
interface Slot { doc: PanelDocument; view: Rendered; shown: Shown; approval: Approval; asking: boolean; scroll: number }

const DOCS_KEY = "zz-core/documents";
/** Past this many words a document is one a person should be offered the whole screen for. */
const LONG_WORDS = 2000;
const root = document.getElementById("panel") as HTMLElement;
let slots: Slot[] = [];
/** Whether the result has arrived. Before it does, the page is a skeleton, not "nothing". */
let received = false;
let active = 0;
let fullscreen = false;
let canFullscreen = false;
/** The inline reading pane's height: what the host says it can give, less the head and the foot. */
let paneHeight = 600;
let jumpOpen = false;

/** The platform version this page was built at, put in by the build. */
declare const PANEL_VERSION: string;
const app = new App({ name: "zz-document-panel", version: PANEL_VERSION }, {}, { autoResize: true });

/** Escape text for an HTML context. Everything a person or a document supplies goes through here,
 *  except the body, which `renderMarkdown` has already made safe. */
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c] ?? c);

/** A tool result's text, and whether the platform refused. Every refusal on this platform starts
 *  with `ERROR`; anything else is an answer. */
function answer(result: { content?: { type: string; text?: string }[]; isError?: boolean }): { ok: boolean; said: string } {
  const said = (result.content ?? []).map((c) => c.text ?? "").join("\n").trim();
  return { ok: !result.isError && !/^ERROR\b/.test(said), said: said.replace(/^ERROR:\s*/, "") };
}

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
  if (d.version !== d.current) return { label: "Earlier version", tone: "neutral" };
  if (s.approval === "done" || d.status === "approved") return { label: "Approved", tone: "green" };
  if (d.gate) return { label: "Written", tone: "neutral" };
  return { label: "Awaiting approval", tone: "amber" };
}

function header(s: Slot): string {
  const d = s.doc;
  const pill = standing(s);
  const title = s.view.title ?? humanName(d.name);
  const sections = s.view.outline.filter((o) => o.level === 2).length;
  // The file's name, unless the tabs below already say it.
  const facts = [...(slots.length > 1 ? [] : [`<span class="mono chip">${esc(d.name)}</span>`]),
                 `v${d.version}`, `${minutesOf(s.view.words)} min read`];
  if (sections) facts.push(`${sections} section${sections === 1 ? "" : "s"}`);
  const tabs = slots.length > 1
    ? `<nav class="tabs" aria-label="Documents">${slots.map((t, i) =>
        `<button class="tab" data-tab="${i}" aria-current="${i === active}">${esc(t.doc.name)}</button>`).join("")}</nav>`
    : "";
  // One control for the screen: a long document is offered the whole of it in words; leaving it
  // is always offered.
  const mode = !canFullscreen ? ""
    : fullscreen ? `<button class="btn-link" data-act="mode">Exit full screen</button>`
    : s.view.words > LONG_WORDS ? `<button class="btn-link" data-act="mode">Read full screen</button>`
    : `<button class="icon-btn" data-act="mode" aria-label="Read full screen" title="Read full screen">↗</button>`;
  return `<header class="head">
    <div class="eyebrow"><img class="wordmark" src="${wordmark}" alt="" /><span>${esc(d.initiative)}</span>${mode}</div>
    <div class="title-row"><h1 class="title">${esc(title)}</h1><span class="pill pill-${pill.tone}">${pill.label}</span></div>
    <p class="facts">${facts.join('<span class="sep">·</span>')}</p>
    ${tabs}
  </header>`;
}

/** The sections, each with its own length: the rail on a wide panel, the jump list on any. */
function sectionList(s: Slot, cls: string): string {
  return s.view.outline.map((o) =>
    `<a class="${cls}-${o.level}" href="#${o.id}" data-section="${o.id}"><span>${esc(o.text)}</span>` +
    (o.level === 2 ? `<span class="mins">${minutesOf(o.words)} min</span>` : "") + `</a>`).join("");
}

/** The reading pane's own head: which section this is, how far through, and the way to the others. */
function bar(s: Slot): string {
  const listed = s.view.outline.length > 1;
  return `<div class="bar">
    ${listed ? `<button class="bar-section" data-act="jump" aria-expanded="${jumpOpen}" aria-controls="jump">
      <span class="bar-label">Beginning</span><span class="caret" aria-hidden="true">▾</span></button>`
      : `<span class="bar-section"><span class="bar-label">${esc(s.view.title ?? humanName(s.doc.name))}</span></span>`}
    <span class="bar-meta" aria-live="off"></span>
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
  if (d.version !== d.current) {
    return `<footer class="foot"><p class="note">This is version ${d.version}. Only the current version, v${d.current ?? "?"}, can be approved.</p></footer>`;
  }
  if (s.approval === "done") {
    return `<footer class="foot foot-done" role="status">
      <img class="mascot" src="${approvedArt}" alt="" />
      <div><p class="done-title">Approved</p><p class="note">v${d.version} carries your signature. The conversation has been told.</p></div>
    </footer>`;
  }
  if (d.status === "approved") {
    return `<footer class="foot"><p class="note"><span class="dot dot-green"></span>Approved${who}${d.approvedAt ? ` on ${esc(day(d.approvedAt))}` : ""}.</p></footer>`;
  }
  const shown = s.shown === "recorded"
    ? `<span class="dot dot-green"></span>Shown to you in full`
    : s.shown === "pending" ? `<span class="dot"></span>Recording that you have it in front of you…`
    : `<span class="dot dot-red"></span>${esc(s.shown.failed)}`;
  if (d.gate) return `<footer class="foot"><p class="note" role="status">${shown}</p><p class="note">No approval: this document carries no gate.</p></footer>`;
  const failed = typeof s.approval === "object" ? `<p class="error" role="alert">${esc(s.approval.failed)}</p>` : "";
  const busy = s.approval === "busy";
  const ask = s.asking
    ? `<form class="ask" data-act="send-changes">
         <label class="sr-only" for="changes">What should change</label>
         <textarea id="changes" rows="3" placeholder="What should change before you approve it?" required></textarea>
         <div class="row"><button type="button" class="btn btn-quiet" data-act="cancel-changes">Cancel</button>
         <button type="submit" class="btn btn-primary">Send to the conversation</button></div>
       </form>`
    : "";
  return `<footer class="foot">
    <p class="note" role="status">${shown}</p>
    ${failed}
    ${ask}
    ${s.asking ? "" : `<div class="row">
      <button class="btn btn-quiet" data-act="ask-changes" ${busy ? "disabled" : ""}>Ask for changes</button>
      <button class="btn btn-primary" data-act="sign" ${busy || s.shown !== "recorded" ? "disabled" : ""}>
        ${busy ? "Approving…" : `Approve v${d.version}`}</button></div>`}
  </footer>`;
}

function draw(): void {
  const s = slots[active];
  if (!received) {
    root.innerHTML = `<div class="panel" aria-busy="true"><div class="head"><div class="sk sk-line"></div>
      <div class="sk sk-title"></div></div><div class="body"><div class="read">
      <div class="sk sk-line"></div><div class="sk sk-line"></div><div class="sk sk-short"></div></div></div></div>`;
    return;
  }
  if (!s) {
    root.innerHTML = `<div class="panel"><p class="empty">document_present returned no document to show.</p></div>`;
    return;
  }
  const rail = s.view.outline.length > 1
    ? `<nav class="rail" aria-label="Sections"><p class="eyebrow-text">In this document</p>${sectionList(s, "rl")}</nav>` : "";
  root.innerHTML = `<div class="panel ${fullscreen ? "is-full" : ""}" style="--pane-h:${paneHeight}px">
    ${header(s)}
    <div class="body">${rail}<div class="read" tabindex="0">${bar(s)}
      <article class="prose">${withoutTitle(s)}</article></div></div>
    ${footer(s)}
  </div>`;
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
    const s = slots[active];
    const read = root.querySelector<HTMLElement>(".read");
    if (!s || !read) return;
    const barH = read.querySelector<HTMLElement>(".bar")?.offsetHeight ?? 0;
    const span = read.scrollHeight - read.clientHeight;
    const share = span > 0 ? Math.min(1, read.scrollTop / span) : 1;
    let here: (typeof s.view.outline)[number] | undefined;
    for (const o of s.view.outline) {
      const el = read.querySelector<HTMLElement>(`[id="${CSS.escape(o.id)}"]`);
      if (el && el.offsetTop <= read.scrollTop + barH + 12) here = o; else if (el) break;
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
  });
}

/** Scroll the reading pane to a heading, below the sticky bar rather than under it. */
function goTo(id: string): void {
  const read = root.querySelector<HTMLElement>(".read");
  const el = read?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
  if (!read || !el) return;
  const barH = read.querySelector<HTMLElement>(".bar")?.offsetHeight ?? 0;
  const top = el.offsetTop - barH - 8;
  // A short hop glides, so the reader sees where they went; a long one lands at once — twenty
  // screens of text streaming past is disorienting, and slow.
  read.scrollTo({ top, behavior: Math.abs(top - read.scrollTop) > 2 * read.clientHeight ? "instant" : "smooth" });
}

/** Record the active document as shown, once it is on screen. Nothing records for history, for a
 *  document with no ticket, or twice. */
async function recordShown(s: Slot): Promise<void> {
  if (s.shown !== "pending") return;
  if (!s.doc.ticket || s.doc.version !== s.doc.current) { s.shown = "recorded"; draw(); return; }
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
  active = i;
  jumpOpen = false;
  draw();
  requestAnimationFrame(() => void recordShown(slots[active]!));
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

root.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act], [data-tab], a[href]");
  if (!el) { if (jumpOpen) setJump(false); return; }
  const s = slots[active];
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
    case "ask-changes": s.asking = true; draw(); root.querySelector("textarea")?.focus(); break;
    case "cancel-changes": s.asking = false; draw(); break;
    case "mode":
      void app.requestDisplayMode({ mode: fullscreen ? "inline" : "fullscreen" })
        .then((r) => { fullscreen = r.mode === "fullscreen"; draw(); });
      break;
  }
});
root.addEventListener("keydown", (e) => { if (e.key === "Escape" && jumpOpen) setJump(false); });
root.addEventListener("submit", (e) => {
  e.preventDefault();
  const s = slots[active];
  const note = root.querySelector("textarea")?.value.trim();
  if (!s || !note) return;
  s.asking = false;
  draw();
  void app.sendMessage({ role: "user", content: [{ type: "text",
    text: `Changes requested on ${s.doc.path} (v${s.doc.version}), from the document panel:\n\n${note}` }] });
});

/** Take what the host says about the space and the modes it offers. */
function hostSays(ctx: ReturnType<typeof app.getHostContext>): void {
  if (!ctx) return;
  if (ctx.availableDisplayModes) canFullscreen = ctx.availableDisplayModes.includes("fullscreen");
  if (ctx.displayMode) fullscreen = ctx.displayMode === "fullscreen";
  const dims = ctx.containerDimensions as { maxHeight?: number; height?: number } | undefined;
  const room = dims?.maxHeight ?? dims?.height;
  // The head and the foot take about 230px; the pane gets the rest, within reason either way.
  if (typeof room === "number" && room > 0) paneHeight = Math.max(320, Math.min(720, room - 230));
}

app.ontoolresult = (result) => {
  const docs = (result._meta?.[DOCS_KEY] ?? []) as PanelDocument[];
  received = true;
  slots = docs.map((doc) => ({ doc, view: renderMarkdown(doc.body), shown: "pending" as Shown,
                               approval: "idle" as Approval, asking: false, scroll: 0 }));
  show(0);
};
app.onhostcontextchanged = (ctx) => { hostSays(ctx); draw(); };

draw();
await app.connect();
hostSays(app.getHostContext());
draw();
