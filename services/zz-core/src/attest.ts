/** Facts about the record that a SCRIPT decides, so no model has to.
 *
 * A skill is prose, and prose read by a model is not deterministic: it can be followed,
 * half-followed, or reasoned around, and nothing downstream can tell which happened. So
 * anything that can be settled by running a function is settled here instead, and the tool
 * reports the answer. The model chooses WHICH function to call; it does not re-derive what
 * the function knows.
 *
 * This module holds no policy. It answers questions; `server.ts` decides what to say about
 * the answers, and nothing here refuses anything.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Actions that change a document's bytes. A `shown` after one of these is a fetch of the
 * current content; a `shown` before them is a fetch of something else. */
const CHANGED = new Set(["document_write", "document_patch", "document_revise"]);

/** Was this document FETCHED BACK since the last time its content changed?
 *
 * `zz-backbone` asks for `document_present` before a gate: a person approves bytes, and the
 * fetch is the only part of "I put it in front of them" the platform can see. It also says,
 * in as many words, that no approval is refused over it — the record makes the gap visible
 * and does not close it. That stays true: this returns a fact, `document_approve` reports the fact,
 * and nothing here refuses.
 *
 * SINCE THE LAST CONTENT CHANGE, not "at this version". A `document_patch` does not bump
 * `version`, so a document can be shown at v1, patched eight times and approved while the
 * log still reads "shown v1" — version-matching would call that fetched. Filling a scaffold
 * is exactly that shape, so version-matching would have been silent on the common case and
 * loud on nothing.
 *
 * Returns null when the question cannot be answered — no log, unreadable, or no recorded
 * change to be "since". A warning invented from a missing record is worse than no warning:
 * it teaches the reader that this line does not mean anything.
 */
export function shownSinceLastChange(root: string, relPath: string): boolean | null {
  try {
    const parts = relPath.replace(/^\/+/, "").split("/");
    if (parts.length !== 2) return null;
    const log = join(root, parts[0], "activity.jsonl");
    if (!existsSync(log)) return null;
    let lastChange = -1;
    let lastShown = -1;
    let i = 0;
    for (const line of readFileSync(log, "utf8").split("\n")) {
      if (!line.trim()) continue;
      i += 1;
      let e: { action?: string; path?: string };
      try {
        e = JSON.parse(line) as { action?: string; path?: string };
      } catch {
        continue;
      }
      if (e.path !== relPath) continue;
      if (CHANGED.has(e.action ?? "")) lastChange = i;
      else if (e.action === "shown") lastShown = i;
    }
    if (lastChange < 0) return null;
    return lastShown > lastChange;
  } catch {
    return null;
  }
}
