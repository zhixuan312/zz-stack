/**
 * Reviewing with the agent, from inside the document.
 *
 * A person reviewing a long document with an agent goes round one loop: read, stop at something
 * unclear or wrong, hand it to the agent, see the revision, approve. The panel's part in that loop
 * is to make the hand-off exact. A selection turns the reading pane's foot into two acts —
 * **Explain**, which asks the agent about exactly that passage, and **Note a change**, which files
 * it in a basket of notes, each anchored to its passage and section. The basket goes to the agent
 * as one message, with the instruction to revise and present again, so a review is one clear
 * request rather than a stream of vague ones.
 *
 * Notes are kept per document revision in the frame's own storage where the host allows it, so a
 * re-mounted panel still has them; a sandbox that refuses storage only loses them on reload.
 */
import { clip, schedule, selected } from "./context.ts";
import { app, current, esc, root, type Note, type Slot } from "./state.ts";

const QUOTE_MAX = 600;
let pick: { text: string; section: string | null } | null = null;

/** The reading pane's foot while something is selected. Built once; shown and filled in place,
 *  because redrawing the page would clear the very selection it acts on. */
export const selbar = (): string =>
  `<div class="selbar" hidden>
    <p class="sel-quote"></p>
    <div class="row">
      <button class="btn btn-quiet" data-act="note-sel">Note a change</button>
      <button class="btn btn-primary" data-act="explain">Explain this</button>
    </div>
    <p class="sel-hint">Or ask anything in the chat — the assistant sees what you selected.</p>
  </div>`;

/** Follow the selection: show the bar with the passage while there is one, hide it when not. */
export function syncSelection(): void {
  const s = current();
  const read = root.querySelector<HTMLElement>(".read");
  const bar = root.querySelector<HTMLElement>(".selbar");
  if (!s || !read || !bar) return;
  pick = selected(s, read);
  bar.hidden = !pick;
  const q = bar.querySelector(".sel-quote");
  if (q && pick) q.textContent = `${pick.section ? `${pick.section} · ` : ""}“${clip(pick.text, 160)}”`;
  schedule(400);
}

const key = (s: Slot): string => `zz-panel-notes:${s.doc.path}:v${s.doc.version}`;
function keep(s: Slot): void {
  try { localStorage.setItem(key(s), JSON.stringify(s.notes)); } catch { /* the sandbox refuses storage */ }
}
export function loadNotes(s: Slot): void {
  try { s.notes = JSON.parse(localStorage.getItem(key(s)) ?? "[]") as Note[]; } catch { s.notes = []; }
}

/** Ask the agent about the selected passage, quoted, in the person's own voice. */
export async function explain(s: Slot): Promise<void> {
  if (!pick) return;
  const where = pick.section ? `, in “${pick.section}”` : "";
  await app.sendMessage({ role: "user", content: [{ type: "text",
    text: `Explain this passage from ${s.doc.path} (v${s.doc.version})${where}:\n\n> ${clip(pick.text, QUOTE_MAX).replace(/\n/g, "\n> ")}` }] });
  document.getSelection()?.removeAllRanges();
}

/** Open the note box, on the selected passage or on the document as a whole. */
export function startNote(s: Slot, fromSelection: boolean): void {
  s.noting = fromSelection && pick ? { quote: clip(pick.text, QUOTE_MAX), section: pick.section } : { quote: null, section: null };
  s.sent = null;
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
    "Revise the document for these with document_revise, then present it again so I can see what changed.",
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
