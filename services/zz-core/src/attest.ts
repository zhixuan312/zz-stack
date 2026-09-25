/** Facts about the record that a script decides, so no model has to.
 *
 * A skill is prose, and prose read by a model can be followed, half-followed or reasoned
 * around with nothing downstream able to tell which. Anything settleable by running a function
 * is settled here, and the tool reports the answer. The model chooses which function to call.
 *
 * This module holds no policy: it answers questions, `server.ts` decides what to say about the
 * answers, and nothing here refuses anything.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Actions that change a document's bytes. A `shown` after one of these is a fetch of the
 * current content; a `shown` before them is a fetch of something else. */
const CHANGED = new Set(["document_write", "document_patch", "document_revise"]);

/** Was this document fetched back since the last time its content changed?
 *
 * Returns a fact; `document_approve` refuses on `false` — "present it first" — and approves on
 * `true` or `null`.
 *
 * Since the last content change, not "at this version". A `document_patch` does not bump
 * `version`, so a document can be shown at v1, patched eight times and approved while the log
 * still reads "shown v1", which version-matching would call fetched. Filling a scaffold is
 * exactly that shape.
 *
 * Returns null when the question cannot be answered — no log, unreadable, or no recorded
 * change to be "since". A warning invented from a missing record teaches the reader that this
 * line does not mean anything.
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
