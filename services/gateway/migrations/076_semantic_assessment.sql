-- One row per semantic assessment the platform asked: which question family, the exact
-- instruction (version and digest), which model was asked for and which one answered, the
-- probability and the reading the platform drew from it, and what it was about.
--
-- Written by services/zz-core/src/semantic.ts — by source_add for an audit round, and by the
-- assess tool for any other checkpoint. Read by nothing that decides a next move: the next move
-- reads the store copy under <initiative>/_assessments/, so it stays computable with no database.

create table zz.assessment (
    id bigint generated always as identity primary key,
    family text not null,
    instruction_version integer not null,
    question_digest text not null,
    reading text not null check (reading in ('yes', 'no', 'unclear', 'unavailable')),
    probability numeric,
    requested_model text,
    resolved_model text,
    identity_assurance text,
    reason text,
    initiative text,
    about text,
    asked_by text not null,
    asked_at timestamp with time zone not null default now()
);

create index assessment_initiative_idx on zz.assessment (initiative, asked_at);

comment on table zz.assessment is
  'Every semantic-assessment question the platform asked the typed service, with its provenance. A reading of unavailable carries its reason.';
