/**
 * What every part of the document panel shares: the documents it was handed, which one is open,
 * the host connection, and the two helpers everything that writes HTML or reads a tool result uses.
 */
import { App } from "@modelcontextprotocol/ext-apps";

import type { Rendered } from "./render.ts";

/** One record of the change set from the review context's baseline. COUPLED: `deltaOf`'s records in
 *  src/document-delta.ts; positions count, from 1, the headings its line scan finds (`heads`). */
export type Change =
  | { kind: "added" | "edited"; heading: string; at: number }
  | { kind: "removed"; heading: string; from: number; lines: number; chars: number }
  | { kind: "renamed"; from: string; to: string; at: number }
  | { kind: "moved"; heading: string; from: number; to: number }
  | { kind: "preamble"; was: unknown; now: unknown }
  | { kind: "trailing"; was: string; now: string }
  | { kind: "metadata"; field: string; was: string; now: string };

/** What `document_present` hands over. COUPLED: `PanelDocument` in src/document-panel.ts. */
export interface PanelDocument {
  path: string; initiative: string; name: string;
  version: number; current: number | null; latest: boolean;
  status: string | null; approvedBy: string | null; approvedAt: string | null;
  gate: string | null;
  history: { version: number; approvedBy: string | null; approvedAt: string | null;
             superseded: { approvedBy: string; approvedAt: string | null; content_revision: string | null } | null }[];
  body: string;
  /** The review metadata an approval signs with the body. */
  metadata: { title: string; tags: string[]; stakeholder: string; fields: Record<string, string> };
  content_revision: string | null;
  review_context: string | null;
  /** The review context's baseline and the change set from it; `changes` null when it is as long as the document. */
  previous: { version: number; content_revision: string; changes: Change[] | null } | null;
  ticket: string | null;
}
/** A change the reader wants, anchored to what they selected when there was a selection. */
export interface Note { quote: string | null; section: string | null; text: string }
export type Shown = "pending" | "recorded" | { failed: string };
export type Approval = "idle" | "busy" | "done" | { failed: string };
export interface Slot {
  doc: PanelDocument;
  view: Rendered;
  shown: Shown;
  approval: Approval;
  /** Where the reader was, so a redraw or a tab switch keeps their place. */
  scroll: number;
  /** Sections that differ from the context's baseline, by heading id; `removed` by heading; `other`
   *  names what changed outside the sections — the opening, the trailing text, a metadata field. */
  marks: Map<string, "changed" | "new">;
  removed: string[];
  other: string[];
  onlyChanges: boolean;
  notes: Note[];
  /** What the footer says about the notes just sent, until the next act. */
  sent: string | null;
  /** The footer's note box: closed, or open for a note with or without a passage. */
  noting: { quote: string | null; section: string | null } | null;
}

export const state = {
  slots: [] as Slot[],
  active: 0,
  /** Whether the result has arrived. Before it does, the page is a skeleton, not "nothing". */
  received: false,
  /** Whether this result is a part the assistant read for itself — nothing to draw for a person. */
  reading: false,
  fullscreen: false,
  canFullscreen: false,
  /** The inline reading pane's height: what the host says it can give, less the head and the foot. */
  paneHeight: 600,
  /** The passage the reader last selected, held until they act on it, close it or select another.
   *  Held rather than read live: on a touchscreen, tapping a button clears the selection before the
   *  tap lands, and a host redraw clears it too — a bar that followed the live selection vanished
   *  under the reader's finger (0.92.3, on a phone). */
  pick: null as { text: string; section: string | null } | null,
};
export const current = (): Slot | undefined => state.slots[state.active];

export const root = document.getElementById("panel") as HTMLElement;

/** The platform version this page was built at, put in by the build. */
declare const PANEL_VERSION: string;
export const app = new App({ name: "zz-document-panel", version: PANEL_VERSION }, {}, { autoResize: true });

/** Escape text for an HTML context. Everything a person or a document supplies goes through here,
 *  except the body, which `renderMarkdown` has already made safe. */
export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c] ?? c);

/** A tool result's text, and whether the platform refused. Every refusal on this platform starts
 *  with `ERROR`; anything else is an answer. */
export function answer(result: { content?: { type: string; text?: string }[]; isError?: boolean }): { ok: boolean; said: string } {
  const said = (result.content ?? []).map((c) => c.text ?? "").join("\n").trim();
  return { ok: !result.isError && !/^ERROR\b/.test(said), said: said.replace(/^ERROR:\s*/, "") };
}
