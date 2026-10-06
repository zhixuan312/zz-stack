/**
 * The invariants that hold of ANY correct store, whatever migration last ran.
 *
 * The joins in `expect.ts` are declared per migration and run only while that migration is
 * PENDING — which is right for "what this file changed", and wrong for "what the store must always
 * be". Once a release's `002_` file is folded into `001_init.sql` and the ledger records it, no
 * migration is ever pending again, and a rehearsal on that shape checked nothing at all: the
 * assertions the phase's own release rested on stopped running the moment the phase was folded.
 *
 * These run on every rehearsal, in both directions of the release: they are what turns "the
 * migration applied" into "the store it produced is one a reader can trust". Each is a query
 * returning the count of rows that BREAK the rule, and the expectation is zero.
 *
 * A rule belongs here when it is true of the target's own design — not of one migration's work.
 */
import type { JoinExpectation } from "./expect.ts";

export const ALWAYS_JOINS: readonly JoinExpectation[] = [
  {
    // The projection `doc` keeps its current revision's content in. A live write sets all four from
    // the same bytes; the carry set `content_hash` from the file store's own value, which described
    // a row-derivation this platform no longer has (002_store_carry_repair.sql backfilled it).
    // `rebuilt_from=doc_revision[current_revision]` is a claim, and this is the only thing that
    // checks it.
    name: "every doc's body, title, tags and content_hash are its current revision's",
    violatingCount: `select count(*)::int as n
      from zz.doc d join zz.doc_revision r
        on r.doc_id = d.id and r.revision = d.current_revision
     where d.body is distinct from r.body
        or d.title is distinct from r.title
        or d.tags is distinct from r.tags
        or d.content_hash is distinct from r.content_hash`,
  },
  {
    name: "every doc.current_revision names a revision of that document",
    violatingCount: `select count(*)::int as n from zz.doc d
      where d.current_revision is not null
        and not exists (select 1 from zz.doc_revision r
                         where r.doc_id = d.id and r.revision = d.current_revision)`,
  },
  {
    name: "every doc.approved_revision names a revision of that document",
    violatingCount: `select count(*)::int as n from zz.doc d
      where d.approved_revision is not null
        and not exists (select 1 from zz.doc_revision r
                         where r.doc_id = d.id and r.revision = d.approved_revision)`,
  },
  {
    // `doc_current_revision_required`, stated as a count so a rehearsal on a database where the
    // constraint is somehow NOT VALID still reports the rows it tolerates. The migration that
    // repaired the carry validates the constraint; this is what would catch it being dropped.
    name: "no doc says approved without an approved revision being its current one",
    violatingCount: `select count(*)::int as n from zz.doc d
     where (d.status = 'approved') is distinct from
           (d.approved_revision is not null and d.approved_revision = d.current_revision)`,
  },
  {
    // `zz.doc.current_version` is a projection of the current snapshot's `version`, declared with
    // `rebuilt_from=doc_revision[current_revision].version`; this is what checks the claim. The
    // table's own CHECK holds only that the two are null together.
    name: "doc.current_version is the version of the row current_revision names",
    violatingCount: `select count(*)::int as n
      from zz.doc d join zz.doc_revision r
        on r.doc_id = d.id and r.revision = d.current_revision
     where d.current_version is distinct from r.version`,
  },
  {
    // A source's `supports` is a relation to a DOCUMENT's identity, which is what makes it survive
    // a revision of the target. A row naming a revision is the `cites` grain wearing the other
    // kind's name, and every reader of `supports` compares against a document path.
    name: "every supports link names a document and not a revision of one",
    violatingCount: `select count(*)::int as n from zz.doc_link l
      where l.kind = 'supports' and l.to_revision is not null`,
  },
];
