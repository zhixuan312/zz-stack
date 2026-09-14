/**
 * The record an initiative is opened with, and the two questions asked of it.
 *
 * WHY THERE IS A RECORD AT ALL. `chainFor` resolves a flow from a document's envelope or from
 * the team's single install, and a flow-driven initiative is an EMPTY FOLDER for exactly as
 * long as it takes to write its first document. In that window there is no envelope to read,
 * and on a team running two flows there is no single install to fall back on — so the
 * initiative a person just opened WITH a flow reads back as governed by nothing. That window
 * is not an edge: it is when `initiative_status` gets called, because it is when an agent
 * picks the work up. The record closes it and does nothing else.
 *
 * WHAT IS *NOT* IN THE RECORD: whether the initiative was opened. That is the folder's own
 * existence, and there is deliberately no second source for it — a record that could disagree
 * with the filesystem is a record that eventually will, and the losing side would be the one
 * holding the documents. It also means no initiative written before this file existed is
 * retroactively unopened.
 *
 * Its own module rather than a corner of the tool that writes it, because three unrelated
 * places read it — `chain.ts` resolving a flow, `document_write` refusing an unopened name,
 * and the tool itself — and a tool importing another tool to reach a shared rule is how two
 * copies of that rule start.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isoToday } from "./write-guards.js";

/** The declaration, beside the documents rather than among them.
 *
 * Not exported: nothing outside this file names the record, which is what keeps the two
 * questions below the only way to ask about it.
 *
 * A leading underscore, because every listing on this platform filters those out —
 * `initiative_status`, `chainFor`'s oldest-document walk and `document_list` all skip
 * `_`-prefixed entries. A record listed as a document would be reported as one with no
 * status, no gate and no place in any chain. */
const OPEN_RECORD = "_open.json";

interface OpenRecord {
  initiative: string;
  /** The flow that governs this initiative, or null — which is a DECLARED freeform, not an
   * unanswered question. Telling those two apart is the only reason this file is written for
   * a freeform open as well. */
  flow: string | null;
  opened_by: string;
  opened_at: string;
}

/** The name the platform composes: today's date, from the platform's own clock, then the slug.
 *
 * THE DATE IS THE PLATFORM'S, NEVER THE AGENT'S, and document-rules.ts records what the other
 * way costs: an agent inferred "today" from the newest stored row plus the digits in a run tag
 * and named a folder no later stamp could repair. There is no argument for the date here and
 * no way to pass one — `isoToday()` is the same clock and the same timezone `envelopeFor`
 * stamps `updated_at` from, so a document's date and its folder's cannot disagree. */
export function initiativeNameFor(slug: string): string {
  return `${isoToday()}-${slug.trim()}`;
}

/** Write the declaration, creating the folder. */
export function recordOpen(root: string, name: string, flow: string | null, who: string): OpenRecord {
  const record: OpenRecord = {
    initiative: name,
    flow: flow?.trim() || null,
    opened_by: who,
    opened_at: isoToday(),
  };
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, OPEN_RECORD), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** The record, or null when there is none. Exported rather than a `declaredFlow(root, name)`
 * helper because the two facts it carries are NOT the same question: `flow: "sdlc-flow"` is a
 * declaration to resolve, and `flow: null` is a declaration that nothing governs this — which
 * a caller must be able to tell apart from "no record at all", or it cannot honour it.
 *
 * A malformed one is null rather than a throw. `initiative_status` is the one call
 * zz-backbone tells every agent to make before continuing any work, and taking it down over
 * an unparseable byte in a file the platform wrote is the failure mode `envelopeOf`'s isFile()
 * test already exists to prevent on the document beside it. */
export function openRecord(root: string, name: string): OpenRecord | null {
  const file = join(root, name, OPEN_RECORD);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as OpenRecord;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}


/** An initiative this slug would collide with, or null.
 *
 * THE SLUG IS WHAT IS TAKEN, NOT THE DATED NAME. Testing `<today>-<slug>` alone would let the
 * same work be opened again tomorrow under a second folder, and the two would then diverge
 * with no way to say which one anybody meant. `initiativeNameTaken` used to catch that on the
 * write path, in a form that could only see it once the first document had already been
 * composed and was about to be written into the wrong place.
 *
 * Anchored, so a slug that is a PREFIX of an existing one is free: `payment` is not taken by
 * `payment-retries`. */
export function takenRefusal(root: string, slug: string): string | null {
  const v = slug.trim();
  const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existing = (existsSync(root) ? readdirSync(root) : [])
    .filter((n) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escaped}$`).test(n))
    .sort();
  if (!existing.length) return null;
  return (
    `ERROR: "${v}" is already taken by ${existing.join(", ")}. Continue that one — ` +
    `initiative_status("${existing[0]}") says where it stands — or open this under a slug that ` +
    "says how it differs. Two initiatives with the same slug and different dates diverge, and " +
    "nothing downstream can say which one a person meant."
  );
}

/** The refusal for a path whose initiative nobody opened, or null.
 *
 * THE WRITE NO LONGER CREATES. Three guards used to make it safe that it did — the name
 * shape, the taken check and the flow declaration — and all three ran on every write of every
 * document, because this path could not tell a creating write from any other. `initiative_open`
 * is that moment now, so each asks its question once, before there is a folder, where the
 * answer can still be acted on. What is left is a single existence test.
 *
 * A path that is not an initiative document — a bare file at the root of the store — is not
 * this function's business and passes. */
export function unopenedRefusal(root: string, relPath: string): string | null {
  const parts = relPath.replace(/^\/+/, "").split("/");
  if (parts.length < 2 || !parts[0]) return null;
  if (existsSync(join(root, parts[0]))) return null;
  return (
    `ERROR: there is no initiative named "${parts[0]}" — writing into one no longer creates ` +
    "it. Open it first with `initiative_open(\"<slug>\")`: send the SLUG alone and use the " +
    "name it hands back, because the platform composes that name from its own clock. Pass " +
    "`flow` there if a flow governs this work; leaving it out is a choice the platform " +
    "supports, and documents, gates, approvals and closing all still work without one."
  );
}
