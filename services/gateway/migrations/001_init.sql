-- 001_init.sql — the whole schema, as one file. The migrations it replaced are in git history.
--
-- DELIBERATE: the name is load-bearing and must not change. `services/gateway/src/db.ts` records
-- each file it applies in `zz.schema_migration` by name and skips what that table already lists.
-- Every deployment that ran the old 001 carries the row `001_init.sql`, so every one of them
-- skips this file and keeps the schema it already built; a fresh database has no such row and
-- gets the whole thing in one transaction. Renaming this file re-runs it against every live
-- deployment. There is no baseline marker, no version table beside the ledger, and no branch
-- choosing between the two — the ledger is the mechanism.
--
-- DELIBERATE: the extensions come first and are declared. pg_dump does not emit them (they
-- install into this schema but belong to the database) so they are written back here with the
-- directives the runner reads. A cluster that cannot supply one defers this file rather than
-- failing half-applied; db.ts does not record a deferred file, which is what lets it be
-- retried.
--
-- COUPLED: the files this one absorbed. A deployment that ran them carries their names in
-- `zz.schema_migration`, and `scripts/doctor/layers/data.ts` counts each name listed here as
-- covered by this file rather than as an applied migration that no longer exists. The rows
-- stay: a rollback to a release that still carries those files must find them applied.
--
-- absorbs: 002_comments.sql
-- absorbs: 003_flow_manifest.sql
-- absorbs: 004_flow_install_clients.sql
-- absorbs: 005_doc_body_and_title.sql
-- absorbs: 006_doc_content_hash.sql
-- absorbs: 007_drop_platform_credential.sql
-- absorbs: 008_drop_doc_type_status.sql
-- absorbs: 009_drop_doc_team_path.sql
-- absorbs: 010_active_team.sql
-- absorbs: 011_decision.sql
-- absorbs: 012_drop_comment.sql
-- absorbs: 013_doc_created_at.sql
-- absorbs: 014_event_columns.sql
-- absorbs: 015_doc_decision.sql
-- absorbs: 016_reference.sql
-- absorbs: 017_initiative_run.sql
-- absorbs: 018_doc_attribution.sql
-- absorbs: 019_eval.sql
-- absorbs: 020_event_attribution.sql
-- absorbs: 021_delegated_tokens.sql
-- absorbs: 022_console_session.sql
-- absorbs: 023_doc_supports.sql
-- absorbs: 024_block_origin.sql
-- absorbs: 025_version_released_at.sql
-- absorbs: 026_skill_kind_two_values.sql
-- absorbs: 027_skill_retired.sql
-- absorbs: 028_eval_score_halves.sql
-- absorbs: 029_eval_subject_runs.sql
-- absorbs: 030_skill_version_body_hash.sql
-- absorbs: 031_run_without_initiative.sql
-- absorbs: 032_rubric_subject.sql
-- absorbs: 033_eval_is_control.sql
-- absorbs: 034_block_title.sql
-- absorbs: 035_doc_blocks.sql
-- absorbs: 036_run_follows_initiative.sql
-- absorbs: 037_principal_password.sql
-- absorbs: 038_console_session_door.sql
-- absorbs: 039_discussion.sql
-- absorbs: 040_mcp_oauth.sql
-- absorbs: 041_oauth_resume.sql
-- absorbs: 042_event_team_backfill.sql
-- absorbs: 043_drop_password_door.sql
-- absorbs: 044_passkey.sql
-- absorbs: 045_drop_flow_install_clients.sql
-- absorbs: 046_delete_phantom_runs.sql
-- absorbs: 047_plugin_eval.sql
-- absorbs: 048_drop_skill_eval.sql
-- absorbs: 049_drop_initiative_closed_at.sql
-- absorbs: 050_record_and_cost.sql
-- absorbs: 051_run_bytes_nullable.sql
-- absorbs: 052_block_tool_door.sql
-- absorbs: 053_drop_pat_scope.sql
-- absorbs: 054_drop_initiative_deleted_at.sql
-- absorbs: 055_case_run_initiative.sql
-- absorbs: 056_bug.sql
-- absorbs: 057_drop_third_party_blocks.sql
-- absorbs: 058_plugin_owns_its_surface.sql
-- absorbs: 059_knowledge_is_its_own_subject.sql
-- absorbs: 060_no_install_registry.sql
-- absorbs: 061_refusal_owner.sql
-- absorbs: 062_typed_judgments.sql
-- absorbs: 063_control_names_its_round.sql
-- absorbs: 064_the_case_half_is_gone.sql
-- absorbs: 065_model_call_attempts_and_confusion.sql
-- absorbs: 066_a_line_names_its_figure_and_a_finding_gets_decided.sql
-- absorbs: 067_a_round_says_where_it_came_from_and_what_it_scored.sql
-- absorbs: 068_two_axes_and_no_verdict.sql
-- absorbs: 069_no_step_is_empty_and_a_run_is_indexed.sql
-- absorbs: 070_artifacts_revisions_events_and_scoped_search.sql
-- absorbs: 071_a_source_has_no_content_revision.sql
-- absorbs: 072_write_path_records_its_analyzer.sql
-- absorbs: 073_a_run_is_where_the_control_loop_keeps_what_it_was_told.sql
-- absorbs: 074_a_later_fact_can_withdraw_an_earlier_one.sql
--
-- requires-extension: citext
-- requires-extension: pg_textsearch
-- requires-extension: pg_trgm

create extension if not exists citext with schema zz;
create extension if not exists pg_textsearch with schema zz;
create extension if not exists pg_trgm with schema zz;

--
-- Name: artifact; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.artifact (
    owner_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    artifact_class text NOT NULL,
    current_path text NOT NULL,
    current_revision integer,
    content_hash text NOT NULL,
    head_event_sequence integer NOT NULL,
    created_at timestamp with time zone,
    audience text,
    profile text,
    CONSTRAINT artifact_artifact_class_check CHECK ((artifact_class = ANY (ARRAY['source'::text, 'work_document'::text, 'knowledge_concept'::text]))),
    CONSTRAINT artifact_current_revision_check CHECK (((current_revision IS NULL) OR (current_revision > 0))),
    CONSTRAINT artifact_head_event_sequence_check CHECK ((head_event_sequence > 0))
);


--
-- Name: artifact_edge; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.artifact_edge (
    source_owner_id uuid NOT NULL,
    source_artifact_id uuid NOT NULL,
    source_revision integer,
    kind text NOT NULL,
    target_owner_id uuid NOT NULL,
    target_artifact_id uuid NOT NULL,
    target_revision integer,
    target_hash text NOT NULL,
    citation_id text,
    asserted_event_id uuid NOT NULL,
    retracted_event_id uuid,
    CONSTRAINT artifact_edge_kind_check CHECK ((kind = ANY (ARRAY['derived_from'::text, 'cites'::text, 'revision_of'::text, 'supersedes'::text]))),
    CONSTRAINT artifact_edge_source_revision_check CHECK (((source_revision IS NULL) OR (source_revision > 0))),
    CONSTRAINT artifact_edge_target_revision_check CHECK (((target_revision IS NULL) OR (target_revision > 0)))
);


--
-- Name: artifact_event; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.artifact_event (
    event_id uuid NOT NULL,
    transaction_id text NOT NULL,
    owner_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    sequence integer NOT NULL,
    at timestamp with time zone NOT NULL,
    actor text NOT NULL,
    kind text NOT NULL,
    revision integer,
    content_hash text NOT NULL,
    cause_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT artifact_event_kind_check CHECK ((kind = ANY (ARRAY['created'::text, 'revised'::text, 'approved'::text, 'verified'::text, 'status_changed'::text, 'moved'::text, 'input_attached'::text, 'input_dispositioned'::text, 'provenance_corrected'::text, 'superseded'::text, 'published'::text, 'unpublished'::text, 'legacy_imported'::text]))),
    CONSTRAINT artifact_event_revision_check CHECK (((revision IS NULL) OR (revision > 0))),
    CONSTRAINT artifact_event_sequence_check CHECK ((sequence > 0))
);


--
-- Name: artifact_identifier; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.artifact_identifier (
    id bigint NOT NULL,
    owner_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    revision integer NOT NULL,
    scope text NOT NULL,
    corpus_key text NOT NULL,
    passage_id bigint NOT NULL,
    identifier_text text NOT NULL,
    normalized_text text NOT NULL,
    CONSTRAINT artifact_identifier_revision_check CHECK ((revision > 0)),
    CONSTRAINT artifact_identifier_scope_check CHECK ((scope = ANY (ARRAY['current'::text, 'evidence'::text, 'history'::text])))
);


--
-- Name: artifact_identifier_id_seq; Type: SEQUENCE; Schema: zz; Owner: -
--

ALTER TABLE zz.artifact_identifier ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME zz.artifact_identifier_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: artifact_passage; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.artifact_passage (
    id bigint NOT NULL,
    owner_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    revision integer NOT NULL,
    scope text NOT NULL,
    corpus_key text NOT NULL,
    ordinal integer NOT NULL,
    byte_start integer NOT NULL,
    byte_end integer NOT NULL,
    raw_text text NOT NULL,
    analyzed_text text NOT NULL,
    analyzer_version text NOT NULL,
    CONSTRAINT artifact_passage_byte_start_check CHECK ((byte_start >= 0)),
    CONSTRAINT artifact_passage_check CHECK ((byte_end >= byte_start)),
    CONSTRAINT artifact_passage_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT artifact_passage_revision_check CHECK ((revision > 0)),
    CONSTRAINT artifact_passage_scope_check CHECK ((scope = ANY (ARRAY['current'::text, 'evidence'::text, 'history'::text])))
);


--
-- Name: artifact_passage_id_seq; Type: SEQUENCE; Schema: zz; Owner: -
--

ALTER TABLE zz.artifact_passage ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME zz.artifact_passage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: artifact_projection_commit; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.artifact_projection_commit (
    owner_id uuid NOT NULL,
    transaction_id text NOT NULL,
    sequence integer NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT artifact_projection_commit_sequence_check CHECK ((sequence > 0))
);


--
-- Name: artifact_projection_watermark; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.artifact_projection_watermark (
    owner_id uuid NOT NULL,
    head_sequence integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT artifact_projection_watermark_head_sequence_check CHECK ((head_sequence >= 0))
);


--
-- Name: artifact_revision; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.artifact_revision (
    owner_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    revision integer NOT NULL,
    content_hash text NOT NULL,
    payload jsonb NOT NULL,
    cause_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    sources jsonb DEFAULT '[]'::jsonb NOT NULL,
    generated_by text,
    generated_at timestamp with time zone,
    origin_profile text NOT NULL,
    legacy_unresolved_sources jsonb DEFAULT '[]'::jsonb NOT NULL,
    previous_revision integer,
    CONSTRAINT artifact_revision_origin_profile_check CHECK ((origin_profile = ANY (ARRAY['native'::text, 'legacy_import'::text]))),
    CONSTRAINT artifact_revision_previous_revision_check CHECK (((previous_revision IS NULL) OR (previous_revision > 0))),
    CONSTRAINT artifact_revision_revision_check CHECK ((revision > 0))
);


--
-- Name: bug; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.bug (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reported_at timestamp with time zone DEFAULT now() NOT NULL,
    reported_by text NOT NULL,
    team_slug text,
    title text NOT NULL,
    detail text NOT NULL,
    surface text,
    initiative text,
    platform_version text,
    impact text DEFAULT 'wrong_result'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    resolution text,
    resolved_by text,
    resolved_at timestamp with time zone,
    CONSTRAINT bug_impact_check CHECK ((impact = ANY (ARRAY['blocks_work'::text, 'wrong_result'::text, 'confusing'::text, 'cosmetic'::text]))),
    CONSTRAINT bug_resolved_says_why CHECK ((((status = 'open'::text) AND (resolution IS NULL) AND (resolved_by IS NULL) AND (resolved_at IS NULL)) OR ((status <> 'open'::text) AND (resolution IS NOT NULL) AND (resolved_by IS NOT NULL) AND (resolved_at IS NOT NULL)))),
    CONSTRAINT bug_status_check CHECK ((status = ANY (ARRAY['open'::text, 'fixed'::text, 'not_a_bug'::text, 'duplicate'::text])))
);


--
-- Name: TABLE bug; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON TABLE zz.bug IS 'Bugs reported by the people using this platform. Written by bug_report on /core, read by bug_list, closed by bug_resolve. Not knowledge (a report needs no evidence) and not an event (an event has no author).';


--
-- Name: console_session; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.console_session (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    principal_id uuid NOT NULL,
    token_hash text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    user_agent text,
    ip text
);


--
-- Name: control_evidence; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.control_evidence (
    seq bigint NOT NULL,
    run_id uuid NOT NULL,
    entry_id text NOT NULL,
    step_id text NOT NULL,
    kind text NOT NULL,
    about text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_by text,
    supersedes text
);


--
-- Name: control_evidence_seq_seq; Type: SEQUENCE; Schema: zz; Owner: -
--

CREATE SEQUENCE zz.control_evidence_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: control_evidence_seq_seq; Type: SEQUENCE OWNED BY; Schema: zz; Owner: -
--

ALTER SEQUENCE zz.control_evidence_seq_seq OWNED BY zz.control_evidence.seq;


--
-- Name: control_run; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.control_run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_slug text NOT NULL,
    initiative text NOT NULL,
    module_id text NOT NULL,
    module_digest text NOT NULL,
    subject text NOT NULL,
    profile jsonb DEFAULT '[]'::jsonb NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    started_by text
);


--
-- Name: control_waiver; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.control_waiver (
    seq bigint NOT NULL,
    run_id uuid NOT NULL,
    step_id text NOT NULL,
    kind text NOT NULL,
    ground text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_by text
);


--
-- Name: control_waiver_seq_seq; Type: SEQUENCE; Schema: zz; Owner: -
--

CREATE SEQUENCE zz.control_waiver_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: control_waiver_seq_seq; Type: SEQUENCE OWNED BY; Schema: zz; Owner: -
--

ALTER SEQUENCE zz.control_waiver_seq_seq OWNED BY zz.control_waiver.seq;


--
-- Name: decision; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.decision (
    team_slug text NOT NULL,
    initiative text NOT NULL,
    path text NOT NULL,
    role text NOT NULL,
    key text NOT NULL,
    verdict text DEFAULT ''::text NOT NULL,
    qualifier text DEFAULT ''::text NOT NULL,
    detail text DEFAULT ''::text NOT NULL,
    checker text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    doc_id uuid,
    CONSTRAINT decision_verdict_closed CHECK ((verdict = ANY (ARRAY[''::text, 'native'::text, 'achievable'::text, 'workaround'::text, 'not_possible'::text])))
);


--
-- Name: discussion_message; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.discussion_message (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_slug text NOT NULL,
    initiative text NOT NULL,
    doc_path text NOT NULL,
    seq integer NOT NULL,
    principal_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: doc; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.doc (
    team_slug text NOT NULL,
    initiative text NOT NULL,
    path text NOT NULL,
    flow text DEFAULT ''::text NOT NULL,
    type text DEFAULT ''::text NOT NULL,
    status text DEFAULT ''::text NOT NULL,
    outcome text,
    approved_by text,
    approved_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL,
    body_tsv tsvector,
    body text DEFAULT ''::text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    evidence text[] DEFAULT '{}'::text[] NOT NULL,
    superseded_by text,
    content_hash text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_by text,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    initiative_id uuid,
    produced_by_run_id uuid,
    supports text,
    analyzer_version text,
    CONSTRAINT doc_outcome_closed CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['delivered'::text, 'accepted'::text, 'abandoned'::text])))),
    CONSTRAINT doc_status_closed CHECK ((status = ANY (ARRAY[''::text, 'draft'::text, 'approved'::text, 'adopted'::text, 'superseded'::text])))
);


--
-- Name: COLUMN doc.approved_by; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.approved_by IS 'The one signature field. A person, never a team slug, "the user" or "the agent" — and
   stamped by approve() / close() from the session, never typed by a model.';


--
-- Name: COLUMN doc.created_at; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.doc.created_at IS 'When this document first existed. Never moves. `updated_at` is the last write; this is the
   first, and it is what scopes a measurement to one initiative''s lifetime.';


--
-- Name: doc_artifact; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.doc_artifact (
    team_slug text NOT NULL,
    initiative text NOT NULL,
    path text NOT NULL,
    owner_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    current_revision integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT doc_artifact_current_revision_check CHECK ((current_revision > 0))
);


--
-- Name: eval; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rubric_id uuid NOT NULL,
    judge_model text DEFAULT ''::text NOT NULL,
    selection_note text DEFAULT ''::text NOT NULL,
    doc_count integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    is_control boolean DEFAULT false NOT NULL,
    plugin_version_id uuid NOT NULL,
    controls uuid,
    initiative text,
    team_slug text,
    effectiveness numeric,
    headroom_points numeric,
    headroom_named integer,
    headroom_state text
);


--
-- Name: COLUMN eval.initiative; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval.initiative IS 'The initiative this round was run inside — stamped by round_judge from its caller, never inferred from a name or a date. Null on rounds taken before migration 067.';


--
-- Name: COLUMN eval.effectiveness; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval.effectiveness IS '0-10, as judge-score.ts computed it at round_recommend. Null when the round was void (a collapsed control), and null on rounds taken before migration 067.';


--
-- Name: COLUMN eval.headroom_state; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval.headroom_state IS 'One of: no change needed, change identified, unexplained gap, not measured. The second axis. It reports what the evidence says about the gap and prescribes nothing — whether a change CAN be made is not something a score establishes.';


--
-- Name: eval_finding; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_finding (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    eval_id uuid NOT NULL,
    pattern text NOT NULL,
    docs_affected integer DEFAULT 0 NOT NULL,
    scope text NOT NULL,
    proposed_change text DEFAULT ''::text NOT NULL,
    decision text DEFAULT 'deferred'::text NOT NULL,
    resulted_in_skill_version_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_by text,
    decided_at timestamp with time zone,
    decision_note text DEFAULT ''::text NOT NULL,
    CONSTRAINT eval_finding_decision_check CHECK ((decision = ANY (ARRAY['applied'::text, 'rejected'::text, 'deferred'::text]))),
    CONSTRAINT eval_finding_scope_check CHECK ((scope = ANY (ARRAY['generic'::text, 'specific'::text])))
);


--
-- Name: COLUMN eval_finding.decision_note; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_finding.decision_note IS 'Why it was applied or rejected. Empty while deferred -- the open state needs no reason, and the two closed ones do.';


--
-- Name: eval_score; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_score (
    eval_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    dimension_id uuid NOT NULL,
    score numeric(2,1) NOT NULL,
    quote text DEFAULT ''::text NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    is_control boolean DEFAULT false NOT NULL,
    confidence numeric,
    probabilities jsonb,
    CONSTRAINT eval_score_score_check CHECK (((score >= (1)::numeric) AND (score <= (5)::numeric)))
);


--
-- Name: COLUMN eval_score.score; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_score.score IS 'One dimension, 1.0-5.0. Halves allowed: a judge who means 4.5 must not be recorded as 5.';


--
-- Name: eval_subject; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.eval_subject (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    eval_id uuid NOT NULL,
    team_id uuid,
    initiative_slug text NOT NULL,
    path text,
    content_hash text DEFAULT ''::text NOT NULL,
    git_commit text DEFAULT ''::text NOT NULL,
    doc_id uuid,
    evaluated_at timestamp with time zone DEFAULT now() NOT NULL,
    run_id uuid,
    plugin_version_id uuid,
    CONSTRAINT eval_subject_names_its_subject CHECK ((((path IS NOT NULL) AND (run_id IS NULL)) OR ((path IS NULL) AND (run_id IS NOT NULL))))
);


--
-- Name: COLUMN eval_subject.run_id; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.eval_subject.run_id IS 'The window of work judged, when a skill produces no document. Exactly one of path/run_id.';


--
-- Name: event; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.event (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    actor text NOT NULL,
    team_slug text,
    kind text NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    initiative text,
    flow text,
    step text,
    step_version text,
    ok boolean,
    refusal text,
    run_id uuid,
    team_id uuid,
    duration_ms integer,
    request_bytes integer,
    response_bytes integer,
    batched boolean DEFAULT false NOT NULL,
    plugin text,
    plugin_version text,
    tool_key text,
    refusal_owner text
);


--
-- Name: COLUMN event.initiative; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.initiative IS 'Join key to zz.doc and zz.decision. Carried forward per caller from the last call that named
   one, because most calls do not take it as an argument.';


--
-- Name: COLUMN event.flow; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.flow IS 'The flow the call''s initiative runs, as declared at initiative_open; empty for a call made outside any initiative. Not attribution: use plugin / plugin_version for which plugin owns this call.';


--
-- Name: COLUMN event.step; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.step IS 'The skill this call was following, or NULL when none was. Never the empty string: `??` does not coalesce it, so an empty step reaches this column verbatim and is unjoinable to zz.skill while still looking like a value. Producers say unknown by omitting the field.';


--
-- Name: COLUMN event.step_version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.step_version IS 'The version declared by the skill that was served WHOLE, or NULL. A supporting file beside a skill carries no version, and that is recorded as NULL rather than as an empty string, for the same reason as step.';


--
-- Name: COLUMN event.ok; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.ok IS 'Whether the call worked, in the platform''s own terms — never a transport status. An MCP
   tool that refuses answers HTTP 200 with ERROR: in its text.';


--
-- Name: COLUMN event.plugin; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.plugin IS 'Which plugin owns the skill the caller had loaded, resolved through zz.plugin_version_skill from currentStep() — never from flow_install and never from the x-zz-client header. Null when no skill was loaded, or the step names none that a plugin has released.';


--
-- Name: COLUMN event.plugin_version; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.plugin_version IS 'The released version of `plugin` that shipped the skill version the caller was on. Null exactly when plugin is null.';


--
-- Name: COLUMN event.tool_key; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.event.tool_key IS 'The alias-resolved `<surface>:<tool>` name (Task I-2''s resolver), so a row written after this column existed already reads as one series across a rename with no further lookup.';


--
-- Name: event_id_seq; Type: SEQUENCE; Schema: zz; Owner: -
--

ALTER TABLE zz.event ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME zz.event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: initiative; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.initiative (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    slug text NOT NULL,
    flow text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: knowledge_node; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.knowledge_node (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_slug text NOT NULL,
    path text NOT NULL,
    kind text NOT NULL,
    lifecycle text DEFAULT 'adopted'::text NOT NULL,
    superseded_by text,
    title text DEFAULT ''::text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    body_tsv tsvector,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    evidence text[] DEFAULT '{}'::text[] NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    analyzer_version text,
    CONSTRAINT knowledge_node_kind_check CHECK ((kind = ANY (ARRAY['decision'::text, 'design'::text, 'process'::text, 'knowledge'::text, 'behavior'::text, 'style'::text]))),
    CONSTRAINT knowledge_node_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['adopted'::text, 'superseded'::text])))
);


--
-- Name: knowledge_node_artifact; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.knowledge_node_artifact (
    team_slug text NOT NULL,
    path text NOT NULL,
    owner_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    current_revision integer NOT NULL,
    origin_profile text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_node_artifact_current_revision_check CHECK ((current_revision > 0)),
    CONSTRAINT knowledge_node_artifact_origin_profile_check CHECK ((origin_profile = ANY (ARRAY['native'::text, 'legacy_import'::text])))
);


--
-- Name: mcp_oauth_authz; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.mcp_oauth_authz (
    id text NOT NULL,
    client_id text NOT NULL,
    principal_id uuid,
    redirect_uri text NOT NULL,
    code_challenge text NOT NULL,
    state text DEFAULT ''::text NOT NULL,
    resource text DEFAULT ''::text NOT NULL,
    used boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mcp_oauth_client; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.mcp_oauth_client (
    client_id text NOT NULL,
    redirect_uris jsonb NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: membership; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.membership (
    team_id uuid NOT NULL,
    principal_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    added_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT membership_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text])))
);


--
-- Name: model_call; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.model_call (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    event_id bigint,
    plugin text,
    purpose text NOT NULL,
    model text NOT NULL,
    input_tokens integer,
    output_tokens integer,
    cache_read_tokens integer,
    duration_ms integer,
    ok boolean NOT NULL,
    attempts integer DEFAULT 1 NOT NULL,
    confidence numeric,
    note text
);


--
-- Name: model_call_id_seq; Type: SEQUENCE; Schema: zz; Owner: -
--

ALTER TABLE zz.model_call ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME zz.model_call_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: passkey; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.passkey (
    id text NOT NULL,
    principal_id uuid NOT NULL,
    public_key bytea NOT NULL,
    counter bigint DEFAULT 0 NOT NULL,
    transports text[],
    label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);


--
-- Name: passkey_challenge; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.passkey_challenge (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    challenge text NOT NULL,
    kind text NOT NULL,
    principal_id uuid,
    redirect_to text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT passkey_challenge_kind_check CHECK ((kind = ANY (ARRAY['register'::text, 'login'::text])))
);


--
-- Name: passkey_enrolment; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.passkey_enrolment (
    token_hash text NOT NULL,
    principal_id uuid NOT NULL,
    issued_by uuid,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pat; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.pat (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    principal_id uuid NOT NULL,
    token_hash text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    team_id uuid,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: plugin; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.plugin (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    origin text NOT NULL,
    CONSTRAINT plugin_origin_check CHECK ((origin = ANY (ARRAY['platform'::text, 'third_party'::text])))
);


--
-- Name: plugin_tool; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.plugin_tool (
    plugin_version_id uuid NOT NULL,
    name text NOT NULL,
    door text NOT NULL
);


--
-- Name: plugin_version; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.plugin_version (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    plugin_id uuid NOT NULL,
    version text NOT NULL,
    digest text NOT NULL,
    rubric_id uuid
);


--
-- Name: plugin_version_skill; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.plugin_version_skill (
    plugin_version_id uuid NOT NULL,
    skill_version_id uuid NOT NULL
);


--
-- Name: principal; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.principal (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email zz.citext NOT NULL,
    display_name text DEFAULT ''::text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    active_team_id uuid,
    CONSTRAINT principal_role_check CHECK ((role = ANY (ARRAY['superadmin'::text, 'member'::text]))),
    CONSTRAINT principal_status_check CHECK ((status = ANY (ARRAY['active'::text, 'deactivated'::text])))
);


--
-- Name: rubric; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.rubric (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version text NOT NULL,
    derived_from_eval uuid,
    approved_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    subject text DEFAULT 'auto'::text NOT NULL,
    plugin_id uuid NOT NULL,
    CONSTRAINT rubric_subject_check CHECK ((subject = ANY (ARRAY['auto'::text, 'document'::text, 'trace'::text, 'initiative'::text])))
);


--
-- Name: COLUMN rubric.subject; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.rubric.subject IS 'What this ruler is applied to: the documents the subject produced, its run traces, or auto — documents where they exist and traces otherwise.';


--
-- Name: rubric_dimension; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.rubric_dimension (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rubric_id uuid NOT NULL,
    name text NOT NULL,
    five_means text NOT NULL,
    one_means text NOT NULL,
    ordinal integer DEFAULT 0 NOT NULL,
    kind text DEFAULT 'qualitative'::text NOT NULL,
    threshold text DEFAULT ''::text NOT NULL,
    threshold_reason text DEFAULT ''::text NOT NULL,
    levels text[],
    reads text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT rubric_dimension_kind_check CHECK ((kind = ANY (ARRAY['qualitative'::text, 'quantitative'::text])))
);


--
-- Name: COLUMN rubric_dimension.reads; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.rubric_dimension.reads IS 'Dotted paths into the facts sheet plugin_profile produces, e.g. record.revised_with_evidence_pct. Empty for a qualitative dimension, which reads the artifact instead. A quantitative dimension whose paths are not on the sheet cannot be measured, and is refused at ruler_record.';


--
-- Name: run; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    initiative_id uuid,
    skill_version_id uuid,
    caller_session text DEFAULT ''::text NOT NULL,
    turns integer DEFAULT 0 NOT NULL,
    calls integer DEFAULT 0 NOT NULL,
    refusals integer DEFAULT 0 NOT NULL,
    bytes_total bigint,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone
);


--
-- Name: COLUMN run.bytes_total; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.run.bytes_total IS 'Sum of response_bytes over the run''s events. Null when no event in the run was measured — distinct from 0, which means measured and empty. Zeros written before migration 051 are ambiguous and were deliberately not converted.';


--
-- Name: search_current; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.search_current (
    corpus_key text NOT NULL,
    owner_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    revision integer NOT NULL,
    content_hash text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    type text DEFAULT ''::text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    path text DEFAULT ''::text NOT NULL,
    gate_status text,
    knowledge_status text,
    raw_body text DEFAULT ''::text NOT NULL,
    analyzer_version text,
    projection_hash text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_current_revision_check CHECK ((revision > 0))
)
PARTITION BY LIST (corpus_key);


--
-- Name: search_current_default; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.search_current_default (
    corpus_key text NOT NULL,
    owner_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    revision integer NOT NULL,
    content_hash text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    type text DEFAULT ''::text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    path text DEFAULT ''::text NOT NULL,
    gate_status text,
    knowledge_status text,
    raw_body text DEFAULT ''::text NOT NULL,
    analyzer_version text,
    projection_hash text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_current_revision_check CHECK ((revision > 0))
);


--
-- Name: search_evidence; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.search_evidence (
    corpus_key text NOT NULL,
    owner_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    revision integer NOT NULL,
    content_hash text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    type text DEFAULT ''::text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    path text DEFAULT ''::text NOT NULL,
    gate_status text,
    knowledge_status text,
    raw_body text DEFAULT ''::text NOT NULL,
    analyzer_version text,
    projection_hash text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_evidence_revision_check CHECK ((revision > 0))
)
PARTITION BY LIST (corpus_key);


--
-- Name: search_evidence_default; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.search_evidence_default (
    corpus_key text NOT NULL,
    owner_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    revision integer NOT NULL,
    content_hash text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    type text DEFAULT ''::text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    path text DEFAULT ''::text NOT NULL,
    gate_status text,
    knowledge_status text,
    raw_body text DEFAULT ''::text NOT NULL,
    analyzer_version text,
    projection_hash text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_evidence_revision_check CHECK ((revision > 0))
);


--
-- Name: search_history; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.search_history (
    corpus_key text NOT NULL,
    owner_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    revision integer NOT NULL,
    content_hash text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    type text DEFAULT ''::text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    path text DEFAULT ''::text NOT NULL,
    gate_status text,
    knowledge_status text,
    raw_body text DEFAULT ''::text NOT NULL,
    analyzer_version text,
    projection_hash text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_history_revision_check CHECK ((revision > 0))
)
PARTITION BY LIST (corpus_key);


--
-- Name: search_history_default; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.search_history_default (
    corpus_key text NOT NULL,
    owner_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    revision integer NOT NULL,
    content_hash text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    type text DEFAULT ''::text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    path text DEFAULT ''::text NOT NULL,
    gate_status text,
    knowledge_status text,
    raw_body text DEFAULT ''::text NOT NULL,
    analyzer_version text,
    projection_hash text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_history_revision_check CHECK ((revision > 0))
);


--
-- Name: skill; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.skill (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    flow text,
    ordinal integer,
    retired boolean DEFAULT false NOT NULL,
    CONSTRAINT skill_belongs_correctly CHECK ((((kind = 'flow_step'::text) AND (flow IS NOT NULL)) OR ((kind = 'plugin_skill'::text) AND (flow IS NULL))))
);


--
-- Name: COLUMN skill.retired; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill.retired IS 'No longer in the catalog. Kept because zz.run and zz.doc attribute documents to its versions.';


--
-- Name: skill_asset; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.skill_asset (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    skill_version_id uuid NOT NULL,
    kind text NOT NULL,
    path text NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    CONSTRAINT skill_asset_kind_check CHECK ((kind = ANY (ARRAY['script'::text, 'reference'::text, 'tool_index'::text])))
);


--
-- Name: skill_version; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.skill_version (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    skill_id uuid NOT NULL,
    version text NOT NULL,
    content_hash text DEFAULT ''::text NOT NULL,
    released_at timestamp with time zone DEFAULT now() NOT NULL,
    body_hash text DEFAULT ''::text NOT NULL
);


--
-- Name: COLUMN skill_version.body_hash; Type: COMMENT; Schema: zz; Owner: -
--

COMMENT ON COLUMN zz.skill_version.body_hash IS 'sha256 of the SKILL.md below its frontmatter. Equal hashes mean the skill itself did not change.';


--
-- Name: team; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.team (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT team_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);


--
-- Name: search_current_default; Type: TABLE ATTACH; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.search_current ATTACH PARTITION zz.search_current_default DEFAULT;


--
-- Name: search_evidence_default; Type: TABLE ATTACH; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.search_evidence ATTACH PARTITION zz.search_evidence_default DEFAULT;


--
-- Name: search_history_default; Type: TABLE ATTACH; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.search_history ATTACH PARTITION zz.search_history_default DEFAULT;


--
-- Name: control_evidence seq; Type: DEFAULT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_evidence ALTER COLUMN seq SET DEFAULT nextval('zz.control_evidence_seq_seq'::regclass);


--
-- Name: control_waiver seq; Type: DEFAULT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_waiver ALTER COLUMN seq SET DEFAULT nextval('zz.control_waiver_seq_seq'::regclass);


--
-- Name: artifact_edge artifact_edge_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.artifact_edge
    ADD CONSTRAINT artifact_edge_pkey PRIMARY KEY (source_owner_id, source_artifact_id, kind, target_owner_id, target_artifact_id, asserted_event_id);


--
-- Name: artifact_event artifact_event_owner_id_artifact_id_sequence_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.artifact_event
    ADD CONSTRAINT artifact_event_owner_id_artifact_id_sequence_key UNIQUE (owner_id, artifact_id, sequence);


--
-- Name: artifact_event artifact_event_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.artifact_event
    ADD CONSTRAINT artifact_event_pkey PRIMARY KEY (event_id);


--
-- Name: artifact_identifier artifact_identifier_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.artifact_identifier
    ADD CONSTRAINT artifact_identifier_pkey PRIMARY KEY (id);


--
-- Name: artifact_passage artifact_passage_owner_id_artifact_id_revision_scope_corpus_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.artifact_passage
    ADD CONSTRAINT artifact_passage_owner_id_artifact_id_revision_scope_corpus_key UNIQUE (owner_id, artifact_id, revision, scope, corpus_key, ordinal);


--
-- Name: artifact_passage artifact_passage_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.artifact_passage
    ADD CONSTRAINT artifact_passage_pkey PRIMARY KEY (id);


--
-- Name: artifact artifact_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.artifact
    ADD CONSTRAINT artifact_pkey PRIMARY KEY (owner_id, artifact_id);


--
-- Name: artifact_projection_commit artifact_projection_commit_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.artifact_projection_commit
    ADD CONSTRAINT artifact_projection_commit_pkey PRIMARY KEY (owner_id, transaction_id);


--
-- Name: artifact_projection_watermark artifact_projection_watermark_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.artifact_projection_watermark
    ADD CONSTRAINT artifact_projection_watermark_pkey PRIMARY KEY (owner_id);


--
-- Name: artifact_revision artifact_revision_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.artifact_revision
    ADD CONSTRAINT artifact_revision_pkey PRIMARY KEY (owner_id, artifact_id, revision);


--
-- Name: bug bug_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.bug
    ADD CONSTRAINT bug_pkey PRIMARY KEY (id);


--
-- Name: console_session console_session_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.console_session
    ADD CONSTRAINT console_session_pkey PRIMARY KEY (id);


--
-- Name: console_session console_session_token_hash_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.console_session
    ADD CONSTRAINT console_session_token_hash_key UNIQUE (token_hash);


--
-- Name: control_evidence control_evidence_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_evidence
    ADD CONSTRAINT control_evidence_pkey PRIMARY KEY (seq);


--
-- Name: control_run control_run_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_run
    ADD CONSTRAINT control_run_pkey PRIMARY KEY (id);


--
-- Name: control_run control_run_team_slug_initiative_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_run
    ADD CONSTRAINT control_run_team_slug_initiative_key UNIQUE (team_slug, initiative);


--
-- Name: control_waiver control_waiver_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_waiver
    ADD CONSTRAINT control_waiver_pkey PRIMARY KEY (seq);


--
-- Name: decision decision_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.decision
    ADD CONSTRAINT decision_pkey PRIMARY KEY (team_slug, initiative, path, key);


--
-- Name: discussion_message discussion_message_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.discussion_message
    ADD CONSTRAINT discussion_message_pkey PRIMARY KEY (id);


--
-- Name: discussion_message discussion_message_team_slug_initiative_doc_path_seq_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.discussion_message
    ADD CONSTRAINT discussion_message_team_slug_initiative_doc_path_seq_key UNIQUE (team_slug, initiative, doc_path, seq);


--
-- Name: doc_artifact doc_artifact_owner_id_artifact_id_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc_artifact
    ADD CONSTRAINT doc_artifact_owner_id_artifact_id_key UNIQUE (owner_id, artifact_id);


--
-- Name: doc_artifact doc_artifact_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc_artifact
    ADD CONSTRAINT doc_artifact_pkey PRIMARY KEY (team_slug, initiative, path);


--
-- Name: doc doc_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc
    ADD CONSTRAINT doc_pkey PRIMARY KEY (team_slug, initiative, path);


--
-- Name: eval_finding eval_finding_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_finding
    ADD CONSTRAINT eval_finding_pkey PRIMARY KEY (id);


--
-- Name: eval eval_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval
    ADD CONSTRAINT eval_pkey PRIMARY KEY (id);


--
-- Name: eval_score eval_score_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_score
    ADD CONSTRAINT eval_score_pkey PRIMARY KEY (eval_id, subject_id, dimension_id, is_control);


--
-- Name: eval_subject eval_subject_eval_id_initiative_slug_path_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_subject
    ADD CONSTRAINT eval_subject_eval_id_initiative_slug_path_key UNIQUE (eval_id, initiative_slug, path);


--
-- Name: eval_subject eval_subject_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_subject
    ADD CONSTRAINT eval_subject_pkey PRIMARY KEY (id);


--
-- Name: event event_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.event
    ADD CONSTRAINT event_pkey PRIMARY KEY (id);


--
-- Name: initiative initiative_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.initiative
    ADD CONSTRAINT initiative_pkey PRIMARY KEY (id);


--
-- Name: initiative initiative_team_id_slug_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.initiative
    ADD CONSTRAINT initiative_team_id_slug_key UNIQUE (team_id, slug);


--
-- Name: knowledge_node_artifact knowledge_node_artifact_owner_id_artifact_id_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.knowledge_node_artifact
    ADD CONSTRAINT knowledge_node_artifact_owner_id_artifact_id_key UNIQUE (owner_id, artifact_id);


--
-- Name: knowledge_node_artifact knowledge_node_artifact_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.knowledge_node_artifact
    ADD CONSTRAINT knowledge_node_artifact_pkey PRIMARY KEY (team_slug, path);


--
-- Name: knowledge_node knowledge_node_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.knowledge_node
    ADD CONSTRAINT knowledge_node_pkey PRIMARY KEY (id);


--
-- Name: knowledge_node knowledge_node_team_slug_path_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.knowledge_node
    ADD CONSTRAINT knowledge_node_team_slug_path_key UNIQUE (team_slug, path);


--
-- Name: mcp_oauth_authz mcp_oauth_authz_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.mcp_oauth_authz
    ADD CONSTRAINT mcp_oauth_authz_pkey PRIMARY KEY (id);


--
-- Name: mcp_oauth_client mcp_oauth_client_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.mcp_oauth_client
    ADD CONSTRAINT mcp_oauth_client_pkey PRIMARY KEY (client_id);


--
-- Name: membership membership_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.membership
    ADD CONSTRAINT membership_pkey PRIMARY KEY (team_id, principal_id);


--
-- Name: model_call model_call_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.model_call
    ADD CONSTRAINT model_call_pkey PRIMARY KEY (id);


--
-- Name: passkey_challenge passkey_challenge_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.passkey_challenge
    ADD CONSTRAINT passkey_challenge_pkey PRIMARY KEY (id);


--
-- Name: passkey_enrolment passkey_enrolment_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.passkey_enrolment
    ADD CONSTRAINT passkey_enrolment_pkey PRIMARY KEY (token_hash);


--
-- Name: passkey passkey_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.passkey
    ADD CONSTRAINT passkey_pkey PRIMARY KEY (id);


--
-- Name: pat pat_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.pat
    ADD CONSTRAINT pat_pkey PRIMARY KEY (id);


--
-- Name: pat pat_token_hash_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.pat
    ADD CONSTRAINT pat_token_hash_key UNIQUE (token_hash);


--
-- Name: plugin plugin_name_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin
    ADD CONSTRAINT plugin_name_key UNIQUE (name);


--
-- Name: plugin plugin_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin
    ADD CONSTRAINT plugin_pkey PRIMARY KEY (id);


--
-- Name: plugin_tool plugin_tool_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_tool
    ADD CONSTRAINT plugin_tool_pkey PRIMARY KEY (plugin_version_id, name);


--
-- Name: plugin_version plugin_version_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_version
    ADD CONSTRAINT plugin_version_pkey PRIMARY KEY (id);


--
-- Name: plugin_version plugin_version_plugin_id_version_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_version
    ADD CONSTRAINT plugin_version_plugin_id_version_key UNIQUE (plugin_id, version);


--
-- Name: plugin_version_skill plugin_version_skill_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_version_skill
    ADD CONSTRAINT plugin_version_skill_pkey PRIMARY KEY (plugin_version_id, skill_version_id);


--
-- Name: principal principal_email_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.principal
    ADD CONSTRAINT principal_email_key UNIQUE (email);


--
-- Name: principal principal_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.principal
    ADD CONSTRAINT principal_pkey PRIMARY KEY (id);


--
-- Name: rubric_dimension rubric_dimension_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.rubric_dimension
    ADD CONSTRAINT rubric_dimension_pkey PRIMARY KEY (id);


--
-- Name: rubric_dimension rubric_dimension_rubric_id_name_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.rubric_dimension
    ADD CONSTRAINT rubric_dimension_rubric_id_name_key UNIQUE (rubric_id, name);


--
-- Name: rubric rubric_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.rubric
    ADD CONSTRAINT rubric_pkey PRIMARY KEY (id);


--
-- Name: run run_initiative_id_skill_version_id_caller_session_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.run
    ADD CONSTRAINT run_initiative_id_skill_version_id_caller_session_key UNIQUE (initiative_id, skill_version_id, caller_session);


--
-- Name: run run_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.run
    ADD CONSTRAINT run_pkey PRIMARY KEY (id);


--
-- Name: search_current search_current_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.search_current
    ADD CONSTRAINT search_current_pkey PRIMARY KEY (corpus_key, owner_id, artifact_id);


--
-- Name: search_current_default search_current_default_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.search_current_default
    ADD CONSTRAINT search_current_default_pkey PRIMARY KEY (corpus_key, owner_id, artifact_id);


--
-- Name: search_evidence search_evidence_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.search_evidence
    ADD CONSTRAINT search_evidence_pkey PRIMARY KEY (corpus_key, owner_id, artifact_id);


--
-- Name: search_evidence_default search_evidence_default_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.search_evidence_default
    ADD CONSTRAINT search_evidence_default_pkey PRIMARY KEY (corpus_key, owner_id, artifact_id);


--
-- Name: search_history search_history_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.search_history
    ADD CONSTRAINT search_history_pkey PRIMARY KEY (corpus_key, owner_id, artifact_id, revision);


--
-- Name: search_history_default search_history_default_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.search_history_default
    ADD CONSTRAINT search_history_default_pkey PRIMARY KEY (corpus_key, owner_id, artifact_id, revision);


--
-- Name: skill_asset skill_asset_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill_asset
    ADD CONSTRAINT skill_asset_pkey PRIMARY KEY (id);


--
-- Name: skill_asset skill_asset_skill_version_id_path_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill_asset
    ADD CONSTRAINT skill_asset_skill_version_id_path_key UNIQUE (skill_version_id, path);


--
-- Name: skill skill_name_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill
    ADD CONSTRAINT skill_name_key UNIQUE (name);


--
-- Name: skill skill_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill
    ADD CONSTRAINT skill_pkey PRIMARY KEY (id);


--
-- Name: skill_version skill_version_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill_version
    ADD CONSTRAINT skill_version_pkey PRIMARY KEY (id);


--
-- Name: skill_version skill_version_skill_id_version_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill_version
    ADD CONSTRAINT skill_version_skill_id_version_key UNIQUE (skill_id, version);


--
-- Name: team team_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.team
    ADD CONSTRAINT team_pkey PRIMARY KEY (id);


--
-- Name: team team_slug_key; Type: CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.team
    ADD CONSTRAINT team_slug_key UNIQUE (slug);


--
-- Name: artifact_by_class; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX artifact_by_class ON zz.artifact USING btree (owner_id, artifact_class);


--
-- Name: artifact_edge_target; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX artifact_edge_target ON zz.artifact_edge USING btree (target_owner_id, target_artifact_id);


--
-- Name: artifact_event_transaction; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX artifact_event_transaction ON zz.artifact_event USING btree (transaction_id);


--
-- Name: artifact_identifier_normalized; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX artifact_identifier_normalized ON zz.artifact_identifier USING btree (normalized_text);


--
-- Name: artifact_identifier_owner; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX artifact_identifier_owner ON zz.artifact_identifier USING btree (owner_id, artifact_id, revision, scope);


--
-- Name: artifact_identifier_trgm; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX artifact_identifier_trgm ON zz.artifact_identifier USING gist (normalized_text zz.gist_trgm_ops);


--
-- Name: artifact_passage_owner; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX artifact_passage_owner ON zz.artifact_passage USING btree (owner_id, artifact_id, revision, scope);


--
-- Name: bug_open; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX bug_open ON zz.bug USING btree (status, reported_at DESC);


--
-- Name: bug_team; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX bug_team ON zz.bug USING btree (team_slug, reported_at DESC);


--
-- Name: console_session_expiry; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX console_session_expiry ON zz.console_session USING btree (expires_at);


--
-- Name: console_session_principal; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX console_session_principal ON zz.console_session USING btree (principal_id);


--
-- Name: control_evidence_run_seq; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX control_evidence_run_seq ON zz.control_evidence USING btree (run_id, seq);


--
-- Name: control_evidence_supersedes; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX control_evidence_supersedes ON zz.control_evidence USING btree (run_id, supersedes) WHERE (supersedes IS NOT NULL);


--
-- Name: control_waiver_run; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX control_waiver_run ON zz.control_waiver USING btree (run_id);


--
-- Name: decision_team_initiative; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX decision_team_initiative ON zz.decision USING btree (team_slug, initiative);


--
-- Name: discussion_thread; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX discussion_thread ON zz.discussion_message USING btree (team_slug, initiative, doc_path, seq);


--
-- Name: doc_evidence; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX doc_evidence ON zz.doc USING gin (evidence);


--
-- Name: doc_id_unique; Type: INDEX; Schema: zz; Owner: -
--

CREATE UNIQUE INDEX doc_id_unique ON zz.doc USING btree (id);


--
-- Name: doc_supports; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX doc_supports ON zz.doc USING btree (team_slug, initiative, supports) WHERE (supports IS NOT NULL);


--
-- Name: doc_tags; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX doc_tags ON zz.doc USING gin (tags);


--
-- Name: doc_team_type; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX doc_team_type ON zz.doc USING btree (team_slug, type, status);


--
-- Name: doc_tsv; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX doc_tsv ON zz.doc USING gin (body_tsv);


--
-- Name: eval_controls_idx; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX eval_controls_idx ON zz.eval USING btree (controls) WHERE (controls IS NOT NULL);


--
-- Name: eval_latest_for_plugin_idx; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX eval_latest_for_plugin_idx ON zz.eval USING btree (plugin_version_id, started_at DESC) WHERE ((NOT is_control) AND (headroom_state IS NOT NULL));


--
-- Name: eval_subject_doc; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX eval_subject_doc ON zz.eval_subject USING btree (initiative_slug, path);


--
-- Name: event_initiative; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX event_initiative ON zz.event USING btree (team_slug, initiative) WHERE (initiative IS NOT NULL);


--
-- Name: event_kind_ts; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX event_kind_ts ON zz.event USING btree (kind, ts);


--
-- Name: event_refusal_owner_idx; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX event_refusal_owner_idx ON zz.event USING btree (refusal_owner) WHERE (ok = false);


--
-- Name: event_run; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX event_run ON zz.event USING btree (run_id) WHERE (run_id IS NOT NULL);


--
-- Name: event_step; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX event_step ON zz.event USING btree (step, step_version) WHERE (step IS NOT NULL);


--
-- Name: event_team_ts; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX event_team_ts ON zz.event USING btree (team_slug, ts);


--
-- Name: knowledge_node_tags; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX knowledge_node_tags ON zz.knowledge_node USING gin (tags);


--
-- Name: knowledge_node_team; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX knowledge_node_team ON zz.knowledge_node USING btree (team_slug, lifecycle);


--
-- Name: knowledge_node_tsv; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX knowledge_node_tsv ON zz.knowledge_node USING gin (body_tsv);


--
-- Name: mcp_oauth_authz_age; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX mcp_oauth_authz_age ON zz.mcp_oauth_authz USING btree (created_at);


--
-- Name: model_call_failed_ts; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX model_call_failed_ts ON zz.model_call USING btree (ts DESC) WHERE (NOT ok);


--
-- Name: model_call_plugin_ts; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX model_call_plugin_ts ON zz.model_call USING btree (plugin, ts);


--
-- Name: model_call_purpose_ts; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX model_call_purpose_ts ON zz.model_call USING btree (purpose, ts);


--
-- Name: passkey_challenge_age; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX passkey_challenge_age ON zz.passkey_challenge USING btree (created_at);


--
-- Name: passkey_enrolment_expiry; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX passkey_enrolment_expiry ON zz.passkey_enrolment USING btree (expires_at);


--
-- Name: passkey_enrolment_principal; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX passkey_enrolment_principal ON zz.passkey_enrolment USING btree (principal_id);


--
-- Name: passkey_principal; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX passkey_principal ON zz.passkey USING btree (principal_id);


--
-- Name: rubric_plugin_id_version_key; Type: INDEX; Schema: zz; Owner: -
--

CREATE UNIQUE INDEX rubric_plugin_id_version_key ON zz.rubric USING btree (plugin_id, version);


--
-- Name: run_no_initiative; Type: INDEX; Schema: zz; Owner: -
--

CREATE UNIQUE INDEX run_no_initiative ON zz.run USING btree (skill_version_id, caller_session) WHERE (initiative_id IS NULL);


--
-- Name: run_skill_version; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX run_skill_version ON zz.run USING btree (skill_version_id, started_at DESC);


--
-- Name: search_current_default_tags; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX search_current_default_tags ON zz.search_current_default USING gin (tags);


--
-- Name: search_current_default_tsv; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX search_current_default_tsv ON zz.search_current_default USING gin (to_tsvector('english'::regconfig, raw_body));


--
-- Name: search_evidence_default_tags; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX search_evidence_default_tags ON zz.search_evidence_default USING gin (tags);


--
-- Name: search_evidence_default_tsv; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX search_evidence_default_tsv ON zz.search_evidence_default USING gin (to_tsvector('english'::regconfig, raw_body));


--
-- Name: search_history_default_tags; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX search_history_default_tags ON zz.search_history_default USING gin (tags);


--
-- Name: search_history_default_tsv; Type: INDEX; Schema: zz; Owner: -
--

CREATE INDEX search_history_default_tsv ON zz.search_history_default USING gin (to_tsvector('english'::regconfig, raw_body));


--
-- Name: search_current_default_pkey; Type: INDEX ATTACH; Schema: zz; Owner: -
--

ALTER INDEX zz.search_current_pkey ATTACH PARTITION zz.search_current_default_pkey;


--
-- Name: search_evidence_default_pkey; Type: INDEX ATTACH; Schema: zz; Owner: -
--

ALTER INDEX zz.search_evidence_pkey ATTACH PARTITION zz.search_evidence_default_pkey;


--
-- Name: search_history_default_pkey; Type: INDEX ATTACH; Schema: zz; Owner: -
--

ALTER INDEX zz.search_history_pkey ATTACH PARTITION zz.search_history_default_pkey;


--
-- Name: artifact_edge artifact_edge_asserted_event_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.artifact_edge
    ADD CONSTRAINT artifact_edge_asserted_event_id_fkey FOREIGN KEY (asserted_event_id) REFERENCES zz.artifact_event(event_id);


--
-- Name: artifact_edge artifact_edge_retracted_event_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.artifact_edge
    ADD CONSTRAINT artifact_edge_retracted_event_id_fkey FOREIGN KEY (retracted_event_id) REFERENCES zz.artifact_event(event_id);


--
-- Name: artifact_event artifact_event_owner_id_artifact_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.artifact_event
    ADD CONSTRAINT artifact_event_owner_id_artifact_id_fkey FOREIGN KEY (owner_id, artifact_id) REFERENCES zz.artifact(owner_id, artifact_id);


--
-- Name: artifact_identifier artifact_identifier_passage_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.artifact_identifier
    ADD CONSTRAINT artifact_identifier_passage_id_fkey FOREIGN KEY (passage_id) REFERENCES zz.artifact_passage(id) ON DELETE CASCADE;


--
-- Name: artifact_revision artifact_revision_owner_id_artifact_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.artifact_revision
    ADD CONSTRAINT artifact_revision_owner_id_artifact_id_fkey FOREIGN KEY (owner_id, artifact_id) REFERENCES zz.artifact(owner_id, artifact_id);


--
-- Name: console_session console_session_principal_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.console_session
    ADD CONSTRAINT console_session_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id) ON DELETE CASCADE;


--
-- Name: control_evidence control_evidence_run_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_evidence
    ADD CONSTRAINT control_evidence_run_id_fkey FOREIGN KEY (run_id) REFERENCES zz.control_run(id) ON DELETE CASCADE;


--
-- Name: control_waiver control_waiver_run_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.control_waiver
    ADD CONSTRAINT control_waiver_run_id_fkey FOREIGN KEY (run_id) REFERENCES zz.control_run(id) ON DELETE CASCADE;


--
-- Name: decision decision_doc_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.decision
    ADD CONSTRAINT decision_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES zz.doc(id) ON DELETE CASCADE;


--
-- Name: discussion_message discussion_message_principal_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.discussion_message
    ADD CONSTRAINT discussion_message_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id);


--
-- Name: doc doc_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc
    ADD CONSTRAINT doc_initiative_id_fkey FOREIGN KEY (initiative_id) REFERENCES zz.initiative(id) ON DELETE SET NULL;


--
-- Name: doc doc_produced_by_run_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.doc
    ADD CONSTRAINT doc_produced_by_run_id_fkey FOREIGN KEY (produced_by_run_id) REFERENCES zz.run(id) ON DELETE SET NULL;


--
-- Name: eval eval_controls_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval
    ADD CONSTRAINT eval_controls_fkey FOREIGN KEY (controls) REFERENCES zz.eval(id) ON DELETE SET NULL;


--
-- Name: eval_finding eval_finding_eval_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_finding
    ADD CONSTRAINT eval_finding_eval_id_fkey FOREIGN KEY (eval_id) REFERENCES zz.eval(id) ON DELETE CASCADE;


--
-- Name: eval_finding eval_finding_resulted_in_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_finding
    ADD CONSTRAINT eval_finding_resulted_in_skill_version_id_fkey FOREIGN KEY (resulted_in_skill_version_id) REFERENCES zz.skill_version(id) ON DELETE SET NULL;


--
-- Name: eval eval_plugin_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval
    ADD CONSTRAINT eval_plugin_version_id_fkey FOREIGN KEY (plugin_version_id) REFERENCES zz.plugin_version(id);


--
-- Name: eval eval_rubric_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval
    ADD CONSTRAINT eval_rubric_id_fkey FOREIGN KEY (rubric_id) REFERENCES zz.rubric(id);


--
-- Name: eval_score eval_score_dimension_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_score
    ADD CONSTRAINT eval_score_dimension_id_fkey FOREIGN KEY (dimension_id) REFERENCES zz.rubric_dimension(id);


--
-- Name: eval_score eval_score_eval_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_score
    ADD CONSTRAINT eval_score_eval_id_fkey FOREIGN KEY (eval_id) REFERENCES zz.eval(id) ON DELETE CASCADE;


--
-- Name: eval_score eval_score_subject_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_score
    ADD CONSTRAINT eval_score_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES zz.eval_subject(id) ON DELETE CASCADE;


--
-- Name: eval_subject eval_subject_eval_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_subject
    ADD CONSTRAINT eval_subject_eval_id_fkey FOREIGN KEY (eval_id) REFERENCES zz.eval(id) ON DELETE CASCADE;


--
-- Name: eval_subject eval_subject_plugin_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_subject
    ADD CONSTRAINT eval_subject_plugin_version_id_fkey FOREIGN KEY (plugin_version_id) REFERENCES zz.plugin_version(id);


--
-- Name: eval_subject eval_subject_run_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_subject
    ADD CONSTRAINT eval_subject_run_id_fkey FOREIGN KEY (run_id) REFERENCES zz.run(id) ON DELETE SET NULL;


--
-- Name: eval_subject eval_subject_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.eval_subject
    ADD CONSTRAINT eval_subject_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id);


--
-- Name: event event_run_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.event
    ADD CONSTRAINT event_run_id_fkey FOREIGN KEY (run_id) REFERENCES zz.run(id) ON DELETE SET NULL;


--
-- Name: event event_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.event
    ADD CONSTRAINT event_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id);


--
-- Name: initiative initiative_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.initiative
    ADD CONSTRAINT initiative_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id);


--
-- Name: mcp_oauth_authz mcp_oauth_authz_principal_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.mcp_oauth_authz
    ADD CONSTRAINT mcp_oauth_authz_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id) ON DELETE CASCADE;


--
-- Name: membership membership_added_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.membership
    ADD CONSTRAINT membership_added_by_fkey FOREIGN KEY (added_by) REFERENCES zz.principal(id);


--
-- Name: membership membership_principal_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.membership
    ADD CONSTRAINT membership_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id);


--
-- Name: membership membership_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.membership
    ADD CONSTRAINT membership_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id);


--
-- Name: model_call model_call_event_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.model_call
    ADD CONSTRAINT model_call_event_id_fkey FOREIGN KEY (event_id) REFERENCES zz.event(id) ON DELETE SET NULL;


--
-- Name: passkey_challenge passkey_challenge_principal_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.passkey_challenge
    ADD CONSTRAINT passkey_challenge_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id) ON DELETE CASCADE;


--
-- Name: passkey_enrolment passkey_enrolment_issued_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.passkey_enrolment
    ADD CONSTRAINT passkey_enrolment_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES zz.principal(id) ON DELETE SET NULL;


--
-- Name: passkey_enrolment passkey_enrolment_principal_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.passkey_enrolment
    ADD CONSTRAINT passkey_enrolment_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id) ON DELETE CASCADE;


--
-- Name: passkey passkey_principal_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.passkey
    ADD CONSTRAINT passkey_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id) ON DELETE CASCADE;


--
-- Name: pat pat_principal_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.pat
    ADD CONSTRAINT pat_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES zz.principal(id);


--
-- Name: pat pat_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.pat
    ADD CONSTRAINT pat_team_id_fkey FOREIGN KEY (team_id) REFERENCES zz.team(id);


--
-- Name: plugin_tool plugin_tool_plugin_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_tool
    ADD CONSTRAINT plugin_tool_plugin_version_id_fkey FOREIGN KEY (plugin_version_id) REFERENCES zz.plugin_version(id) ON DELETE CASCADE;


--
-- Name: plugin_version plugin_version_plugin_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_version
    ADD CONSTRAINT plugin_version_plugin_id_fkey FOREIGN KEY (plugin_id) REFERENCES zz.plugin(id);


--
-- Name: plugin_version plugin_version_rubric_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_version
    ADD CONSTRAINT plugin_version_rubric_id_fkey FOREIGN KEY (rubric_id) REFERENCES zz.rubric(id);


--
-- Name: plugin_version_skill plugin_version_skill_plugin_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_version_skill
    ADD CONSTRAINT plugin_version_skill_plugin_version_id_fkey FOREIGN KEY (plugin_version_id) REFERENCES zz.plugin_version(id) ON DELETE CASCADE;


--
-- Name: plugin_version_skill plugin_version_skill_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.plugin_version_skill
    ADD CONSTRAINT plugin_version_skill_skill_version_id_fkey FOREIGN KEY (skill_version_id) REFERENCES zz.skill_version(id);


--
-- Name: principal principal_active_team_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.principal
    ADD CONSTRAINT principal_active_team_id_fkey FOREIGN KEY (active_team_id) REFERENCES zz.team(id) ON DELETE SET NULL;


--
-- Name: rubric_dimension rubric_dimension_rubric_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.rubric_dimension
    ADD CONSTRAINT rubric_dimension_rubric_id_fkey FOREIGN KEY (rubric_id) REFERENCES zz.rubric(id);


--
-- Name: rubric rubric_plugin_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.rubric
    ADD CONSTRAINT rubric_plugin_id_fkey FOREIGN KEY (plugin_id) REFERENCES zz.plugin(id);


--
-- Name: run run_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.run
    ADD CONSTRAINT run_initiative_id_fkey FOREIGN KEY (initiative_id) REFERENCES zz.initiative(id) ON DELETE CASCADE;


--
-- Name: run run_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.run
    ADD CONSTRAINT run_skill_version_id_fkey FOREIGN KEY (skill_version_id) REFERENCES zz.skill_version(id);


--
-- Name: skill_asset skill_asset_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill_asset
    ADD CONSTRAINT skill_asset_skill_version_id_fkey FOREIGN KEY (skill_version_id) REFERENCES zz.skill_version(id);


--
-- Name: skill_version skill_version_skill_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.skill_version
    ADD CONSTRAINT skill_version_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES zz.skill(id);


--
-- Name: team team_created_by_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

ALTER TABLE ONLY zz.team
    ADD CONSTRAINT team_created_by_fkey FOREIGN KEY (created_by) REFERENCES zz.principal(id);
