/**
 * Showing a document to a person, and the record that it was shown.
 *
 * `document_present` is what `document_approve` leans on: an approval is refused while nobody has
 * been shown the bytes, and this module is the only thing that answers "has anybody". Two acts
 * live here and they belong together for that reason — the presenter, and the fact it leaves.
 *
 * COUPLED: the fact is `doc_revision.presented_at`, set by `recordPresented` (attest.ts) on the
 * revision a person was shown, and `shownSinceLastChange` is what reads it back. Presentation is
 * about the CURRENT BYTES and the current bytes are a revision, so the revision is the grain;
 * a revision nobody has been shown carries null, and a change rewriting it in place moves the
 * revision's own `written_at` past the present without anybody having to remember to clear anything.
 *
 * A reader is shown PUBLIC versions: `version` is the one a change's cause opened, and several
 * stored snapshots can share it. `version: N` reads the snapshot `loadDocument` reads N as — its
 * approved one, else its last — and the history lists each version once.
 *
 * DELIBERATE: an unasked present is ONE part when the body is longer than a client can carry. The
 * old store version cut a present into parts only when a part was asked for, and returned the
 * whole body otherwise — which a client then truncated, silently, with the reader never learning
 * there was more. A body over the limit is a part whether or not anybody asked, and `present`
 * decides that here rather than at the tool, so a second caller cannot forget.
 *
 * DELIBERATE: a present is recorded against the revision it SHOWED, and only when that revision is
 * the one the document points at — `presented_at` is a column on that row, so presenting history is
 * a read and not a present. Both forms below carry that rule; `presentPart` did not, and the defect
 * it let through is why it does now. Within the current revision, only a part's own spans count
 * towards coverage: `partsCover` reads the spans recorded since that revision was written, and its
 * span bookkeeping is the one thing here that still lives in `zz.event` — a column cannot hold a
 * span set. Losing those rows makes a partly-presented document read as unpresented, which refuses
 * an approval: it fails CLOSED, and that is the direction this platform fails in.
 */
import { contentRevision, documentBody, parseEnvelope } from "@zz/contracts";
import type pg from "pg";

import { loadDocument, publicVersions, recordAct } from "./versions.js";
import { recordPresented, splitDocPath } from "./attest.js";
import { type PartAsk, PART_LIMIT, asksPart, partHeader, slicePart } from "./document-parts.js";

/** Show a document to a person, whole or in part, and record that they saw it.
 *
 * ONE entry point, so the choice between the two forms below is made in one place: a part when one
 * was asked for, and a part when the body is longer than a client can carry even though nobody
 * asked. A tool that made that choice itself is a tool that can forget to.
 *
 * Returns the refusal when the document or the version named is not there — the caller states it
 * rather than inventing a rendering of a document nothing holds. */
export async function present(
  p: pg.Pool, team: string, relPath: string, version: number | undefined, user: string,
  ask: PartAsk = {},
): Promise<string> {
  const loaded = await loadDocument(team, relPath, version);
  if (!loaded.ok) return loaded.refusal;
  const body = documentBody(loaded.text).trim();
  return asksPart(ask) || body.length > PART_LIMIT
    ? presentPart(p, team, relPath, version, user, ask)
    : presentDocument(p, team, relPath, version, user);
}

/** One part of a document presented, and the record of it. */
async function presentPart(
  p: pg.Pool, team: string, relPath: string, version: number | undefined, user: string,
  ask: PartAsk = {},
): Promise<string> {
  const loaded = await loadDocument(team, relPath, version);
  if (!loaded.ok) return loaded.refusal;
  const content = loaded.text;
  const env = parseEnvelope(content);
  const body = documentBody(content).trim();
  const part = slicePart(body, ask);
  if (typeof part === "string") return part;
  const shownVersion = String(loaded.rev.version);
  const facts = [`This is ${relPath}`, `version ${shownVersion}`];
  if (env.status) facts.push(`status ${env.status}`);
  facts.push(contentFact(loaded));
  const signed = env.approved_by
    ? ` Approved by ${env.approved_by}${env.approved_at ? ` on ${env.approved_at}` : ""}.` : "";
  // The part's own row, so coverage can be computed: `total` is what tells two parts of different
  // revisions apart, and `version`/`revision` say which snapshot this one was cut from.
  recordAct(relPath, { user, action: "shown_part", path: relPath, version: shownVersion,
                       revision: loaded.rev.revision, start: part.start, end: part.end, total: part.total });
  // A part of the WHOLE body, when it is the whole body, is a present and not a partial one — the
  // record follows the bytes a reader has actually seen rather than the shape of the call.
  //
  // DELIBERATE, and the same rule `presentDocument` states 35 lines below: the present is recorded
  // on the revision `version` NAMED, and `presented_at` is a column on the row the document points
  // at — so it is recorded only when that revision is the current one. Without this guard,
  // `document_present(path, version: 1, section: "<the whole body>")` wrote `presented_at` on the
  // CURRENT revision, `shownSinceLastChange` answered true, and `document_approve` stamped an
  // approval on bytes nobody had been shown. Reading history is a read, not a present, whether it
  // arrives whole or in parts — and the coverage spans below are attributed to the live path, so an
  // older revision's spans must not count towards it either.
  const current = loaded.rev.revision === loaded.doc.current_revision;
  let covered: "shown" | "covered" | "partial" = "partial";
  if (current && part.start === 0 && part.end === part.total) {
    await recordPresented(p, team, relPath);
    covered = "shown";
  } else if (current
             && await partsCover(p, team, relPath, part.total, { start: part.start, end: part.end }) === "covered") {
    await recordPresented(p, team, relPath);
    recordAct(relPath, { user, action: "shown", path: relPath, version: shownVersion,
                         revision: loaded.rev.revision, via: "parts" });
    covered = "shown";
  }
  const standing = !current
    ? `This is a snapshot of version ${shownVersion}, not the current one. Presenting history does not ` +
      "vouch for the current revision: approval is refused until that revision's own bytes have been presented."
    : covered !== "partial"
      ? "Every character of the current body has now been presented, in parts — it counts as presented."
      : "Presented in part. It does NOT yet count as presented: present the remaining characters " +
        "(every part since the last change counts) before the document is approved. A client " +
        "that shows the document panel puts all of it in front of the person and records that " +
        "itself — if the person can see the panel, leave the rest to it.";
  return `${facts.join(", ")}.${signed}\n${partHeader(relPath, part, "the body, frontmatter excluded", body)}\n` +
         `${standing}\n\n${part.text}\n`;
}

/** One document presented whole, and the `shown` record for it.
 *
 * The row names the bytes that were returned: fetching v1 records a present of v1, not of the
 * current revision, so opening an old version never vouches for the present. */
async function presentDocument(
  p: pg.Pool, team: string, relPath: string, version: number | undefined, user: string,
): Promise<string> {
  const loaded = await loadDocument(team, relPath, version);
  if (!loaded.ok) return loaded.refusal;
  const content = loaded.text;
  const env = parseEnvelope(content);
  const revision = loaded.rev.revision;
  // Only what the document carries: a source has no status, and stating "status: none" for one
  // asserts a lifecycle nothing governs.
  const facts = [`This is ${relPath}`, `version ${loaded.rev.version}`];
  if (env.status) facts.push(`status ${env.status}`);
  facts.push(contentFact(loaded));
  const signed = env.approved_by
    ? ` Approved by ${env.approved_by}${env.approved_at ? ` on ${env.approved_at}` : ""}.` : "";
  // The presentation is recorded on the revision that was SHOWN, which is the revision `version`
  // named — and it is recorded only when that revision is the current one, because the column
  // lives on the revision row the document points at. Opening history is a read, not a present.
  const current = revision === loaded.doc.current_revision;
  if (current) await recordPresented(p, team, relPath);
  recordAct(relPath, { user, action: "shown", path: relPath, version: String(loaded.rev.version), revision });
  // One entry per public version, each the snapshot it is read as, with the note that says why it
  // differs from the one before.
  const history = publicVersions(loaded.history).map((r) =>
    `v${r.version} ${r.approved_by ? "approved" : "filed"}` +
    (r.approved_by ? ` by ${r.approved_by}` : "") +
    (r.approved_at ? ` on ${r.approved_at}` : "") +
    (r.revision_note ? ` — ${r.revision_note}` : ""));
  const listed = history.length
    ? `Versions filed: ${history.join("; ")}. Read one with \`version: N\`.`
    : "Versions filed: none — no approval has landed on this document yet.";
  return `${facts.join(", ")}.${signed}\n${listed}\n\n${documentBody(content).trim()}\n`;
}

/** The document's current content revision — the token a change sends as `base` — stated on every
 *  present. The envelope carries it only on the current snapshot, so a present of history names
 *  it as the CURRENT document's, never as the token of the bytes shown. */
function contentFact(loaded: Extract<Awaited<ReturnType<typeof loadDocument>>, { ok: true }>): string {
  const token = contentRevision(loaded.doc.id, Number(loaded.doc.content_generation));
  return loaded.rev.revision === loaded.doc.current_revision
    ? `content revision ${token}`
    : `current version ${loaded.doc.current_version} at content revision ${token}`;
}

/** How much of the current body has been presented since its content last changed: `shown` when
 * a whole present already stands, `covered` when the parts alone reach every character, `partial`
 * otherwise.
 *
 * `also` is the span the caller is presenting RIGHT NOW. It is a parameter and not something this
 * function reads back, because `recordAct` is fire-and-forget by design — a journal entry must
 * never fail the act it describes — so the row this call just wrote may not be visible to a read
 * issued in the same turn. A coverage rule that depended on that ordering would report a
 * completed set of parts as incomplete whenever the write lost the race, which is a gate that
 * refuses an approval the reader has earned.
 *
 * COUPLED: the spans are `zz.event` rows, and only those recorded SINCE the current revision was
 * written count — a part cut from other bytes is a part of another document-as-it-was. That is the
 * same rule `presented_at > written_at` states for a whole present, and it is what makes a change
 * rewriting the revision in place invalidate the parts without anybody having to clear them. */
async function partsCover(
  p: pg.Pool, team: string, relPath: string, total: number,
  also?: { start: number; end: number },
): Promise<"shown" | "covered" | "partial"> {
  const at = splitDocPath(relPath);
  if (!at) return "partial";
  try {
    const { rows } = await p.query<{ kind: string; start: number | null; end: number | null; total: number | null }>(
      `select e.kind,
              (e.detail->>'start')::int as start, (e.detail->>'end')::int as end,
              (e.detail->>'total')::int as total
         from zz.event e
         join zz.initiative i on i.id = e.initiative_id
         join zz.team t on t.id = i.team_id
         join zz.doc d on d.initiative_id = i.id and d.path = $3
         join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
        where t.slug = $1 and i.slug = $2 and e.subject = $4
          and e.kind in ('document.shown', 'document.shown_part')
          and e.ts >= r.written_at
        order by e.ts, e.id`,
      [team, at.initiative, at.path, relPath]);
    if (rows.some((r) => r.kind === "document.shown")) return "shown";
    let reached = 0;
    const spans: [number, number][] = rows
      .filter((r) => r.kind === "document.shown_part" && r.total === total &&
                     typeof r.start === "number" && typeof r.end === "number")
      .map((r) => [r.start as number, r.end as number] as [number, number]);
    if (also) spans.push([also.start, also.end]);
    for (const [s, e] of spans.sort((a, b) => a[0] - b[0])) {
      if (s > reached) break;
      reached = Math.max(reached, e);
    }
    return reached >= total ? "covered" : "partial";
  } catch {
    return "partial";
  }
}

/** The size above which a present comes back in parts unasked. Re-exported so a presenter and
 *  the check that guards it name one number. */
export { PART_LIMIT, asksPart };

