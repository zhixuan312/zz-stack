-- Which clients a team chose to run an installed flow on.
--
-- Three things decide where a flow actually runs, and they are different questions with
-- different owners:
--   1. what the flow CAN run on   — its manifest's `clients`, the flow author's statement
--   2. what the team WANTS        — this column, the team's choice
--   3. what the platform SUPPORTS — the gateway's known client kinds
-- The effective set is the intersection. NULL here means "everything the flow declares",
-- which is what every existing install means, so no backfill is needed.
alter table zz.flow_install add column if not exists clients text[];

comment on column zz.flow_install.clients is
  'Team''s chosen subset of the flow manifest''s clients. NULL = all of them.';
