/**
 * What the panel says about a document beside its body — where it stands, and the versions it has
 * been through: pure, no DOM, so a check can run it in Node.
 */
import type { Approval, PanelDocument } from "./state.ts";

/** Escape text for an HTML context. Everything a person or a document supplies goes through here,
 *  except the body, which `renderMarkdown` has already made safe. */
export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c] ?? c);

/** A platform day (`YYYY-MM-DD`, `dayOf` in src/versions.ts) as the reader's locale writes it; what
 *  the store said when it is no date. Read in UTC because that is how a bare date parses: in the
 *  reader's own zone, a reader west of UTC would read every approval a day early.
 *
 *  DELIBERATE: every date the panel draws is sent as the platform's day, never an instant, so the
 *  header and the history say one day for one approval whatever zone the reader is in. */
export const day = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

/** What the header's pill says, and in which of the three reserved tones. A closed initiative's
 *  correction says both halves: the close stands, and this version waits on its own approval. */
export function standing(d: Pick<PanelDocument, "latest" | "status" | "gate" | "correction">, approval: Approval):
    { label: string; tone: "green" | "amber" | "neutral" } {
  if (!d.latest) return { label: "Earlier version", tone: "neutral" };
  if (approval === "done" || d.status === "approved") return { label: "Approved", tone: "green" };
  if (d.gate) return { label: "Written", tone: "neutral" };
  if (d.correction) return { label: "Closed · correction awaiting approval", tone: "amber" };
  return { label: "Awaiting approval", tone: "amber" };
}

/** Every public version, oldest first: who approved it and when, or that it was filed unsigned —
 *  and, under a version read as a later unsigned row, the approved snapshot that row superseded,
 *  named by the `content_revision` that reads it. The version drawn is marked; `open` is the state
 *  the reader left the list in, which a redraw keeps.
 *
 *  COUPLED: `versionsLine` in src/document-present.ts and the console's version history say the
 *  same per version, by the same rule (`supersededApproval`). */
export function versionHistory(d: Pick<PanelDocument, "version" | "history">, open = false): string {
  if (!d.history.length) return "";
  const by = (who: string, at: string | null) => `by ${esc(who)}${at ? ` on ${esc(day(at))}` : ""}`;
  const items = d.history.map((h) => {
    const what = h.approvedBy ? `Approved ${by(h.approvedBy, h.approvedAt)}` : "Filed, not approved";
    const s = h.superseded;
    const sealed = !s ? ""
      : `<span class="v-sealed">${s.content_revision
          ? `Approved snapshot <code class="mono">${esc(s.content_revision)}</code>` : "An approved snapshot, with no content revision retained,"} ` +
        `${by(s.approvedBy, s.approvedAt)} superseded inside it</span>`;
    return `<li${h.version === d.version ? ' aria-current="true"' : ""}><span class="v-num">v${h.version}</span>` +
      `<span class="v-what">${what}${sealed}</span></li>`;
  });
  return `<details class="versions"${open ? " open" : ""}><summary>${d.history.length} version${d.history.length === 1 ? "" : "s"}</summary>` +
    `<ol>${items.join("")}</ol></details>`;
}
