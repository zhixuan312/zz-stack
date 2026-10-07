-- 002_document_versions.sql — public versions, the content generation and each snapshot's own,
-- cause links, request records, the cause-link epoch, the activity record's details, and staged
-- uploads.
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
--
-- The release before this file cannot run on what it builds: its revision insert names no
-- `version`, and it labels a snapshot id as the public version. `scripts/release/rollback-guard.ts`
-- reads the line below and refuses a rollback across this file; the fold removes the line with it.
-- rollback: refused — the previous release inserts revisions without the NOT NULL version column, so every write it makes fails, and it shows a snapshot id as the public version

-- zz.doc_revision: the public version of each snapshot.
ALTER TABLE zz.doc_revision ADD COLUMN version integer;

UPDATE zz.doc_revision SET version = revision;

ALTER TABLE zz.doc_revision ALTER COLUMN version SET NOT NULL;

ALTER TABLE zz.doc_revision ADD CONSTRAINT doc_revision_version_positive CHECK ((version >= 1));

CREATE INDEX doc_revision_version ON zz.doc_revision USING btree (doc_id, version);

COMMENT ON COLUMN zz.doc_revision.version IS 'class=state_machine; authority=this; question=which public version of the document does this snapshot belong to, the number a reader asks for while revision stays the snapshot every pin names?';

-- zz.doc_revision: the content generation each snapshot carries, so a presented or approved one is
-- named by its own content revision. DELIBERATE: no backfill. A superseded row's generation cannot
-- be derived after the fact — a rewrite in place moved the document's counter without a row — so a
-- row written before this file has none; a current row with none takes doc.content_generation on
-- read, which describes the same content, and the first rewrite stamps it.
ALTER TABLE zz.doc_revision ADD COLUMN content_generation bigint;

COMMENT ON COLUMN zz.doc_revision.content_generation IS 'class=state_machine; authority=this; question=which content generation of its document do this revision''s body and editable metadata carry, the one its own content_revision names, null for a revision last written before generations were recorded per revision?';

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

COMMENT ON COLUMN zz.event.detail IS 'class=immutable_history; authority=this; question=what open extra payload this act carries — the caller hash, client, argument names, ids, shapes and step_sha — now that run has moved to session and the ms and bytes keys have backfilled duration_ms and response_bytes, and on a document.* row the details_ref and details a change receipt names, the complete detail of that change to its document: section headings, cause paths, normalisations and diagnostics; and on a document.shown or document.shown_part row the review_context, target and baseline content revisions, kind, page span, credential, text_chars and meta_bytes a presentation''s coverage is computed from?';

-- zz.upload: one file on its way into a document or a source. zz-core's upload_start mints the row,
-- the gateway's staging route binds the bytes once (`where sha256 is null`), and zz-core's consuming
-- write marks it consumed and removes the body in its own commit. A row is kept without its body, so
-- a consumed id is never new again; the gateway's hourly sweep removes the body of one that expired unused.
CREATE TABLE zz.upload (
    id text NOT NULL,
    team_id uuid NOT NULL,
    principal_id uuid NOT NULL,
    filename text NOT NULL,
    link_secret_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:15:00'::interval) NOT NULL,
    byte_count integer,
    sha256 text,
    body bytea,
    staged_via text,
    staged_by uuid,
    consumed_at timestamp with time zone,
    consumed_by_operation text,
    consumed_digest text,
    CONSTRAINT upload_body_staged CHECK (((body IS NULL) OR ((sha256 IS NOT NULL) AND (consumed_at IS NULL)))),
    CONSTRAINT upload_byte_count_check CHECK (((byte_count >= 0) AND (byte_count <= 8388608))),
    CONSTRAINT upload_expires_after_created CHECK ((expires_at > created_at)),
    CONSTRAINT upload_filename_check CHECK (((length(filename) >= 1) AND (length(filename) <= 255) AND (strpos(filename, '/'::text) = 0))),
    CONSTRAINT upload_id_check CHECK ((id ~ '^up_[a-z2-7]{26}$'::text)),
    CONSTRAINT upload_link_secret_hash_check CHECK ((link_secret_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT upload_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT upload_staged_by_follows CHECK (((staged_by IS NULL) = ((staged_via IS NULL) OR (staged_via = 'link'::text)))),
    CONSTRAINT upload_staged_via_check CHECK ((staged_via = ANY (ARRAY['token'::text, 'link'::text]))),
    CONSTRAINT upload_staged_whole CHECK ((((sha256 IS NULL) = (byte_count IS NULL)) AND ((sha256 IS NULL) = (staged_via IS NULL)))),
    CONSTRAINT upload_consumed_staged CHECK (((consumed_at IS NULL) OR (sha256 IS NOT NULL))),
    CONSTRAINT upload_consumed_whole CHECK ((((consumed_at IS NULL) = (consumed_by_operation IS NULL)) AND ((consumed_at IS NULL) = (consumed_digest IS NULL))))
);

ALTER TABLE zz.upload OWNER TO zz;

ALTER TABLE ONLY zz.upload
    ADD CONSTRAINT upload_pkey PRIMARY KEY (id);

ALTER TABLE ONLY zz.upload
    ADD CONSTRAINT upload_link_secret_hash_key UNIQUE (link_secret_hash);

ALTER TABLE ONLY zz.upload
    ADD CONSTRAINT upload_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id);

ALTER TABLE ONLY zz.upload
    ADD CONSTRAINT upload_staged_by_fkey FOREIGN KEY (staged_by) REFERENCES zz.principal(id);

ALTER TABLE ONLY zz.upload
    ADD CONSTRAINT upload_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id);

CREATE INDEX upload_sweep ON zz.upload USING btree (expires_at) WHERE (body IS NOT NULL);

COMMENT ON TABLE zz.upload IS 'class=state_machine; authority=this; question=which plain-text file has a principal begun to upload for which team, which bytes were staged for it and through which route, and which write consumed it?; transitions=minted->staged, staged->consumed, minted->expired, staged->expired; retention=kept without its body after consumption or expiry, so a consumed id is never new again; the consuming write removes the body in its own commit, and the gateway''s hourly sweep removes the body of an upload that expired unused; the staging window is 15 minutes';

COMMENT ON COLUMN zz.upload.id IS 'class=state_machine; authority=this; question=what is this upload''s opaque identity, up_ and 26 base32 characters of 128 random bits, the id upload_start answers and a write consumes?';

COMMENT ON COLUMN zz.upload.team_id IS 'class=relation; authority=this; question=which team was the upload started for, the only team a write may consume it in?';

COMMENT ON COLUMN zz.upload.principal_id IS 'class=relation; authority=this; question=which principal started the upload, the only one whose token may stage it or whose write may consume it?';

COMMENT ON COLUMN zz.upload.filename IS 'class=state_machine; authority=this; question=what filename did upload_start record, the one whose extension decides the plain-text family and governs every staging?';

COMMENT ON COLUMN zz.upload.link_secret_hash IS 'class=ephemeral; authority=this; question=what is the sha256 of this upload''s staging link secret, the capability that stages this one upload and nothing else?';

COMMENT ON COLUMN zz.upload.created_at IS 'class=state_machine; authority=this; question=when was the upload started?';

COMMENT ON COLUMN zz.upload.expires_at IS 'class=state_machine; authority=this; question=when does this upload''s fifteen-minute window end, after which it is neither staged nor newly consumed?';

COMMENT ON COLUMN zz.upload.byte_count IS 'class=state_machine; authority=this; question=how many bytes did the first staging bind, null until staged?';

COMMENT ON COLUMN zz.upload.sha256 IS 'class=state_machine; authority=this; question=what is the sha256 hex of the bytes the first staging bound, which no later staging may change, null until staged?';

COMMENT ON COLUMN zz.upload.body IS 'class=ephemeral; authority=this; question=what bytes are staged and not yet consumed, removed by the consuming write or once the upload expires unused?';

COMMENT ON COLUMN zz.upload.staged_via IS 'class=state_machine; authority=this; question=which route staged the bytes — token (the person''s own token) or link (the staging link) — null until staged?';

COMMENT ON COLUMN zz.upload.staged_by IS 'class=relation; authority=this; question=which principal''s credential staged the bytes, null for a link staging, which authenticates nobody, and until staged?';

COMMENT ON COLUMN zz.upload.consumed_at IS 'class=state_machine; authority=this; question=when did a write consume this upload, null until consumed?';

COMMENT ON COLUMN zz.upload.consumed_by_operation IS 'class=state_machine; authority=this; question=which operation consumed this upload — the tool and the path it wrote — null until consumed?';

COMMENT ON COLUMN zz.upload.consumed_digest IS 'class=state_machine; authority=this; question=which request digest did the consuming write carry, so its keyed replay is the same consumption rather than a second one, null until consumed?';
