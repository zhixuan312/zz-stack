/**
 * The two legacy pins of AC-6.7, resolved from the store and never from a timestamp.
 *
 * `eval_protocol_version.approved_doc_revision` is proved by the frozen approval record: a protocol
 * body quotes the `content_digest` of the version it was recorded with, so the revision whose bytes
 * carry that digest is the revision that affirmed it, and a version whose record proves no single
 * revision keeps null.
 *
 * `eval_assessment.doc_revision` is proved only where the store holds exactly one revision of the
 * document a legacy subject judged, because then no choice is being made at all. Every other
 * population keeps null and is reported by name — a document with a history is not pinned by
 * picking the revision nearest some timestamp.
 *
 * DELIBERATE: the bytes of a revision are handed in rather than read here. Reading them is the
 * store's own naming — which file holds which revision — and a second reader of it is a second
 * chance to disagree with the first.
 */
import type { Placed, Queryable } from "./model.ts";

import type { StoreReport } from "./report.ts";

/** A revision's bytes, or null when the store does not hold them — which is what `missing_legacy`
 *  means. Supplied by the caller, which is where the store is read. */
type RevisionReader = (doc: Placed["doc"], revision: number) => string | null;

/**
 * The two legacy pins of AC-6.7, resolved from the store alone and never from a timestamp.
 *
 * A protocol body quotes the `content_digest` of the version it was recorded with, so the revision
 * whose bytes carry that digest is the revision that affirmed it; a version whose record proves no
 * single revision stays null. A document subject is pinned only where the store holds exactly one
 * revision of the document, because then no choice is being made at all — every other population
 * is left null and reported, by name.
 */
export async function pinLegacy(
  db: Queryable, placed: Map<string, Placed>, report: StoreReport, readRevision: RevisionReader,
): Promise<void> {
  const protocols = (await db.query<{
    id: string; version: string; content_digest: string; approved_doc_id: string | null;
  }>(`select id, version, content_digest, approved_doc_id from zz.eval_protocol_version
       where affirmed_at is not null`)).rows;
  for (const p of protocols) {
    const target = p.approved_doc_id ? placed.get(p.approved_doc_id) : undefined;
    if (!target) {
      report.pins.protocolsUnpinned++;
      report.pins.unpinned.push(
        `eval_protocol_version ${p.id} (v${p.version}): approved_doc_id names no document the store holds`);
      continue;
    }
    const hit = target.numbers.filter((n) => {
      const bytes = readRevision(target.doc, n);
      return bytes !== null && bytes.includes(p.content_digest);
    });
    if (hit.length !== 1) {
      report.pins.protocolsUnpinned++;
      report.pins.unpinned.push(
        `eval_protocol_version ${p.id} (v${p.version}): ${hit.length === 0
          ? "no revision of the affirmed document quotes its content_digest"
          : `${hit.length} revisions quote it (v${hit.join(", v")}), so the record proves no single one`}`);
      continue;
    }
    await db.query("update zz.eval_protocol_version set approved_doc_revision = $2 where id = $1",
      [p.id, hit[0]]);
    report.pins.protocolsPinned++;
  }

  const subjects = (await db.query<{ doc_id: string; n: string }>(
    `select doc_id, count(*)::text as n from zz.eval_assessment
      where subject_kind = 'document' and doc_id is not null group by doc_id`)).rows;
  for (const s of subjects) {
    const target = placed.get(s.doc_id);
    const numbers = target?.numbers ?? [];
    const rows = Number(s.n);
    if (numbers.length === 1) {
      await db.query(
        "update zz.eval_assessment set doc_revision = $2 where subject_kind = 'document' and doc_id = $1",
        [s.doc_id, numbers[0]]);
      report.pins.assessmentsPinned += rows;
      continue;
    }
    report.pins.assessmentsUnpinned += rows;
    report.pins.unpinned.push(
      `eval_assessment document subject ${s.doc_id} (${rows} row(s)): ${numbers.length === 0
        ? "the store carries no revision of that document"
        : `the store holds ${numbers.length} revisions (v${numbers.join(", v")}) and proves no single one`}`);
  }
}
