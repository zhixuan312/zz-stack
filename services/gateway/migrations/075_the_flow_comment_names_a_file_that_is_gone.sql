-- Rewrites the comment on zz.event.flow. Nothing else changes: no column, constraint, index
-- or row.
--
-- DELIBERATE: a column comment is schema — pg_dump and a restore carry it, and the console's
-- schema page reads it.

comment on column zz.event.flow is
  'The flow the call''s initiative runs, as declared at initiative_open; empty for a call made outside any initiative. Not attribution: use plugin / plugin_version for which plugin owns this call.';
