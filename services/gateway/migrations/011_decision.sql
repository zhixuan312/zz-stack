-- Every claim a stage document makes, as a row.
--
-- A flow's stages already write their commitments down. sm-select produces a fit ledger
-- keyed by acceptance criterion — seventeen rows on a real initiative, each naming a verdict
-- (Native / Achievable / Workaround / Not possible) and the tool or mechanism that carries
-- it. sm-spec writes the acceptance criteria themselves, each marked with who verifies it.
-- Both are written every single run, and both were markdown tables that nothing read back.
--
-- So the platform held the ARTIFACT of every decision and none of its content in a form
-- anything could ask a question of. "What have we predicted about casebox and notification email"
-- meant reading documents. Across a quarter it meant not asking.
--
-- These rows are derived at index time from text the flow already wrote — no extra model
-- call, no second place for anyone to keep them in sync. They are the left-hand side of the
-- reconciliation the review needs: a prediction, later joined against what zz.event actually
-- recorded happening to the blocks that prediction named.
create table if not exists zz.decision (
  team_slug   text not null,
  initiative  text not null,
  path        text not null,          -- the document that made the claim
  role        text not null,          -- the document's role: agreement | selection | plan
  key         text not null,          -- AC-6.1, and the join key across stages
  verdict     text not null default '',   -- native | achievable | workaround | not_possible
  qualifier   text not null default '',   -- what the verdict was hedged with, verbatim
  detail      text not null default '',   -- the named mechanism, or the criterion's own text
  checker     text not null default '',   -- who verifies it, where the stage says
  blocks      text[] not null default '{}',
  updated_at  timestamptz not null default now(),
  primary key (team_slug, initiative, path, key)
);

-- Read by initiative when reconciling one, and by block when asking what we have predicted
-- about a block across every initiative. Those are the two questions; there is no third.
create index if not exists decision_team_initiative on zz.decision (team_slug, initiative);
create index if not exists decision_blocks on zz.decision using gin (blocks);
