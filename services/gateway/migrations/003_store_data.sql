-- 003_store_data.sql — the legacy evaluation pins, and the keys that hold them to exact bytes.
--
-- DELIBERATE: this file adds and alters and deletes NO ROW. It gives `eval_protocol_version` the
-- `approved_doc_revision` column the spec's Data model item 30 fixes, and the two composite keys
-- and two tightened CHECKs the spec's constraint order names, so the rows Task I-38's carry writes
-- have somewhere to land. Which rows get a revision is the carry's business: this file writes none,
-- and on a fresh database with no team store every new column is null and every new CHECK is
-- vacuously satisfied.
--
-- DELIBERATE: `eval_protocol_version_affirmed_revision` is NOT VALID, and the rows this file may
-- not write are the reason. The 16 protocol versions the 2026-09-27 backup carries are all
-- affirmed, and the carry gives one of them `approved_doc_revision` only where a frozen approval
-- record proves the revision affirmed (FR-27); PostgreSQL validates a new CHECK against every
-- existing row at the moment it is added, so added valid this file would refuse the migration on
-- real data. NOT VALID keeps the expression the spec fixes and enforces it on every insert and
-- update from here, which is exactly FR-27's "every new protocol affirmation must pin the exact
-- doc_revision it affirmed".
--
-- DELIBERATE: `eval_assessment_document_revision` is NOT VALID for the same reason. 64 of the 510
-- rows the backup carries are `subject_kind = 'document'`, and AC-6.7 leaves a legacy document
-- subject unpinned when retained evidence does not prove the exact revision it judged. Adding the
-- CHECK valid would refuse the migration over rows the spec deliberately leaves null.
--
-- COUPLED: `schema-target/eval-protocol.ts` and `schema-target/eval-run.ts` declare this shape, and
-- `checks/schema-inventory.ts` is what proves the two agree. `scripts/rehearse/expect.ts` declares
-- what the rehearsal should see: `eval_protocol_version`'s content digest hashed over the fifteen
-- columns that exist on both sides of it — `approved_doc_revision` is this file's own column and
-- a digest carrying it would differ for that reason alone — and `eval_assessment` unchanged.
--
-- COUPLED: this file declares no `-- requires-extension:` line and needs none. The one column it
-- adds is an integer with no index on it, and both composite keys reference a primary key.

--
-- Name: eval_protocol_version approved_doc_revision; Type: COLUMN; Schema: zz; Owner: -
--
-- Nullable, and left null on every existing row: this file writes none. The carry resolves it from
-- a frozen approval record, which proves the exact revision the version's own `content_digest` was
-- affirmed at; a version whose exact revision the record does not prove keeps null and is reported.
--

ALTER TABLE ONLY zz.eval_protocol_version
    ADD COLUMN approved_doc_revision integer;


--
-- Name: eval_protocol_version eval_protocol_version_approved_doc_revision_fkey; Type: FK CONSTRAINT
--
-- MATCH SIMPLE, deliberately: a null in either column satisfies it, so a protocol version that
-- pins no revision is admitted while one that names a document is held to a revision of that
-- document. That is the property AC-6.7 asks for — a pin, where there is one, is exact.
--

ALTER TABLE ONLY zz.eval_protocol_version
    ADD CONSTRAINT eval_protocol_version_approved_doc_revision_fkey
    FOREIGN KEY (approved_doc_id, approved_doc_revision) REFERENCES zz.doc_revision(doc_id, revision);


--
-- Name: eval_protocol_version eval_protocol_version_affirmed_revision; Type: CHECK CONSTRAINT
--
-- A version affirmed from here on pins exact bytes. The existing affirmed versions predate
-- `doc_revision` and are not validated; see the header.
--

ALTER TABLE ONLY zz.eval_protocol_version
    ADD CONSTRAINT eval_protocol_version_affirmed_revision CHECK (
        affirmed_at IS NULL OR approved_doc_revision IS NOT NULL) NOT VALID;


--
-- Name: eval_assessment eval_assessment_doc_revision_fkey; Type: FK CONSTRAINT
--
-- The composite key the spec's item 41 names, in place of the plain `doc_id -> doc` key a
-- document subject used to carry. `doc_revision` is already a column on this table — Phase 3
-- left it null on every row — so this file adds the key, not the column.
--

ALTER TABLE ONLY zz.eval_assessment
    ADD CONSTRAINT eval_assessment_doc_revision_fkey
    FOREIGN KEY (doc_id, doc_revision) REFERENCES zz.doc_revision(doc_id, revision);


--
-- Name: eval_assessment eval_assessment_document_revision; Type: CHECK CONSTRAINT
--
-- Every document subject recorded from here on pins the exact revision it judged and stays joined
-- to those bytes after later revisions. A legacy document subject stays unpinned where the store
-- does not prove the revision; see the header.
--

ALTER TABLE ONLY zz.eval_assessment
    ADD CONSTRAINT eval_assessment_document_revision CHECK (
        subject_kind <> 'document'::text OR doc_revision IS NOT NULL) NOT VALID;
