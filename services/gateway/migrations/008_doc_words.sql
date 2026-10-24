-- 008_doc_words.sql — how many words a body holds, by the hash of its bytes, kept as a row.
--
-- Record and Home report words written. Both count them by running the platform's own `countWords`
-- over the body of every revision the team's flow documents have had, and that answer is a pure
-- function of bytes the platform never changes. It was recomputed by every process that ever
-- started: on this deployment 922 revisions and 123 MB of text, 1.4 s inside PostgreSQL and about as
-- long again in Node, paid by the first Home or Record a restarted gateway answered — 4.6 s against
-- a console that gives a read 4.5 s before it calls the platform silent.
--
-- The row is filled by that read (`services/gateway/src/console/word-counts.ts`), inserted
-- `on conflict do update`, so nothing here inserts one. `counted_by` names the generation of
-- `countWords` that produced it, so a release that changes what a word is re-counts rather than
-- answering old numbers.
--
-- `schema-target/documents.ts` declares the table. `scripts/rehearse/expect.ts` needs no entry: a
-- new table starts empty on a production copy and no existing row moves, which is the default
-- assertion. The release before this file can run on what it builds — its code reads no such table.
-- A rollback leaves it in place with the rows its own reads wrote, which the older release ignores.

CREATE TABLE zz.doc_words (
    content_hash text NOT NULL,
    words integer NOT NULL,
    counted_by integer NOT NULL,
    counted_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE zz.doc_words OWNER TO zz;

ALTER TABLE ONLY zz.doc_words
    ADD CONSTRAINT doc_words_pkey PRIMARY KEY (content_hash);

COMMENT ON TABLE zz.doc_words IS 'class=current_state; authority=this; question=how many words does a body hold, keyed by the hash of its own bytes, a count derived by countWords and reusable by every revision and every read whose bytes hash to the same value?';

COMMENT ON COLUMN zz.doc_words.content_hash IS 'class=immutable_history; authority=this; question=which body''s bytes this count is of, the same hash zz.doc.content_hash and zz.doc_revision.content_hash carry?';

COMMENT ON COLUMN zz.doc_words.words IS 'class=current_state; authority=this; question=how many words the platform counts in that body, recomputed rather than adjusted whenever the count is of a different generation?';

COMMENT ON COLUMN zz.doc_words.counted_by IS 'class=current_state; authority=this; question=which generation of countWords produced the number beside it, so a release that changes what a word is re-counts rather than answering old numbers?';

COMMENT ON COLUMN zz.doc_words.counted_at IS 'class=current_state; authority=this; question=when was this body last counted, the moment the row was written or overwritten?';
