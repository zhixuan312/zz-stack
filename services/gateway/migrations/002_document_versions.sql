-- 002_document_versions.sql — public versions, the content generation, cause links, request
-- records, the cause-link epoch, and the activity record's details.
--
-- `zz.doc_revision.revision` stays the snapshot id every pin names (`doc_link`,
-- `eval_assessment.doc_revision`, `eval_protocol_version.approved_doc_revision`, the approval
-- seal). The public version a reader is shown becomes its own column, because a change to a
-- presented or approved snapshot with no new cause files a new snapshot in the SAME version.
--
-- DELIBERATE: `version = revision` for every existing row is exact, not invented. Until this file
-- every revision was a public version — the only writer that added a revision was the one that
-- opened a version — and production's revisions are contiguous from 1. `current_version` is then
-- the version of the row `current_revision` names, null exactly when that is.
--
-- `content_generation` starts at 0 for every document: the counter a content revision token binds
-- moves from here on, and no token was ever issued before it.
--
-- `scripts/rehearse/expect.ts` declares what this file changes. It folds into 001_init.sql at the
-- release that verifies it, and the fold keeps the epoch's insert.

-- zz.doc_revision: the public version of each snapshot.
ALTER TABLE zz.doc_revision ADD COLUMN version integer;

UPDATE zz.doc_revision SET version = revision;

ALTER TABLE zz.doc_revision ALTER COLUMN version SET NOT NULL;

ALTER TABLE zz.doc_revision ADD CONSTRAINT doc_revision_version_positive CHECK ((version >= 1));

CREATE INDEX doc_revision_version ON zz.doc_revision USING btree (doc_id, version);

COMMENT ON COLUMN zz.doc_revision.version IS 'class=state_machine; authority=this; question=which public version of the document does this snapshot belong to, the number a reader asks for while revision stays the snapshot every pin names?';

-- zz.doc: the current public version, and the content generation.
ALTER TABLE zz.doc ADD COLUMN current_version integer;

ALTER TABLE zz.doc ADD COLUMN content_generation bigint DEFAULT 0 NOT NULL;

UPDATE zz.doc d SET current_version = r.version
  FROM zz.doc_revision r
 WHERE r.doc_id = d.id AND r.revision = d.current_revision;

ALTER TABLE zz.doc ADD CONSTRAINT doc_current_version_follows CHECK (((current_version IS NULL) = (current_revision IS NULL)));

COMMENT ON COLUMN zz.doc.current_version IS 'class=projection; authority=zz.doc_revision.version; question=which public version is this document''s current revision, the number a reader is shown?; rebuilt_from=doc_revision[current_revision].version';

COMMENT ON COLUMN zz.doc.content_generation IS 'class=state_machine; authority=this; question=how many times has this document''s body or editable metadata changed, the counter a content revision token binds so a stale read is detectable even after its row was rewritten in place?';

-- zz.doc_link: who made a citation a cause. Null records no origin: every citation filed before
-- this column (read as `agent`), and a plain citation that is not a cause. A support is never one.
ALTER TABLE zz.doc_link ADD COLUMN linked_by text;

ALTER TABLE zz.doc_link ADD CONSTRAINT doc_link_linked_by_check CHECK ((linked_by = ANY (ARRAY['agent'::text, 'platform'::text])));

ALTER TABLE zz.doc_link ADD CONSTRAINT doc_link_linked_by_cites CHECK (((linked_by IS NULL) OR (kind = 'cites'::text)));

COMMENT ON COLUMN zz.doc_link.linked_by IS 'class=relation; authority=this; question=did the writer name this citation as a cause, or did the platform link an owed source itself, null for a citation that records no origin, filed before origins were recorded or not filed as a cause?';

-- zz.doc_request: one keyed change and the reply it got. Keyed by path, not by document, so a
-- create's replay is found before the document it made exists.
CREATE TABLE zz.doc_request (
    team_id uuid NOT NULL,
    principal_id uuid NOT NULL,
    canonical_path text NOT NULL,
    request_id text NOT NULL,
    doc_id uuid,
    request_digest text NOT NULL,
    receipt jsonb NOT NULL,
    committed_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE zz.doc_request OWNER TO zz;

ALTER TABLE ONLY zz.doc_request
    ADD CONSTRAINT doc_request_pkey PRIMARY KEY (team_id, principal_id, canonical_path, request_id);

ALTER TABLE ONLY zz.doc_request
    ADD CONSTRAINT doc_request_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES zz.doc(id) ON DELETE CASCADE;

ALTER TABLE ONLY zz.doc_request
    ADD CONSTRAINT doc_request_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id);

ALTER TABLE ONLY zz.doc_request
    ADD CONSTRAINT doc_request_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id);

CREATE INDEX doc_request_doc_id ON zz.doc_request USING btree (doc_id);

COMMENT ON TABLE zz.doc_request IS 'class=immutable_history; authority=this; question=which keyed change did this caller already commit to this path, and what reply did it get, so a retry replays it rather than changing the document twice?; retention=kept for the life of the document it names and removed with it by cascade; no sweep, because a replay must keep answering';

COMMENT ON COLUMN zz.doc_request.team_id IS 'class=relation; authority=this; question=which team''s store was the request made in, the first component of its key?';

COMMENT ON COLUMN zz.doc_request.principal_id IS 'class=relation; authority=this; question=which principal made the request, so one caller''s key never replays another''s reply?';

COMMENT ON COLUMN zz.doc_request.canonical_path IS 'class=immutable_history; authority=this; question=which document path, as the platform canonicalises it, was the request about, so a create''s replay is found before the document exists?';

COMMENT ON COLUMN zz.doc_request.request_id IS 'class=immutable_history; authority=this; question=what key did the caller give this change, to be reused across retries of the same intent?';

COMMENT ON COLUMN zz.doc_request.doc_id IS 'class=relation; authority=this; question=which document did the request resolve to, null until a request names a document that never came to exist?';

COMMENT ON COLUMN zz.doc_request.request_digest IS 'class=immutable_history; authority=this; question=what digest of the canonical request was committed under this key, so the same key with a different request is refused?';

COMMENT ON COLUMN zz.doc_request.receipt IS 'class=immutable_history; authority=this; question=what reply did the committed request get, replayed verbatim to a retry with the same key?';

COMMENT ON COLUMN zz.doc_request.committed_at IS 'class=immutable_history; authority=this; question=when did the request commit?';

-- zz.cause_link_epoch: the instant automatic causes start, which is the instant this file runs. A
-- source filed before it is never owed to a document as a cause (stakeholder decision, spec v6).
-- One row; the unique index on a constant refuses a second.
CREATE TABLE zz.cause_link_epoch (
    epoch timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE zz.cause_link_epoch OWNER TO zz;

CREATE UNIQUE INDEX cause_link_epoch_one ON zz.cause_link_epoch USING btree ((true));

INSERT INTO zz.cause_link_epoch DEFAULT VALUES;

COMMENT ON TABLE zz.cause_link_epoch IS 'class=current_state; authority=this; question=from which instant are sources filed in an initiative linked automatically as causes of the documents they support, so a source filed before automatic causes existed is never owed?';

COMMENT ON COLUMN zz.cause_link_epoch.epoch IS 'class=current_state; authority=this; question=at what instant did automatic cause linking begin on this deployment?';

-- zz.event: a change's complete details live on its own `document.*` row, under the
-- `detail.details_ref` its receipt prints. The index finds that row; the table comment states that a
-- `document.*` row is kept as long as the audit kinds, so a reference a receipt printed never
-- dangles, and that a row written in its change's transaction fails the change when it fails; the
-- column comment names what such a row's detail carries. None of it moves a row.
CREATE INDEX event_details_ref ON zz.event USING btree (((detail ->> 'details_ref'::text))) WHERE (detail ? 'details_ref'::text);

COMMENT ON TABLE zz.event IS 'class=immutable_history; authority=this; question=what did the platform do or get asked to do, one append-only timestamped act — a tool call at a door, an admin act, a document act, a knowledge-journal act or a sign-in — the only fallback being /data/events-unwritten.jsonl when a write fails, except a document.* row written in the transaction of the change it records, whose failed insert fails that change?; retention=audit kinds (admin.*, credential.*, console.*, team.*, bug.*, pkg.download) and document.* kinds, whose rows carry the complete details a change receipt names, are kept indefinitely; tool_call and knowledge.* may age out once volume requires it, except a row an evaluation cites';

COMMENT ON COLUMN zz.event.detail IS 'class=immutable_history; authority=this; question=what open extra payload this act carries — the caller hash, client, argument names, ids, shapes and step_sha — now that run has moved to session and the ms and bytes keys have backfilled duration_ms and response_bytes, and on a document.* row the details_ref and details a change receipt names, the complete detail of that change to its document: section headings, cause paths, normalisations and diagnostics?';
