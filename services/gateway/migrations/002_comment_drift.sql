-- 002_comment_drift.sql — five comments the target declares and live deployments never got.
--
-- ADDITIVE: no row and no table changes, so every table is expected unchanged and this file declares
-- no entry in scripts/rehearse/expect.ts. It folds into 001_init.sql at the release that verifies it,
-- and the `absorbed` row in that file's header grows by one.
--
-- `001_init.sql` records that it has run, in its own header and in `zz.schema_migration`: that is
-- what makes a fresh database get the whole schema in one transaction, and it is also what makes an
-- EDIT to this file invisible to every deployment that already ran it. `initiative_fact` and
-- `eval_observation_snapshot` had their structured comments corrected in the target — a branch fact
-- is immutable history and writes once, not current state that changes; an observation snapshot is
-- retained and unswept — and the live catalog kept the words it was created with. The gate could
-- not see it: it migrates a FRESH database, which builds the corrected target. It surfaced when a
-- real production backup was restored and put through the runner, which is what the rehearsal is for.
--
-- The target is the contract, so the target's words are what a deployment is brought to.

COMMENT ON TABLE zz.initiative_fact IS 'class=immutable_history; authority=this; question=which branch facts has this initiative decided, each written once by the stage that decided it and never revised, now that the `_facts.json` copy is retired and the row is the authority?';
COMMENT ON COLUMN zz.initiative_fact.fact IS 'class=immutable_history; authority=this; question=which named branch fact of this initiative''s flow does this row record?';
COMMENT ON COLUMN zz.initiative_fact.value IS 'class=immutable_history; authority=this; question=what did the deciding stage record this branch fact to be?';
COMMENT ON COLUMN zz.initiative_fact.set_at IS 'class=immutable_history; authority=this; question=when was this branch fact decided?';
COMMENT ON TABLE zz.eval_observation_snapshot IS 'class=immutable_history; authority=this; question=what did one plugin release''s real runs look like in one resolved window, with the facts computed from them and the denominators those rates carry?; retention=unswept: one row per observation of one plugin version and nothing deletes one, so the table grows with every evaluation and is bounded only by the plugin versions anybody still looks at';
