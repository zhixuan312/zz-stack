-- Which door a browser session came through — and, deliberately, nothing that touches who
-- may read the console with it.
--
-- A session minted by SsoAuth and a session minted by a future password check are the same
-- credential shape (zz.console_session already treats every session identically) but not
-- the same assurance: one means "this person is in the corporate directory right now", the
-- other means "this person typed a secret we store a hash of". `mayReadConsole` in
-- console.ts has only ever needed the first fact, and it gets it from `Identity.via ===
-- "session"` — a value this migration does not touch and identity.ts's `via` union does not
-- widen to carry. The door is recorded here as its own column precisely so that answering
-- "which door" is never the same question as "may they read the console", and the two can
-- never be collapsed back into one by an edit that looks like a simplification.
--
-- DEFAULT 'ssoauth', NOT NULL. Every session alive when this migration runs was minted by
-- the only door that has ever existed, so backfilling them as anything else would be
-- inventing a fact. `issueSession` states its door explicitly on every insert from here on
-- and never relies on this default — it exists solely for the rows that predate the column.
alter table zz.console_session
  add column if not exists door text not null default 'ssoauth';
alter table zz.console_session
  drop constraint if exists console_session_door_known;
alter table zz.console_session
  add constraint console_session_door_known check (door in ('ssoauth', 'password'));
