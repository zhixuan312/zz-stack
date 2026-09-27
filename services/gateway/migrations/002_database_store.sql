-- 002_database_store.sql — the document store's revisions and links, and `doc`'s new identity keys.
--
-- DELIBERATE: this file adds and alters and deletes NO ROW. It creates `doc_revision` and
-- `doc_link`, gives `doc` the `current_revision`, `approved_revision` and `initiative_id` keys the
-- spec's Data model item 13 fixes, and moves its primary key off the three columns the file store
-- addressed a document by and onto the id the row already carries. The carry that fills
-- `doc_revision` from the teams' stores is a later file's (Task I-38): a revision cannot be
-- inserted before the table that holds it exists.
--
-- DELIBERATE: `doc_current_revision_required` is NOT VALID, and the rows this file may not write
-- are the reason. 439 of the 1,472 documents the 2026-09-27 backup carries hold `status = 'approved'`
-- and no revision row — their approved revision is the carry's to write, and this file is forbidden
-- from writing one — while PostgreSQL validates a new CHECK against every existing row at the
-- moment it is added. Added valid it would refuse the migration on real data; the alternative,
-- weakening the expression so a legacy row passes, would let the state the spec forbids stand
-- forever. NOT VALID keeps the expression the spec fixes and enforces it on every insert and update
-- from here.
--
-- DELIBERATE: `doc_revision` carries a primary key and a unique constraint on the same two columns.
-- That is one guarantee written twice, and the second copy is not a design choice: the spec fixes
-- the key as `(doc_id, revision)`, and `checks/store-shape.ts` reads "one revision number per
-- document" out of the target's `uniques` array — which `scripts/schema/catalog.ts` fills from
-- `pg_constraint` rows of type 'u', where a primary key (type 'p') never appears. Either one alone
-- fails one of the two declared checks. The unique constraint is added by its own statement below,
-- because PostgreSQL elides it when it is written inline; that statement says why.
--
-- DELIBERATE: `doc`'s retired columns stay. `team_slug`, `initiative`, `flow`, `outcome`,
-- `closed_by`, `approved_by`, `approved_at`, `evidence`, `supports`, `superseded_by` and
-- `produced_by_run_id` are dropped by Task I-41, once every reader has stopped naming them; the
-- tools that read them are Tasks I-39 and I-40's.
--
-- COUPLED: `schema-target.ts` and `schema-target/documents.ts` declare this shape, and
-- `checks/schema-inventory.ts` is what proves the two agree. `scripts/rehearse/expect.ts` declares
-- what the rehearsal should see: two tables created, `doc`'s row count unchanged, and the three
-- joins that hold the claim this file cannot hash — `doc`'s content digest is ordered by the live
-- primary key, which is the one key this file changes, so the two sides of the rehearsal cannot
-- agree on a digest order and the entry says so and names the measurement instead.
--
-- COUPLED: this file declares no `-- requires-extension:` line and needs none. `doc_revision`'s
-- content is text with no index on it, and the one index this file creates — `doc_link_unique` — is
-- a btree. `pg_trgm`, which `001_init.sql` installs, is for the trigram index on `doc.body` that
-- Phase 5 added and that this file leaves alone.

--
-- Name: doc_revision; Type: TABLE; Schema: zz; Owner: -
--
-- One row per known revision of a document. `retained` means the bytes are held in this row;
-- `missing_legacy` means the revision is known to have existed and its bytes were never preserved,
-- and no title, body, tags or hash is invented for it. Content fields are immutable after insert;
-- the only permitted update is the one-time approval seal, and a `missing_legacy` row is terminal.
--

CREATE TABLE zz.doc_revision (
    doc_id uuid NOT NULL,
    revision integer NOT NULL,
    content_state text NOT NULL,
    title text,
    body text,
    tags text[],
    content_hash text,
    written_by uuid,
    written_at timestamp with time zone,
    revision_note text,
    approved_by uuid,
    approved_at timestamp with time zone,
    CONSTRAINT doc_revision_approval_paired CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
    CONSTRAINT doc_revision_content_state_check CHECK (content_state IN ('retained', 'missing_legacy')),
    CONSTRAINT doc_revision_evidence_required CHECK (
        (content_state = 'retained'
            AND title IS NOT NULL AND body IS NOT NULL AND tags IS NOT NULL AND content_hash IS NOT NULL)
        OR (content_state = 'missing_legacy'
            AND title IS NULL AND body IS NULL AND tags IS NULL AND content_hash IS NULL)),
    CONSTRAINT doc_revision_missing_legacy_terminal CHECK (
        content_state <> 'missing_legacy' OR (approved_by IS NULL AND approved_at IS NULL)),
    CONSTRAINT doc_revision_pkey PRIMARY KEY (doc_id, revision)
);


--
-- Name: doc_revision doc_revision_doc_id_revision_key; Type: CONSTRAINT; Schema: zz; Owner: -
--
-- DELIBERATE: written as its own statement rather than inline in the CREATE TABLE above, and the
-- two are NOT interchangeable. PostgreSQL 17 elides a UNIQUE constraint declared inside CREATE TABLE
-- when it duplicates the primary key exactly — no `pg_constraint` row of type 'u' is left behind —
-- and writes it when the same constraint is added afterwards. Inline, this line silently produces
-- `uniques: []` and `checks/store-shape.ts` fails on the target entry it derives from it.
--

ALTER TABLE ONLY zz.doc_revision
    ADD CONSTRAINT doc_revision_doc_id_revision_key UNIQUE (doc_id, revision);


--
-- Name: doc_revision doc_revision_doc_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc_revision
    ADD CONSTRAINT doc_revision_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES zz.doc(id) ON DELETE CASCADE;


--
-- Name: doc_link; Type: TABLE; Schema: zz; Owner: -
--
-- One citation between exact revisions. `cites` names one exact revision citing another; `supports`
-- names an exact source revision bearing on a document identity across its later revisions, and
-- carries no target revision because none is fabricated.
--

CREATE TABLE zz.doc_link (
    from_doc_id uuid NOT NULL,
    from_revision integer NOT NULL,
    to_doc_id uuid NOT NULL,
    to_revision integer,
    kind text NOT NULL,
    CONSTRAINT doc_link_kind_check CHECK (kind IN ('cites', 'supports')),
    CONSTRAINT doc_link_revision_shape CHECK (
        (kind = 'cites' AND to_revision IS NOT NULL)
        OR (kind = 'supports' AND to_revision IS NULL))
);


--
-- Name: doc_link_unique; Type: INDEX; Schema: zz; Owner: -
--

CREATE UNIQUE INDEX doc_link_unique ON zz.doc_link USING btree (from_doc_id, from_revision, to_doc_id, to_revision, kind) NULLS NOT DISTINCT;


--
-- Name: doc_link doc_link_from_doc_id_from_revision_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc_link
    ADD CONSTRAINT doc_link_from_doc_id_from_revision_fkey FOREIGN KEY (from_doc_id, from_revision) REFERENCES zz.doc_revision(doc_id, revision);


--
-- Name: doc_link doc_link_to_doc_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc_link
    ADD CONSTRAINT doc_link_to_doc_id_fkey FOREIGN KEY (to_doc_id) REFERENCES zz.doc(id);


--
-- Name: doc_link doc_link_to_doc_id_to_revision_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc_link
    ADD CONSTRAINT doc_link_to_doc_id_to_revision_fkey FOREIGN KEY (to_doc_id, to_revision) REFERENCES zz.doc_revision(doc_id, revision);


--
-- Name: doc current_revision, approved_revision; Type: COLUMN; Schema: zz; Owner: -
--
-- Nullable, and left null on every existing row: this file writes none. The carry that gives a
-- legacy document its revision numbers is a later file's, and the two keys below are what make a
-- document's content a matter of which revision it names rather than of which file it came from.
--

ALTER TABLE ONLY zz.doc
    ADD COLUMN current_revision integer;

ALTER TABLE ONLY zz.doc
    ADD COLUMN approved_revision integer;


--
-- Name: doc doc_current_revision_required; Type: CHECK CONSTRAINT; Schema: zz; Owner: -
--
-- A status and a revision agree. `approved_revision <= current_revision`, and `status = 'approved'`
-- exactly when the approved revision IS the current one — which is what makes a revised document
-- draft again while its last approved revision stays recorded.
--
-- NOT VALID: see the header. The 439 legacy approvals carry no revision yet, and the carry that
-- writes one runs after this file.
--

ALTER TABLE ONLY zz.doc
    ADD CONSTRAINT doc_current_revision_required CHECK (
        (approved_revision IS NULL OR approved_revision <= current_revision)
        AND (status = 'approved') = (approved_revision IS NOT NULL AND approved_revision = current_revision)) NOT VALID;


--
-- Name: doc doc_id_approved_revision_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--
-- DEFERRABLE is the current-revision key's alone, and it is what lets a document and its revision 1
-- be inserted in one transaction: the document row must name a revision that is inserted after it.
-- This one is not deferrable, because an approved revision is always inserted before it is named.
--

ALTER TABLE ONLY zz.doc
    ADD CONSTRAINT doc_id_approved_revision_fkey FOREIGN KEY (id, approved_revision) REFERENCES zz.doc_revision(doc_id, revision);


--
-- Name: doc doc_id_current_revision_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc
    ADD CONSTRAINT doc_id_current_revision_fkey FOREIGN KEY (id, current_revision) REFERENCES zz.doc_revision(doc_id, revision) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: doc doc_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--
-- Replaced: the key was `on delete set null` on a nullable column. It is `not null` from here, and
-- a NOT NULL column cannot carry `set null` — PostgreSQL rejects the pair — so the action becomes
-- the cascade the spec's item 13 fixes: a deleted initiative takes its documents with it.
--

ALTER TABLE ONLY zz.doc
    DROP CONSTRAINT doc_initiative_id_fkey;

ALTER TABLE ONLY zz.doc
    ADD CONSTRAINT doc_initiative_id_fkey FOREIGN KEY (initiative_id) REFERENCES zz.initiative(id) ON DELETE CASCADE;

ALTER TABLE ONLY zz.doc
    ALTER COLUMN initiative_id SET NOT NULL;


--
-- Name: doc doc_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--
-- The key the store addressed a document by is `(team_slug, initiative, path)`, and two of those
-- three columns are on the retirement list (Task I-41). A document is its id.
--

ALTER TABLE ONLY zz.doc
    DROP CONSTRAINT doc_pkey;

ALTER TABLE ONLY zz.doc
    ADD CONSTRAINT doc_pkey PRIMARY KEY (id);
