-- WHAT A CALL COST, recorded so an absence and a zero are never the same fact.
--
-- zz.event has always answered "what happened" and never "what it cost to make it happen".
-- These seven columns are the request-shaped half of that: how long a call took, how many
-- bytes crossed the wire in each direction, whether the gateway folded several calls into
-- one batch, and which plugin and tool the call belonged to. zz.model_call is the other
-- half — one row per model invocation, because a single event can drive several calls (a
-- plugin that retries, or a step that fans out to more than one model) and folding them
-- onto zz.event would either lose the ones after the first or force an array column that
-- nothing could index.
--
-- EVERY TOKEN, CACHE AND DURATION COLUMN ON zz.model_call IS NULLABLE, AND NULL MEANS "NOT
-- REPORTED" — NOT ZERO. A provider that does not return cache-read counts and a call that
-- genuinely read nothing from cache are different facts, and collapsing them into `0` would
-- understate spend while the column looked complete: a report that sums a mix of real zeros
-- and silent gaps reads as more precise than it is, and nobody scanning the total can tell
-- which rows are which. `not null default 0` would make exactly that mistake, which is why
-- none of input_tokens, output_tokens, cache_read_tokens or duration_ms carry one.
--
-- `batched` IS THE ONE EXCEPTION, and deliberately `not null default false`. "Was this call
-- folded into a batch" is a fact the gateway always knows at the moment it makes the call —
-- there is no provider that declines to say, the way there is for token counts — so leaving
-- it nullable would only invite the same ambiguity this migration exists to avoid, on a
-- column where the ambiguity cannot legitimately arise.
--
-- NO BACKFILL. Rows written before this migration carry null in every new column, honestly:
-- nothing recorded these figures for them, and inventing a value would be the same mistake
-- as a `default 0` one column at a time.
--
-- DISJOINT FROM migrations-next/022_drop_denormalized.sql ON PURPOSE. That staged migration
-- drops team_slug, initiative, flow, step, step_version, block and block_version from
-- zz.event once the read paths that still use them move to the keyed columns it leaves
-- behind (run_id, block_version_id, team_id). None of those seven names appear here, this
-- migration adds no index on them, and nothing below joins through them — so this file reads
-- the same before and after 022 eventually lands, which is the property that makes it safe
-- to write now instead of waiting.

alter table zz.event
  add column if not exists duration_ms integer,
  add column if not exists request_bytes integer,
  add column if not exists response_bytes integer,
  add column if not exists batched boolean not null default false,
  add column if not exists plugin text,
  add column if not exists plugin_version text,
  add column if not exists tool_key text;

-- Task I-4 (AC-1.5, AC-1.6): `plugin` / `plugin_version` are what a call's attribution now
-- reads, and `flow` is what it used to read for lack of anything better — the team's most
-- recently installed flow, which is team context and was never actually "which skill", let
-- alone "which plugin". `flow` keeps being written for that team context; nothing may read it
-- as attribution again. It is one of the seven columns migrations-next/022_drop_denormalized.sql
-- removes once every other reader has moved off it; this comment is the marker for the reader
-- that goes looking for one after that migration lands.
comment on column zz.event.flow is
  'Team context: the team''s most recently installed flow, cached per call. NOT attribution — '
  'a team running two flows reads every row as whichever was installed last, and a call made '
  'outside any flow (a block usage skill) gets nothing. Use plugin / plugin_version for '
  '"which plugin owns this call". Dropped by migrations-next/022_drop_denormalized.sql once '
  'nothing reads it any other way.';
comment on column zz.event.plugin is
  'Which plugin owns the skill the caller had loaded, resolved through zz.plugin_version_skill '
  'from currentStep() — never from flow_install and never from the x-zz-client header. Null '
  'when no skill was loaded, or the step names none that a plugin has released.';
comment on column zz.event.plugin_version is
  'The released version of `plugin` that shipped the skill version the caller was on. Null '
  'exactly when plugin is null.';
comment on column zz.event.tool_key is
  'The alias-resolved `<surface>:<tool>` name (Task I-2''s resolver), so a row written after '
  'this column existed already reads as one series across a rename with no further lookup.';

-- One row per model invocation. `event_id` is the event that triggered the call, set null on
-- delete rather than cascaded — a model call already happened and cost real money whether or
-- not the event that requested it survives.
create table if not exists zz.model_call (
  id                 bigint generated always as identity primary key,
  ts                 timestamptz not null default now(),
  event_id           bigint references zz.event(id) on delete set null,
  plugin             text,
  purpose            text not null,
  model              text not null,
  input_tokens       integer,
  output_tokens      integer,
  cache_read_tokens  integer,
  duration_ms        integer,
  ok                 boolean not null
);

-- Per-plugin and per-purpose roll-ups are the two questions this table exists to answer
-- cheaply: "what is plugin X costing" and "what is purpose Y costing", both over a time
-- range.
create index if not exists model_call_plugin_ts  on zz.model_call (plugin, ts);
create index if not exists model_call_purpose_ts on zz.model_call (purpose, ts);
