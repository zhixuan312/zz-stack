/**
 * The record an initiative is opened with, and the two questions asked of it.
 *
 * `chainFor` resolves a flow from a document's envelope, and an initiative is an empty folder
 * until its first document is written. In that window there is no envelope to read, so without
 * this record an initiative opened with a flow reads back as governed by nothing — which is
 * exactly when `initiative_status` is called.
 *
 * DELIBERATE: the record does not say whether the initiative was opened. That is the folder's
 * own existence, and a second source for it would eventually disagree with the filesystem.
 *
 * COUPLED: read by chain.ts resolving a flow, by document_write refusing an unopened name,
 * and by initiative_open itself — hence its own module rather than a corner of the tool.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isoToday } from "./write-guards.js";

/** The declaration, beside the documents rather than among them.
 *
 * Exported so `initiative_open` can log its event against this path and land the line in the
 * initiative's own activity log rather than the team-wide one.
 *
 * COUPLED: the leading underscore is what keeps it out of every listing — initiative_status,
 * chainFor's oldest-document walk and document_list all skip `_`-prefixed entries. */
export const OPEN_RECORD = "_open.json";

interface OpenRecord {
  initiative: string;
  /** Set only when an initiative holding no document was abandoned — see recordAbandoned.
   *  Its presence is what `initiative_status` reads to stop offering a next move. */
  abandoned_by?: string;
  abandoned_at?: string;
  /** The flow that governs this initiative, or null, which is a declared freeform rather than
   * an unanswered question. Telling the two apart is why this file is written for a freeform
   * open as well. */
  flow: string | null;
  /** How much of the flow's review this initiative runs: `full`, or `light` for one bounded
   *  change a reviewer can verify from the diff. Declared at the open, like the flow, and
   *  absent on a freeform initiative. `audit-rounds.ts` reads it. */
  track?: "full" | "light";
  opened_by: string;
  opened_at: string;
}

/** The name the platform composes: today's date, from the platform's own clock, then the slug.
 *
 * DELIBERATE: there is no argument for the date and no way to pass one. `isoToday()` is the
 * same clock and timezone `envelopeFor` stamps `updated_at` from, so a document's date and
 * its folder's cannot disagree. */
export function initiativeNameFor(slug: string): string {
  return `${isoToday()}-${slug.trim()}`;
}

/** Write the declaration, creating the folder. */
export function recordOpen(root: string, name: string, flow: string | null, who: string,
                           track: "full" | "light" = "full"): OpenRecord {
  const governed = flow?.trim() || null;
  const record: OpenRecord = {
    initiative: name,
    flow: governed,
    ...(governed ? { track } : {}),
    opened_by: who,
    opened_at: isoToday(),
  };
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, OPEN_RECORD), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Mark an initiative that holds no document as abandoned, on the record of its own opening.
 *
 * DELIBERATE: an outcome belongs on a document, and this is the one case where there is none
 * and never will be. The alternative is writing a document no stage produced to satisfy a
 * gate, so the open record carries it instead. */
export function recordAbandoned(root: string, name: string, who: string): void {
  const rec = openRecord(root, name);
  if (!rec) return;
  writeFileSync(join(root, name, OPEN_RECORD),
                `${JSON.stringify({ ...rec, abandoned_by: who, abandoned_at: isoToday() }, null, 2)}\n`);
}

/** The record, or null when there is none.
 *
 * DELIBERATE: the whole record is returned rather than a `declaredFlow(root, name)` helper.
 * `flow: null` is a declaration that nothing governs this, and a caller has to tell it apart
 * from no record at all.
 *
 * DELIBERATE: a malformed record is null rather than a throw. `initiative_status` is the call
 * every agent makes before continuing work, and an unparseable byte must not take it down. */
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
 * DELIBERATE: the slug is what is taken, not the dated name. Testing `<today>-<slug>` alone
 * lets the same work be opened again tomorrow under a second folder.
 *
 * Anchored, so a slug that is a prefix of an existing one is free: `payment` is not taken by
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

/** The refusal for a path whose initiative nobody opened, or null. A single existence test:
 * the name shape, the taken check and the flow declaration are `initiative_open`'s, asked
 * once, before there is a folder.
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
