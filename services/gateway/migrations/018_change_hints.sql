-- 018_change_hints.sql — presenting or approving a revision, and recording an initiative's branch fact, tell
-- the console; and the comments a final read found false say what the code does.
--
-- `003_console_live.sql` hints `document` and `initiatives` when `zz.doc` changes, and nothing when
-- `zz.doc_revision` does. An approval was heard anyway, because `saveDocument`
-- (services/zz-core/src/document-save.ts) rewrites the `zz.doc` row in the same transaction. A
-- presentation was not: `recordPresented` (services/zz-core/src/attest.ts) sets
-- `doc_revision.presented_at` and touches no other table the console watches, so the waiting-approvals
-- count and the kept Initiatives answer stayed as they were until something else moved them.
--
-- So `zz.doc_revision` carries an AFTER UPDATE trigger, and it hints only for a row whose
-- `presented_at`, `approved_at` or `approved_by` changed. Not `UPDATE OF` those columns, and not every
-- update: Postgres refuses transition tables on a trigger with a column list, and every rewrite
-- `saveDocument` makes names `approved_at` in its SET list (a `coalesce` that keeps it), so a column
-- list would fire on every document write, which `zz.doc`'s own trigger already tells. The function
-- compares the old and new row instead. A revision reaches its team through its document and that
-- document's initiative, as `console_change_doc` does. Insert and delete stay unwatched: a revision is
-- inserted and deleted only beside a write to its `zz.doc` row, which hints already.
--
-- `zz.initiative_fact` had no trigger either, and the console's Initiatives list reads it to decide
-- which documents a branch applies to. A fact is only ever inserted (`writeFacts`,
-- services/zz-core/src/initiative-record.ts, `on conflict do nothing`, never an update), so it carries
-- an AFTER INSERT trigger that hints `initiatives` for the fact's team, through its initiative. A
-- conflict that inserts nothing raises nothing. A fact leaves only with its initiative, whose own
-- trigger hints already.
--
-- The rest of this file is comments, each mirrored in `schema-target/`:
--
--   - `zz.candidate` and `zz.eval_finding` name the transitions the code makes: an expired build lease
--     returns a candidate to recorded (eval/candidate-validate.ts), and a rollback reopens the findings
--     its release applied (eval/release-record.ts).
--   - `zz.release_attempt.reason` on a rollback is the reason the rollback CLI forwards from
--     release_verify, not one an operator types (packages/tools/src/release/rollback.ts).
--   - `zz.knowledge_node.content_hash` is read by nothing, and a supersession does not recompute it.
--   - `zz.event.team_id` is null when the act named no team, not when a team is gone; the foreign key
--     keeps a named team from going.
--   - `zz.model_call.duration_ms` and `zz.skill_run.session` say which writer keeps the rule, since
--     no constraint does.
--   - `zz.skill_run.bytes_total` and `zz.assessment.answer_kind` no longer name migrations this
--     repository does not carry.
--   - `zz.eval_idempotency.created_at` names the declared retention, which no sweep implements yet.
--   - `zz.eval_failure_mode_sighting.discovery_key` holds the failure mode's stable key
--     (eval/discover.ts), not an idempotency key.
--
-- `scripts/schema/compare.ts` does not model functions or triggers, so nothing in `schema-target/`
-- describes the triggers, and no table's rows move, so `scripts/rehearse/expect.ts` needs no entry: the
-- default assertion — row count unchanged, content hash unchanged — is the one this file must pass.
--
-- The release before this file can run on what it builds: it sends hints that release did not, each
-- of which costs a tab one read, and the comments are read by no code. Rollback is therefore not
-- refused, and no line below declares it.

CREATE OR REPLACE FUNCTION zz.console_change_doc_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE slugs text[]; s text;
BEGIN
  SELECT array_agg(DISTINCT t.slug) INTO slugs
    FROM new_rows n
    JOIN old_rows o ON o.doc_id = n.doc_id AND o.revision = n.revision
    JOIN zz.doc d ON d.id = n.doc_id
    JOIN zz.initiative i ON i.id = d.initiative_id
    JOIN zz.team t ON t.id = i.team_id
   WHERE n.presented_at IS DISTINCT FROM o.presented_at
      OR n.approved_at IS DISTINCT FROM o.approved_at
      OR n.approved_by IS DISTINCT FROM o.approved_by;
  FOREACH s IN ARRAY coalesce(slugs, '{}') LOOP
    PERFORM zz.console_hint(s, 'document');
    PERFORM zz.console_hint(s, 'initiatives');
  END LOOP;
  RETURN NULL;
END $$;

CREATE TRIGGER console_change_doc_revision_upd AFTER UPDATE ON zz.doc_revision
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_doc_revision();

CREATE OR REPLACE FUNCTION zz.console_change_initiative_fact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE slugs text[]; s text;
BEGIN
  SELECT array_agg(DISTINCT t.slug) INTO slugs
    FROM new_rows f JOIN zz.initiative i ON i.id = f.initiative_id JOIN zz.team t ON t.id = i.team_id;
  FOREACH s IN ARRAY coalesce(slugs, '{}') LOOP
    PERFORM zz.console_hint(s, 'initiatives');
  END LOOP;
  RETURN NULL;
END $$;

CREATE TRIGGER console_change_initiative_fact_ins AFTER INSERT ON zz.initiative_fact
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION zz.console_change_initiative_fact();

COMMENT ON TABLE zz.candidate IS 'class=state_machine; authority=this; question=which patch was proposed against which exact base plugin version, with what hypothesis and expected effect, and what did its local build and gate say?; transitions=recorded->awaiting_build,awaiting_build->valid,awaiting_build->invalid,awaiting_build->recorded';
COMMENT ON TABLE zz.eval_finding IS 'class=state_machine; authority=this; question=what conclusion did one evaluation run reach about a plugin, whose problem it names, and whether that owner has since applied or rejected the fix?; transitions=deferred->applied,deferred->rejected,applied->deferred';
COMMENT ON COLUMN zz.release_attempt.reason IS 'class=state_machine; authority=this; question=why did this attempt end as it did — releaseDecision''s own reason on a refusal, the failing command''s output tail (release_record) on a failure, on a rollback the reason release_record was sent, which the rollback CLI takes from release_verify''s own reason and regression_established when it gave none, or the accepted override (--reconcile --accept-tag-without-candidate-commit) on a reconciled release — null for prepared and applying, and for a release proved without an override?';
COMMENT ON COLUMN zz.knowledge_node.content_hash IS 'class=current_state; authority=this; question=what sha256 prefix of the node''s kind, lifecycle, successor ordinal, title, body, tags and cited initiatives did indexNode compute when it wrote the row, a value nothing reads — a reindex is decided by analyzer_version — and that supersedeNode does not recompute, so a superseded node''s hash still covers the lifecycle it was written with?';
COMMENT ON COLUMN zz.event.team_id IS 'class=relation; authority=this; question=which team this act was made for, resolved from the caller''s team slug by the statement that writes the row and null when the act named no team or a slug no team carries, the composite keys to initiative and skill_run proving they share that team, and a team a row names never deleted from under it because the foreign key is NO ACTION?';
COMMENT ON COLUMN zz.model_call.duration_ms IS 'class=immutable_history; authority=this; question=how long the call took in milliseconds, failed calls included — every writer sets it, though the column is nullable and nothing in the database refuses a null?';
COMMENT ON COLUMN zz.skill_run.session IS 'class=current_state; authority=this; question=what conversation key this run groups, the same key its events carry — never the empty string because the one writer, STAMP_RUN in the gateway''s events.ts, creates no run for an empty session, though the column defaults to the empty string and no CHECK refuses it?';
COMMENT ON COLUMN zz.skill_run.bytes_total IS 'class=current_state; authority=this; question=what the sum of response_bytes over the run''s events is, null when no event in the run was measured and distinct from 0, which means measured and empty, while the zeros written before null was told apart from zero are ambiguous and were deliberately not converted?';
COMMENT ON COLUMN zz.assessment.answer_kind IS 'class=immutable_history; authority=this; question=which typed-service primitive answered this question — noul, choice or score — where the default noul exists only so that rows written before the column existed read as noul unchanged and every writer sets it?';
COMMENT ON COLUMN zz.eval_idempotency.created_at IS 'class=ephemeral; authority=this; question=when the first write was recorded, the instant the declared 30-day retention measures from, though no sweep deletes a row yet?';
COMMENT ON COLUMN zz.eval_failure_mode_sighting.discovery_key IS 'class=immutable_history; authority=this; question=under which failure mode''s stable key was this sighting grouped when DISCOVER found it?';
