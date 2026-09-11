-- WHY A DOCUMENT CHANGED, made queryable.
--
-- `add_source` and `revise_document` both take `supports`, and every source on both
-- deployments declares it — 85 of 85. It says which document that piece of supporting
-- information was attached to: a stakeholder's answer supports spec.md, an interview
-- supports intent.md. That is the causal chain the whole document store is built around,
-- because a revision exists BECAUSE something new was learned.
--
-- It was written into every file's envelope and indexed nowhere. So "what made this
-- version different from the last one" could be answered by opening files by hand and
-- not by any query, which means not by anything the platform shows anybody.
--
-- Text and nullable, matching the envelope: a source names one document, and a document
-- that is not a source names nothing.
alter table zz.doc add column if not exists supports text;

-- The lookup this exists for: given a document, which sources support it. Partial, because
-- only sources carry the field and indexing 400 nulls to find 85 rows is a wasted index.
create index if not exists doc_supports on zz.doc (team_slug, initiative, supports)
  where supports is not null;
