-- 007_drop_legacy_store.sql — the eleven columns a document was addressed and stamped by, gone.
--
-- `doc` was the file store's index: a document was found by `(team_slug, initiative, path)`, and
-- the envelope's own facts — the flow, the outcome, the closer, the approval, the citations and
-- the run that wrote it — were stamped onto the row beside it. Every one of them has a better home
-- now, and the copies were the defect rather than the record:
--
--   team_slug, initiative   the store's address. A document is reached through `initiative_id`,
--                           and the team through the initiative's own `team_id`.
--   flow                    the initiative's flow, copied onto every one of its documents. It had
--                           to be the same string on each of them, which is what made a rename a
--                           rewrite of the whole folder.
--   outcome, closed_by      the close's facts. They are keys of the CURRENT revision's `fields`,
--                           so the revision that was closed on carries them with the bytes it
--                           signed, instead of the document row carrying the latest one.
--   approved_by, approved_at  the signature. It is `doc_revision.approved_by` / `approved_at`, on
--                           the revision that was sealed — and a signature has to cover the bytes
--                           it signed, which a column on the document cannot do.
--   evidence, supports      the citations. They are `doc_link` rows between exact revisions.
--   superseded_by           a document replaced by another one is `status: superseded`; the column
--                           was never written on this platform and reads null on every row.
--   produced_by_run_id      the run that wrote a document. This was the platform's most productive
--                           source of WRONG attribution: the join it fed resolved a document to
--                           whichever run happened to be recorded against it, it was null for
--                           every document indexed before the column existed, and it could not
--                           tell a rewrite from the original write. The run is named by the
--                           `zz.event` row that recorded the write.
--
-- WHY THIS FILE EXISTED TWICE. Task I-41 wrote a drop, ran it, and found it applies cleanly and
-- then takes the platform's write path and the console down at runtime: the live document writer,
-- the indexer, `runs.ts`'s attribution and the console's statements were all still reading these
-- columns. It deleted the file rather than leave a migration in `migrations/` that a release would
-- apply. Task I-44 moved every reader and writer onto rows. This file is the drop, landing after
-- the move rather than before it — and the order is the whole point, so the dependency is the
-- task sequence rather than a sentence claiming it.
--
-- DELIBERATE: no `if exists`, and no `cascade`. Every object below is present in the catalog this
-- file is applied to (it is `001_init.sql`'s `doc`, reshaped by `002_database_store.sql`), and a
-- migration that shrugs at a missing column is a migration that cannot tell "already dropped" from
-- "applied to the wrong database". The indexes and the foreign key are dropped by name before the
-- columns they are on: a bare `drop column` would take them implicitly, and a catalog whose
-- removal was implicit is one an operator cannot read back.
--
-- COUPLED: `schema-target/documents.ts` stops declaring all eleven in the same change, and
-- `checks/schema-inventory.ts` is what proves the two agree — it compares a live catalog against
-- the target, so either half alone is a red inventory. `checks/drop-is-complete.ts` asserts the
-- agreement itself, which is the property neither file states on its own.
--
-- DELIBERATE: this file adds and removes NO ROW. `doc` keeps every row it has, its count and its
-- content unchanged; what changes is its shape. The columns it drops carry no fact the platform
-- still reads — the two that held data a reader could still want (`outcome`, `closed_by`,
-- `approved_by`, `approved_at`, `evidence`) have their rows in `doc_revision.fields` and
-- `doc_revision.approved_by`/`approved_at`, written by the carry (Task I-38) and by every write
-- since.

--
-- Name: doc doc_outcome_closed; Type: CHECK CONSTRAINT; Schema: zz; Owner: -
--
-- The check is over `outcome`, so it goes with the column. `status` keeps its own
-- (`doc_status_closed`), which is the constraint that was ever load-bearing.
--

ALTER TABLE ONLY zz.doc
    DROP CONSTRAINT doc_outcome_closed;

--
-- Name: doc_evidence, doc_supports, doc_team_type; Type: INDEX; Schema: zz; Owner: -
--
-- Three of the seven indexes on `doc` were built over a retired column, and an index over a column
-- that is gone is not an index: `doc_evidence` was the gin index over the citation array,
-- `doc_supports` a partial btree over `(team_slug, initiative, supports)`, and `doc_team_type` the
-- btree the console listed a team's documents by. The console reads `zz.initiative` for the team
-- and `zz.doc.initiative_id` for the folder now, and the citations are `doc_link` rows, so none of
-- the three has a replacement here — each was an access path to a fact that moved.
--

DROP INDEX zz.doc_evidence;
DROP INDEX zz.doc_supports;
DROP INDEX zz.doc_team_type;

--
-- Name: doc doc_produced_by_run_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc
    DROP CONSTRAINT doc_produced_by_run_id_fkey;

--
-- Name: doc; Type: COLUMN; Schema: zz; Owner: -
--
-- The eleven. The comment on `doc.approved_by` goes with it — a comment on a column that does not
-- exist is not a fact about anything, and the signature it described is `doc_revision.approved_by`.
--

ALTER TABLE ONLY zz.doc
    DROP COLUMN team_slug;

ALTER TABLE ONLY zz.doc
    DROP COLUMN initiative;

ALTER TABLE ONLY zz.doc
    DROP COLUMN flow;

ALTER TABLE ONLY zz.doc
    DROP COLUMN outcome;

ALTER TABLE ONLY zz.doc
    DROP COLUMN closed_by;

ALTER TABLE ONLY zz.doc
    DROP COLUMN approved_by;

ALTER TABLE ONLY zz.doc
    DROP COLUMN approved_at;

ALTER TABLE ONLY zz.doc
    DROP COLUMN evidence;

ALTER TABLE ONLY zz.doc
    DROP COLUMN supports;

ALTER TABLE ONLY zz.doc
    DROP COLUMN superseded_by;

ALTER TABLE ONLY zz.doc
    DROP COLUMN produced_by_run_id;
