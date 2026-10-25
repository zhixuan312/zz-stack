-- 015_doc_body_drop.sql — `zz.doc` stops storing a second copy of the bytes its current revision
-- already holds, and the trigram index the search's substring lane reads moves onto the revision
-- table in this same file.
--
-- `services/zz-core/src/indexing.ts` already recorded the column as the denormalised copy: the
-- revision table is the one that holds a document's bytes, and a reader answering from the copy
-- while the revision moved reads a stale document. What kept the copy alive was not a reader that
-- wanted it but the fallback every reader wrote instead of choosing a table — `coalesce(r.body,
-- d.body)` — which answers from the revision when there is one and from the copy when there is
-- not. That shape is what makes the column worth removing rather than leaving: it hides a reader
-- that names the wrong table for as long as the column exists, and turns every one of those readers
-- into `column d.body does not exist` on the day it goes, on a path no test happened to exercise.
--
-- On 2026-10-25 the deployment held 4,316 documents and 5,934 revision rows in 264 MB, and none of
-- them disagreed about a document's text: 0 with no `current_revision`, 0 whose `current_revision`
-- resolves to no revision row, and 0 whose `zz.doc.body` differs from the body the current revision
-- holds. The probes and their statements are filed at
-- `sources/2026-10-25-read-only-probes-on-the-production-database-2026-10-25-for-p.md`.
--
-- DELIBERATE: the index moves here, in the file that drops the column, and not in a later one. The
-- search's Han and substring lane matches `body` with `ilike`, and the only index serving it was
-- `doc_body_trgm` on the column being dropped. On the same probes that lane read `zz.doc` as a
-- sequential scan in 96.7 ms and the revision table, with no trigram index on it, in 272.7 ms — so a
-- release that dropped the column first and indexed the revision table afterwards would serve every
-- search from the slower plan for as long as the gap lasted. The runner wraps this file in one
-- transaction (`services/gateway/src/db.ts`), so no session sees a state with neither index: a
-- concurrent search reads `doc_body_trgm` until this file commits and `doc_revision_body_trgm` after
-- it, and the two statements below are ordered so the replacement exists even to a reader that
-- inspects the catalog between them inside one session.
--
-- DELIBERATE: `body_tsv` and `analyzer_version` stay. They are the search projection of the SAME
-- bytes — `services/zz-core/src/document-save.ts` builds them from the request's own text as it
-- writes the revision, and `packages/indexing`'s rederivation pass rebuilds them from a row it
-- reads — and neither ever read the dropped column. Their column comments named it as their
-- authority, which is why this file restates both against the revision table rather than leaving a
-- projection pointing at a column that no longer exists.
--
-- `schema-target/documents.ts` declares all three changes: the column and its comment go, the
-- trigram index moves from `doc` to `doc_revision`, and the two projections' comments name the
-- revision they are actually built from.
--
-- The rehearsal needs `doc` declared in `scripts/rehearse/expect.ts` over the columns that survive
-- this file: the default digest covers the whole row, and `body` exists on the before side only.
--
-- The release before this file cannot run on what it builds: `services/zz-core/src/document-save.ts`
-- writes `zz.doc.body` on every create and on both update paths, so the previous image's first
-- document write fails, and its readers select the column. `scripts/release/rollback-guard.ts`
-- refuses a rollback across this file from the line below and again from the drop itself; the fold
-- that absorbs this file removes both with it.
-- rollback: refused — the previous image reads and writes zz.doc.body, which this drops
--
-- Nothing below is idempotent: `alter table … drop column` has no form that leaves the catalog as it
-- found it, and no statement here guards against running twice. `zz.schema_migration` is what stops
-- a second run — the runner records this file in the same transaction and skips it after.

-- The trigram index the search's Han and substring lane reads, on the table that holds the bytes.
-- First, so the lane has an index to read before the one on the copy goes.
CREATE INDEX doc_revision_body_trgm ON zz.doc_revision USING gin (body zz.gin_trgm_ops);

-- The column, and with it `doc_body_trgm` — PostgreSQL drops an index with a column it depends on,
-- and that index was the only object that named this column.
ALTER TABLE zz.doc DROP COLUMN body;

-- The two columns that stay are projections of the revision's body. Their comments said so through
-- the column this file drops; these name the revision they are built from.
COMMENT ON COLUMN zz.doc.body_tsv IS 'class=projection; authority=zz.doc_revision.body; question=what is this document''s body as the search vector a full-text query matches?; rebuilt_from=doc_revision[current_revision].body';

COMMENT ON COLUMN zz.doc.analyzer_version IS 'class=projection; authority=zz.doc_revision.body; question=which analyzer generation produced this document''s search vector, so a vector from another generation can be rederived?; rebuilt_from=doc_revision[current_revision].body';
