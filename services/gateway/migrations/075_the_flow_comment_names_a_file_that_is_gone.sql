-- The comment on zz.event.flow named a migration that no longer exists.
--
-- It ended: "Dropped by migrations-next/022_drop_denormalized.sql once nothing reads it any
-- other way." That directory is deleted. Its one file had gone from deferred to wrong: it drops
-- zz.event.team_slug, .initiative and .flow, which the deployment carries 11,220, 7,417 and
-- 8,173 rows in, which events.ts and indexing.ts write on every call, and which runs.ts joins a
-- team through. A comment is what a reader consults when the code does not say; this one sent
-- them to a path that resolves to nothing and told them a live column was on its way out.
--
-- COMMENTS ARE SCHEMA. pg_dump carries them, a restore carries them, and the console's own
-- schema page reads them, so a stale one survives every cleanup that only touches the tree.
-- This is the only comment in zz that named that directory -- checked against the deployment,
-- across every column of every table, before this file was written.
--
-- Nothing else changes. No column, no constraint, no index, no row.

comment on column zz.event.flow is
  'Team context: the team''s most recently installed flow, cached per call. NOT attribution — a team running two flows reads every row as whichever was installed last, and a call made outside any flow (a block usage skill) gets nothing. Use plugin / plugin_version for "which plugin owns this call". It is not on its way out: the migration that would have dropped it dropped team_slug and initiative with it, which runs.ts joins a team through, so that migration was deleted rather than applied.';
