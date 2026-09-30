/**
 * What the model is told about the reader, through the host (`ui/update-model-context`).
 *
 * The panel lives in a conversation with an agent, and the person talks to that agent about what
 * is in front of them: "what does this mean", "why this and not that", "is this section right". So
 * the agent has to know what the person sees. The host keeps the latest update and attaches it to
 * the person's next message, and each update replaces the last — so this describes the moment:
 * where they are, how far through, the passage on their screen, what they selected, what changed
 * since the version before, and the notes they have not sent yet. Composed when the reader
 * settles, never per scroll event.
 */
import { app, current, root, type Slot } from "./state.ts";
import type { Rendered } from "./render.ts";

type Heading = Rendered["outline"][number];
let position: { here?: Heading; top2?: Heading; share: number } = { share: 0 };
let told = "";
let telling: ReturnType<typeof setTimeout> | undefined;
const PASSAGE_MAX = 2500;
const SELECTION_MAX = 1500;
export const clip = (t: string, max: number): string => (t.length > max ? `${t.slice(0, max)}…` : t);

/** Where the reader is now; the model is told once they settle. */
export function tellModel(here: Heading | undefined, top2: Heading | undefined, share: number): void {
  position = { here, top2, share };
  schedule(1000);
}
export function schedule(wait: number): void {
  if (!app.getHostCapabilities()?.updateModelContext) return;
  clearTimeout(telling);
  telling = setTimeout(compose, wait);
}

/** The blocks of the document the reader can see right now, between the bar and the pane's foot. */
function onScreen(read: HTMLElement): string {
  const barBottom = read.querySelector(".bar")?.getBoundingClientRect().bottom ?? read.getBoundingClientRect().top;
  const foot = read.getBoundingClientRect().bottom;
  const seen: string[] = [];
  for (const el of read.querySelectorAll<HTMLElement>("article > :not(section), article > section > *")) {
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.bottom <= barBottom || r.top >= foot) continue;
    seen.push(el.innerText.trim());
  }
  return clip(seen.filter(Boolean).join("\n\n"), PASSAGE_MAX);
}

/** The section heading a node sits under, by the document's own outline. */
export function sectionOf(s: Slot, read: HTMLElement, node: Node): string | null {
  let section: string | null = null;
  for (const o of s.view.outline) {
    const h = read.querySelector(`[id="${CSS.escape(o.id)}"]`);
    if (h && h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) section = o.text; else if (h) break;
  }
  return section;
}

/** What the reader has selected inside the document, and the section it sits in. */
export function selected(s: Slot, read: HTMLElement): { text: string; section: string | null } | null {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode || !read.contains(sel.anchorNode)) return null;
  const text = sel.toString().trim();
  return text ? { text: clip(text, SELECTION_MAX), section: sectionOf(s, read, sel.anchorNode) } : null;
}

const titleOf = (s: Slot, id: string): string => s.view.sections.find((x) => x.id === id)?.title ?? id;

function compose(): void {
  const s = current();
  const read = root.querySelector<HTMLElement>(".read");
  if (!s || !read) return;
  const { here, top2, share } = position;
  const passage = onScreen(read);
  const pick = selected(s, read);
  const key = `${s.doc.path}|${here?.id ?? ""}|${passage.slice(0, 160)}|${pick?.text ?? ""}|${s.notes.length}`;
  if (key === told) return;
  told = key;
  const at = here ? s.view.outline.indexOf(here) : -1;
  const passed = s.view.outline.slice(0, Math.max(0, at)).filter((o) => o.level === 2).map((o) => o.text);
  const where = top2 ? `"${top2.text}"${here && here !== top2 ? ` › "${here.text}"` : ""}` : "the opening, before the first section";
  const lines = [
    `The person is reading ${s.doc.path} (v${s.doc.version}) in the document panel, which shows them all of it.`,
    `They are at ${where} — ${Math.round(share * 100)}% through, about ${Math.max(1, Math.round((1 - share) * s.view.words / 220))} min left.`,
    !passed.length ? "They have not yet passed a section."
      : passed.length <= 12 ? `Sections they have scrolled past: ${passed.join("; ")}.`
      : `They have scrolled past ${passed.length} sections, most recently: ${passed.slice(-8).join("; ")}.`,
    "Scrolled past is not the same as read carefully.",
  ];
  if (s.doc.previous && (s.marks.size || s.removed.length)) {
    const of = (kind: "changed" | "new") => [...s.marks].filter(([, m]) => m === kind).map(([id]) => titleOf(s, id));
    lines.push(`Since v${s.doc.previous.version}: changed — ${of("changed").join("; ") || "none"}; new — ${of("new").join("; ") || "none"}` +
               `${s.removed.length ? `; removed — ${s.removed.join("; ")}` : ""}. The panel marks these for them.`);
  }
  if (s.notes.length) lines.push(`They have ${s.notes.length} review note(s) drafted in the panel, not sent yet.`);
  if (pick) {
    lines.push("", `They have SELECTED this passage${pick.section ? ` (in "${pick.section}")` : ""}. When they ask about "this" ` +
               `or "here", they mean it:`, pick.text);
  }
  if (passage) {
    lines.push("", `On their screen right now${pick ? "" : ` — when they ask about "this" without saying what, it is here`}:`, passage);
  }
  lines.push("", "Do not page the document into the conversation for them; it is in front of them.");
  void app.updateModelContext({ content: [{ type: "text", text: lines.join("\n") }] }).catch(() => { told = ""; });
}
