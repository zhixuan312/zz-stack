-- What a round SCORED, and which initiative produced it — both were computed and neither kept.
--
-- ADDITIVE ONLY, for the reason 064 taught: it deleted from a table another one points at and
-- took all three doors down for twenty minutes. Nothing here drops or rewrites a row.
--
-- 1. THE TWO AXES WERE THROWN AWAY.
--
-- `round_recommend` computes effectiveness and headroom from figures no model touched, puts
-- them in front of the typed judge so the enum is chosen knowing them, returns them to the
-- caller — and stores only the enum. So the number a reader most wants ("how good is it, 0-10")
-- survived exactly as long as the tool response that carried it, and the console could not show
-- it at all.
--
-- The alternative was to recompute it in the gateway from eval_score and rubric_dimension. That
-- is a second copy of the arithmetic in judge-score.ts, in another service, and the two would
-- drift the first time a weight changed — the console would then report a different score from
-- the report, with nothing on screen saying which to believe. A figure is computed once, by the
-- thing that owns the rule, and stored.
--
-- 2. A ROUND COULD NOT SAY WHICH INITIATIVE IT BELONGED TO.
--
-- An evaluation round is minted inside an initiative — the one whose rulers.md was approved and
-- whose findings.md will be written — and nothing recorded which. So a reader looking at a score
-- had no way back to the report that explains it, and a reader looking at the report had no way
-- to the rows behind it.
--
-- IT IS STAMPED AT WRITE TIME AND NEVER INFERRED. The tempting join is eval -> doc on plugin
-- name and a date window, and it would have been right for all four rounds on this deployment
-- today. Journal 0116 is the record of what that costs: five separate defects in one day, every
-- one of them an attribution through a link that was not there — `produced_by_run_id` null on
-- 326 of 365 documents, skill membership standing in for authorship, a door's whole store
-- reported under one plugin's name. A number that is right today and derived from a coincidence
-- is a number nobody can trust tomorrow.
--
-- TEAM BESIDE IT, because zz.doc is keyed (team_slug, initiative, path): an initiative slug
-- alone does not identify an initiative and cannot address one. Storing the slug without the
-- team would produce a link that resolves for one team and 404s for another.
--
-- NULLABLE, and the nulls are honest. Every round taken before this migration ran has no
-- initiative recorded and no axes stored, and there is no backfill: see above.

alter table zz.eval
  add column if not exists initiative        text,
  add column if not exists team_slug         text,
  add column if not exists effectiveness     numeric,
  add column if not exists effectiveness_band text,
  add column if not exists headroom_points   numeric,
  add column if not exists headroom_named    integer;

comment on column zz.eval.initiative is
  'The initiative this round was run inside — stamped by round_judge from its caller, never '
  'inferred from a name or a date. Null on rounds taken before migration 067.';

comment on column zz.eval.effectiveness is
  '0-10, as judge-score.ts computed it at round_recommend. Null when the round was void (a '
  'collapsed control), and null on rounds taken before migration 067.';

-- The console asks one question of this table — "the latest scored round for this plugin" — and
-- asks it once per plugin on a page that lists them all.
create index if not exists eval_latest_for_plugin_idx
  on zz.eval (plugin_version_id, started_at desc)
  where not is_control and recommendation is not null;
