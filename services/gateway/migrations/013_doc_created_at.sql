-- An initiative needs a START, so a measurement can be scoped to it.
--
-- zz.doc had only `updated_at`, which moves every time a document is rewritten. That was
-- enough for "what is the state now" and not enough for the one question the improvement loop
-- asks constantly: what happened DURING this initiative. `reconcile` joins a stage's
-- predictions against the platform's tool_call telemetry, and with no start time the only
-- join available was "every event this team has ever produced" — a fresh run's predictions
-- read against every previous run's calls.
--
-- The remedy taken at the time was to DELETE the events on every reset, which made the join
-- correct by destroying the evidence. Ten evaluation rounds ran that way and the database
-- ended holding one of them. This column is what lets the join be scoped instead, so the
-- record can accumulate the way a record is supposed to.
--
-- Backfilled from `updated_at`: for rows written before this column existed that is the best
-- lower bound available, and it is never later than the true creation.
alter table zz.doc add column if not exists created_at timestamptz not null default now();

update zz.doc set created_at = updated_at where created_at > updated_at;

comment on column zz.doc.created_at is
  'When this document first existed. Never moves. `updated_at` is the last write; this is the
   first, and it is what scopes a measurement to one initiative''s lifetime.';
