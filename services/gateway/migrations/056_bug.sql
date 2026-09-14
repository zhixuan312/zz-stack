-- Somebody using this platform hits something broken, and until now there was nowhere to put it.
--
-- WHY A TABLE AND NOT A KNOWLEDGE NODE. `knowledge_add` refuses an entry that cannot point at
-- the initiative it came from, and rightly — a node without evidence is an opinion. A bug report
-- is the opposite shape: it arrives mid-task from somebody who was trying to do something else,
-- often before anyone knows what caused it, and its value is that it was captured at all. Making
-- it meet the journal's bar would mean refusing most of them.
--
-- WHY NOT AN EVENT. zz.event is telemetry: machine-written, never authored, and deliberately
-- carrying no actor on a tool_call. A bug report is authored by a person and belongs to them.
--
-- THE TWO VOCABULARIES ARE CLOSED, for the reason the envelope's are: a column holding
-- 'blocker', 'urgent', 'p1' and 'pretty bad' answers no question anybody asks of it. Be loose
-- with the person and exact with ourselves — the model turns one into the other.
--
--   impact  what it cost the person who hit it, not how hard it is to fix. A reporter knows the
--           first and cannot know the second, and asking for severity gets a guess at the wrong
--           one. `blocks_work` is the only value that means somebody stopped.
--   status  `open` until somebody decides. `not_a_bug` and `duplicate` are outcomes, not
--           dismissals: a report that was neither is still a report somebody took the trouble
--           to make, and deleting it loses the fact that it was confusing enough to file.
create table if not exists zz.bug (
  id            uuid primary key default gen_random_uuid(),
  reported_at   timestamptz not null default now(),
  reported_by   text not null,
  team_slug     text,

  title         text not null,
  detail        text not null,

  -- WHAT THEY WERE DOING, all optional, because a person who has just hit a wall should not be
  -- interviewed. Every one of these narrows a search later and none of them blocks a report.
  surface       text,              -- the door or tool it happened on, if they know
  initiative    text,              -- what they were working on
  -- CAPTURED, NEVER ASKED. The caller does not reliably know which version they are talking to,
  -- and a version they guess at is worse than none: it sends somebody reading the report to the
  -- wrong diff. Taken from the service answering the call, the way `zz.block_tool.door` is.
  platform_version text,

  impact        text not null default 'wrong_result'
                check (impact in ('blocks_work', 'wrong_result', 'confusing', 'cosmetic')),

  status        text not null default 'open'
                check (status in ('open', 'fixed', 'not_a_bug', 'duplicate')),
  resolution    text,
  resolved_by   text,
  resolved_at   timestamptz,

  -- A RESOLUTION IS A SENTENCE SOMEBODY WROTE, so a row that claims to be resolved has to carry
  -- one. Without this the status column drifts into meaning "somebody clicked something": four
  -- rows marked fixed with no note is a tracker nobody can learn anything from.
  constraint bug_resolved_says_why check (
    (status = 'open'  and resolution is null and resolved_by is null and resolved_at is null)
    or
    (status <> 'open' and resolution is not null and resolved_by is not null and resolved_at is not null)
  )
);

comment on table zz.bug is
  'Bugs reported by the people using this platform. Written by bug_report on /core, read by '
  'bug_list, closed by bug_resolve. Not knowledge (a report needs no evidence) and not an '
  'event (an event has no author).';

create index if not exists bug_open on zz.bug (status, reported_at desc);
create index if not exists bug_team on zz.bug (team_slug, reported_at desc);
