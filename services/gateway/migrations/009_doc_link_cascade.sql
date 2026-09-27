-- 009_doc_link_cascade.sql — a document's links go with it.
--
-- `zz.doc_link` and `zz.doc_revision` are both children of `zz.doc`, and they were given different
-- keys: `doc_revision_doc_id_fkey` cascades and `doc_link_to_doc_id_fkey` did not. Deleting a
-- document therefore died on the link's key with the delete half-done, which is how the probe purge
-- found it — four `chain-check-*` initiatives survived a sweep that had already removed everything
-- else, and the release reported them as litter. The purge deletes the links explicitly today, so
-- nothing is blocked by this; the key is still wrong, and the next deleter meets it.
--
-- The pair `(from_doc_id, from_revision)` is re-added for the same reason and not merely for
-- symmetry: a revision row goes with its document, so a link naming that revision would otherwise
-- be pointing at a row the cascade had just removed.
--
-- DELIBERATE: `eval_assessment_doc_id_fkey` and `eval_protocol_version_approved_doc_id_fkey` are
-- left alone. Those name a document a verdict is ABOUT, and deleting the document is not a reason
-- to lose the verdict or the affirmed protocol version; whoever deletes one of those documents
-- decides what its evaluations mean, and a cascade here would decide for them.

BEGIN;

ALTER TABLE zz.doc_link DROP CONSTRAINT doc_link_to_doc_id_fkey;
ALTER TABLE zz.doc_link
    ADD CONSTRAINT doc_link_to_doc_id_fkey FOREIGN KEY (to_doc_id) REFERENCES zz.doc(id) ON DELETE CASCADE;

ALTER TABLE zz.doc_link DROP CONSTRAINT doc_link_from_doc_id_from_revision_fkey;
ALTER TABLE zz.doc_link
    ADD CONSTRAINT doc_link_from_doc_id_from_revision_fkey
    FOREIGN KEY (from_doc_id, from_revision) REFERENCES zz.doc_revision(doc_id, revision) ON DELETE CASCADE;

ALTER TABLE zz.doc_link DROP CONSTRAINT doc_link_to_doc_id_to_revision_fkey;
ALTER TABLE zz.doc_link
    ADD CONSTRAINT doc_link_to_doc_id_to_revision_fkey
    FOREIGN KEY (to_doc_id, to_revision) REFERENCES zz.doc_revision(doc_id, revision) ON DELETE CASCADE;

COMMIT;
