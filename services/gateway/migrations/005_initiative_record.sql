-- 005_initiative_record.sql — the table `<initiative>/_records.json` becomes.
--
-- What each `produces: "record"` stage of an initiative minted: the ids a later stage needs and,
-- being in no document, could otherwise only find in the conversation that ran it. The spec's
-- store-migration paragraph names `_records.json` as one of the four per-initiative JSON state
-- files that "are already in tables and are verified, not copied" — `_open.json` in
-- `zz.initiative`, `_facts.json` in `zz.initiative_fact`, `_assessments/*.json` in
-- `zz.eval_assessment` — and until this file it was the one with no table. It makes that sentence
-- true rather than bending another table until it fits.
--
-- DELIBERATE: its own table, and NOT `zz.initiative_fact`. The two are both key/value rows about
-- one initiative and they are opposite shapes. A branch fact is recorded ONCE by the stage that
-- decides it and is never revised — `initiative_fact`'s own comment says a row there is never
-- updated for a given (team, initiative, fact), and that is what makes the refuse-on-change rule
-- safe. A stage record is LATEST-WINS: a second profile or a re-score supersedes what the stage
-- recorded before, which is exactly what "resume from the initiative" means. A writer that used
-- `on conflict do update` against `initiative_fact` would leave a fact with two homes and a false
-- comment in one of them, which is worse than having no comment at all.
--
-- DELIBERATE: `value` is TEXT and not uuid. Three of the keys DEFINE/QUALIFY records are not ids —
-- `owes` and `qualify_owed` are comma lists, `evaluator_qualify` is the literal `none owed`,
-- `affirmed_digest` is a sha — so a uuid column would have nowhere to put half of what a stage
-- actually records.
--
-- DELIBERATE: no index beyond the primary key. Every read is by initiative (`recordsFor`, and the
-- per-stage lookup inside it), which the key's leading column answers; a second index would be one
-- nothing looks up.
--
-- DELIBERATE: nullable on nothing and defaulted on `set_at` alone. A row is written by
-- `writeStageRecord` whole, the same way the file it replaces was replaced whole and atomically —
-- there is no partial record and therefore no nullable column to express one.
--
-- COUPLED: `schema-target/delivery.ts` declares this table and `checks/schema-inventory.ts` is
-- what proves the two agree. The reader and the writer are both in
-- `services/zz-core/src/initiative-record.ts` (`recordsFor`/`writeStageRecord`), and the
-- `replace` path deletes with `starts_with(fact, stage || '.')` rather than `like`, because a
-- stage name holding an underscore would make `like` delete a neighbouring stage's keys with it.
-- A comment on this table, and on each of its columns, is Task I-42's: it renders every comment
-- from the target, so none is written here.

--
-- Name: initiative_record; Type: TABLE; Schema: zz; Owner: -
--

CREATE TABLE zz.initiative_record (
    initiative_id uuid NOT NULL,
    stage text NOT NULL,
    id_name text NOT NULL,
    value text NOT NULL,
    set_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: initiative_record initiative_record_pkey; Type: CONSTRAINT; Schema: zz; Owner: -
--

-- One row per (stage, id name) per initiative, which is the whole of "latest wins": a stage run
-- again updates the row it wrote rather than adding a second one.
ALTER TABLE ONLY zz.initiative_record
    ADD CONSTRAINT initiative_record_pkey PRIMARY KEY (initiative_id, stage, id_name);

--
-- Name: initiative_record initiative_record_initiative_id_fkey; Type: FK CONSTRAINT; Schema: zz; Owner: -
--

-- Cascade, not restrict: a record is about one initiative and has no meaning without it, the same
-- rule `initiative_fact`, `doc` and `knowledge_node` carry.
ALTER TABLE ONLY zz.initiative_record
    ADD CONSTRAINT initiative_record_initiative_id_fkey FOREIGN KEY (initiative_id)
        REFERENCES zz.initiative(id) ON DELETE CASCADE;

--
-- Name: initiative_fact; Type: COMMENT; Schema: zz; Owner: -
--

-- COUPLED: `001_init.sql` commented this table when a `<initiative>/_facts.json` file was the
-- authority and this was its mirror. The store is retired, so the row IS the record and the
-- sentence had to move with it — a comment that is false is worse than no comment. Paired with
-- the target entry `schema-target/delivery.ts` declares, which `checks/schema-inventory.ts`
-- compares against this.
COMMENT ON TABLE zz.initiative_fact IS 'An initiative''s durable branch facts, written once by the stage that decides each and never revised. `<initiative>/_facts.json` was the other half of this record and is retired with the store, so the row is now the authority. A stage''s own record of what it minted is `initiative_record`, which is latest-wins and is a different shape.';
