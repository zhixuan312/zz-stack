-- The thread on one document — append-only, and monotonic by a constraint, not a convention.
--
-- A team member reading a document in the console needs somewhere to leave a note that is
-- not yet a decision and not yet evidence: not a comment stamped into `zz.doc` (that table
-- holds the document itself, and a running conversation about it is not a version of it),
-- and not an event in `zz.event` (that stream is the audit record of ACTS the platform
-- took, and talking about a document is not one). So its own table, owned by the gateway
-- alone — zz-core is never called to write or read a row here, unlike `approve()`, because
-- there is no flow-side notion of a thread for it to be the author of.
--
-- THE UNIQUE CONSTRAINT IS THE WHOLE POINT. `seq` is meant to be gapless and monotonic per
-- thread — message 4 exists only once, and nothing before it is missing — and an
-- application that computed "one more than the current max" and then inserted would have a
-- race exactly the width of that gap: two people appending at once can both read the same
-- max and both insert the same next number, and whichever commits second silently
-- overwrites the ordering the first one was promised. `unique (team_slug, initiative,
-- doc_path, seq)` turns that race into a rejection instead of a corruption — the loser's
-- insert fails with a unique-violation it can retry, rather than landing as a second
-- message wearing the same seat as the first. `discussion.ts`'s insert reads the next seq
-- and writes the row in the SAME statement (an `insert … select` with the max as a
-- subquery) so nothing runs between the read and the write that a second connection could
-- interleave with — but even that discipline is application code, and this constraint is
-- what makes it a guarantee a bug elsewhere cannot quietly undo.
--
-- APPEND-ONLY BY OMISSION: there is no update or delete route in discussion.ts, and nothing
-- here grants one — no soft-delete column, no edited-at, no version. A thread is a record of
-- what was said and when, not a document that gets revised.
--
-- `principal_id` names who wrote it, not `email` — the same reason every other table in this
-- schema keys on the id rather than a string a person could change. The route reads it back
-- joined to `zz.principal` for a display name and an email, and never returns the id itself.
create table if not exists zz.discussion_message (
  id           uuid primary key default gen_random_uuid(),
  team_slug    text not null,
  initiative   text not null,
  doc_path     text not null,
  seq          integer not null,
  principal_id uuid not null references zz.principal(id),
  body         text not null,
  created_at   timestamptz not null default now(),
  unique (team_slug, initiative, doc_path, seq)
);
create index if not exists discussion_thread
  on zz.discussion_message (team_slug, initiative, doc_path, seq);
