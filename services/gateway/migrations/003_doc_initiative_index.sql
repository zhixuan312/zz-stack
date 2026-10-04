-- 003_doc_initiative_index.sql — the foreign key every document reader walks, unindexed.
--
-- ADDITIVE: nothing here changes a row, so every table is expected unchanged and this file declares
-- no entry in scripts/rehearse/expect.ts. It folds into 001_init.sql at the release that verifies
-- it, and the `absorbed` row in that file's header grows by one.
--
-- `zz.doc.initiative_id` is NOT NULL, is a foreign key, and every reader of a document starts from
-- the initiative it belongs to: the console's Overview asked `zz.doc` once per initiative (84 ms at
-- 80 initiatives, a sequential scan of `zz.doc` for each one), the initiative list joins through it,
-- and `docRows` in zz-core does too. Without the index the planner cannot do better than reading
-- every document once per question asked.
--
-- Two indexes were enough for `zz.event` in 002 and this is the same shape of gap: a column every
-- reader predicates on, with nothing to search it by.

CREATE INDEX doc_initiative_id ON zz.doc USING btree (initiative_id);
