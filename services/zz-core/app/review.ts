/**
 * Reviewing with the agent, from inside the document.
 *
 * A person reviewing a long document with an agent goes round one loop: read, stop at something
 * unclear or wrong, hand it to the agent, see the revision, approve. The panel's part in that loop
 * is to make the hand-off exact. A selection turns the reading pane's foot into two acts —
 * **Explain**, which asks the agent about exactly that passage, and **Note a change**, which files
 * it in a basket of notes, each anchored to its passage and section. The basket goes to the agent
 * as one message, with the instruction to revise and present it in the panel's review context —
 * so the agent shows only what changed — and a review is one clear request rather than a stream
 * of vague ones.
 *
 * Notes are kept per public version of a document in the frame's own storage where the host allows it, so a
 * re-mounted panel still has them; a sandbox that refuses storage only loses them on reload.
 */
import { clip, schedule, selected } from "./context.ts";
import { esc } from "./facts.ts";
import { app, current, root, state, type Note, type Slot } from "./state.ts";

const QUOTE_MAX = 600;
const SEEN = "The assistant sees this passage — you can also just ask about it in the chat.";
const X = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

/** The selection toolbar: floating over the reading pane while a passage is held — which section,
 *  one line of the passage, and the two acts on it. Drawn from the held passage, so a redraw keeps
 *  it; filled in place when the reader selects, because redrawing would clear their selection. */
export const selbar = (): string => {
  const p = state.pick;
  return `<div class="selbar" role="toolbar" aria-label="Selected passage" ${p ? "" : "hidden"}>
    <div class="sel-text" title="${SEEN}">
      <p class="sel-eyebrow">Selected<span class="sel-where">${p?.section ? ` · ${esc(p.section)}` : ""}</span></p>
      <p class="sel-quote">${p ? `“${esc(clip(p.text, 200))}”` : ""}</p>
    </div>
    <div class="sel-acts">
      <button class="sel-btn sel-note" data-act="note-sel">Note a change</button>
      <button class="sel-btn sel-explain" data-act="explain">Explain</button>
      <span class="sel-rule" aria-hidden="true"></span>
      <button class="sel-close" data-act="close-pick" aria-label="Put the selection down">${X}</button>
    </div>
  </div>`;
};

/** Hold what the reader selects. A selection that goes away — a tap, a host redraw — leaves the
 *  passage held; only another selection replaces it, and only acting on it or ✕ lets it go. */
export function syncSelection(): void {
  const s = current();
  const read = root.querySelector<HTMLElement>(".read");
  const bar = root.querySelector<HTMLElement>(".selbar");
  if (!s || !read || !bar) return;
  const now = selected(s, read);
  if (!now) return;
  state.pick = now;
  bar.hidden = false;
  const where = bar.querySelector(".sel-where");
  if (where) where.textContent = now.section ? ` · ${now.section}` : "";
  const q = bar.querySelector(".sel-quote");
  if (q) q.textContent = `“${clip(now.text, 200)}”`;
  schedule(400);
}
/** Let the held passage go. */
export function dropPick(): void {
  state.pick = null;
  const bar = root.querySelector<HTMLElement>(".selbar");
  if (bar) bar.hidden = true;
  schedule(200);
}

const key = (s: Slot): string => `zz-panel-notes:${s.doc.path}:v${s.doc.version}`;
function keep(s: Slot): void {
  try { localStorage.setItem(key(s), JSON.stringify(s.notes)); } catch { /* the sandbox refuses storage */ }
}
export function loadNotes(s: Slot): void {
  try { s.notes = JSON.parse(localStorage.getItem(key(s)) ?? "[]") as Note[]; } catch { s.notes = []; }
}

/** Where an answer about a passage begins, in the conversation: ChatGPT shows a message the panel
 *  sends to the agent without showing it as the person's, so the answer appeared with no question
 *  above it and one explanation ran into the next. The reply opens on this line, and a rule. */
const heading = (text: string): string => {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  return `### Explaining: “${words.slice(0, 10).join(" ")}${words.length > 10 ? "…" : ""}”`;
};

/** Ask the agent about the selected passage, quoted, in the person's own voice. */
export async function explain(s: Slot): Promise<void> {
  const pick = state.pick;
  if (!pick) return;
  const where = pick.section ? `, in “${pick.section}”` : "";
  dropPick();
  document.getSelection()?.removeAllRanges();
  await app.sendMessage({ role: "user", content: [{ type: "text", text: [
    `Explain this passage from ${s.doc.path} (v${s.doc.version})${where}:`, "",
    `> ${clip(pick.text, QUOTE_MAX).replace(/\n/g, "\n> ")}`, "",
    "Begin your reply with exactly this line, then a horizontal rule (---), then the explanation:",
    heading(pick.text),
  ].join("\n") }] });
}

/** Open the note box, on the selected passage or on the document as a whole. */
export function startNote(s: Slot, fromSelection: boolean): void {
  const pick = fromSelection ? state.pick : null;
  s.noting = pick ? { quote: clip(pick.text, QUOTE_MAX), section: pick.section } : { quote: null, section: null };
  s.sent = null;
  if (pick) state.pick = null;
}
export function addNote(s: Slot, text: string): void {
  if (!s.noting || !text.trim()) return;
  s.notes.push({ quote: s.noting.quote, section: s.noting.section, text: text.trim() });
  s.noting = null;
  keep(s);
  schedule(200);
}
export function dropNote(s: Slot, i: number): void {
  s.notes.splice(i, 1);
  keep(s);
  schedule(200);
}

/** Every note, as one request the agent can act on: where, what the text says, what should change. */
export async function sendNotes(s: Slot): Promise<void> {
  if (!s.notes.length) return;
  const items = s.notes.map((n, i) => [
    `${i + 1}. ${n.section ? `In “${n.section}”` : "On the document as a whole"}:`,
    ...(n.quote ? [`   > ${n.quote.replace(/\n/g, "\n   > ")}`] : []),
    `   ${n.text}`,
  ].join("\n"));
  await app.sendMessage({ role: "user", content: [{ type: "text", text: [
    `Review notes on ${s.doc.path} (v${s.doc.version}), from the document panel:`, "", ...items, "",
    // The panel's own review context, named so the next present shows what changed since this one.
    s.doc.review_context
      ? `Change the document for these with document_edit, then call document_present on it with review_context ` +
        `"${s.doc.review_context}", so I am shown only what changed.`
      : "Change the document for these with document_edit, then call document_present on it, so I can see the result.",
  ].join("\n") }] });
  s.sent = `${s.notes.length} note${s.notes.length === 1 ? "" : "s"} sent — the assistant will revise and show it again, with what changed marked.`;
  s.notes = [];
  keep(s);
}

/** The basket, and the box a note is written in. */
export function notesBlock(s: Slot): string {
  const box = s.noting ? `<form class="ask" data-act="add-note">
      ${s.noting.quote ? `<p class="note-quote">${s.noting.section ? `${esc(s.noting.section)} · ` : ""}“${esc(clip(s.noting.quote, 200))}”</p>` : ""}
      <label class="sr-only" for="note">What should change</label>
      <textarea id="note" rows="3" placeholder="${s.noting.quote ? "What should change here?" : "What should change in this document?"}" required></textarea>
      <div class="row"><button type="button" class="btn btn-quiet" data-act="cancel-note">Cancel</button>
      <button type="submit" class="btn btn-primary">Add note</button></div>
    </form>` : "";
  const list = s.notes.length ? `<ol class="notes">${s.notes.map((n, i) => `<li>
      <p class="note-where">${n.section ? esc(n.section) : "Whole document"}</p>
      ${n.quote ? `<p class="note-quote">“${esc(clip(n.quote, 140))}”</p>` : ""}
      <p class="note-text">${esc(n.text)}</p>
      <button class="note-drop" data-act="drop-note" data-i="${i}" aria-label="Remove this note">Remove</button>
    </li>`).join("")}</ol>` : "";
  return list + box;
}
