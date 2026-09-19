-- The recommendation goes, and the band stops being stored. Two axes, and nothing beside them.
--
-- WHY THE RECOMMENDATION GOES. `keep`, `keep-and-change`, `re-run`, `not-evaluable`, `retire`
-- answered "what should you do about this plugin?" — and that question has one permanent
-- answer. Somebody installs a plugin for a reason and they keep it. `retire` was advice nobody
-- takes; `keep` was information nobody needed; and the middle three were the headroom axis
-- wearing a decision's clothes, which is how a report came to carry a verb where a reader was
-- looking for a measurement. A column whose value is always the same is a column with no
-- information in it.
--
-- What `re-run` and `not-evaluable` actually carried — "this round produced no usable
-- measurement" — is already `effectiveness is null`, and is now also `headroom_state = 'not
-- measured'`. Nothing is lost by dropping the enum; one thing is gained, which is that the
-- report stops telling a person what to do and starts telling them what was found.
--
-- WHY THE BAND GOES. `effectiveness_band` lasted exactly one release, and that release is what
-- proved it should never have existed: the moment the band vocabulary changed, every stored
-- caption was wrong while every stored score was still right. A label computed from a column in
-- the same row is not a fact, it is a cache. The rule is `band(score)` and it lives in
-- @zz/contracts, where zz-core and the gateway both call it — one rule, so the console and the
-- report cannot print different words for the same number.
--
-- WHY headroom_state IS STORED WHEN THE BAND IS NOT. It is not derivable from one column: it
-- reads `headroom_points` AND `headroom_named` together, and the count of named changes is a
-- fact about findings that were open when the round was scored. Recomputing it later from
-- today's findings would silently rewrite what a round concluded.
--
-- A DROP, WHICH 064 EARNED CAUTION ABOUT. 064 deleted from a table another one points at and
-- took all three doors down for twenty minutes. This drops COLUMNS from zz.eval, and the only
-- foreign key on that table is the self-reference `controls` makes to `id` — declared in 063.
-- No dropped column takes part in any constraint except the recommendation's own check, which
-- goes with it. In a transaction regardless: a half-applied migration is the one state nobody
-- can diagnose from the outside.

begin;

alter table zz.eval
  add column if not exists headroom_state text;

-- The partial index was keyed on the column being dropped. Replaced by one on the state, which
-- every scored round now carries — including the rounds that produced no number, which are
-- exactly the ones a reader must be able to tell apart from a low score.
drop index if exists zz.eval_recommendation_idx;
drop index if exists zz.eval_latest_for_plugin_idx;

alter table zz.eval
  drop column if exists recommendation,
  drop column if exists recommendation_confidence,
  drop column if exists recommendation_probabilities,
  drop column if exists effectiveness_band;

create index if not exists eval_latest_for_plugin_idx
  on zz.eval (plugin_version_id, started_at desc)
  where not is_control and headroom_state is not null;

comment on column zz.eval.headroom_state is
  'One of: no change needed, change identified, unexplained gap, not measured. The second '
  'axis. It reports what the evidence says about the gap and prescribes nothing — whether a '
  'change CAN be made is not something a score establishes.';

commit;
