-- A row says which analyzer built its `body_tsv`, not only what the vector contains.
--
-- Task I-38 moved `zz.doc`/`zz.knowledge_node` off `to_tsvector('english', …)` and onto the
-- `zz-lexical-v2` analyzer (`buildRowVector` in `packages/indexing/src/index.ts`). A row's
-- `body_tsv` says nothing about which of those two built it, and this platform has already
-- paid once, on the derived tables migration 070 created, for a row that could not answer
-- "is this stale" independently of "did the content change" — `derivationFingerprint` exists
-- because `content_hash` alone could not carry that question. `zz.search_current` and
-- `zz.search_evidence` already record `analyzer_version` for the same reason; these two tables
-- had it just as much and did not have the column to say so.
--
-- Nullable, matching every row this migration runs against: no row written before this task
-- carries a value, and that is the honest answer — it says "unknown", not "zz-lexical-v2",
-- for a vector this migration does not touch and does not rebuild. Task I-13's rederivation
-- pass is what turns an existing row's null into a real generation; this migration only gives
-- it somewhere to land.
alter table zz.doc add column if not exists analyzer_version text;
alter table zz.knowledge_node add column if not exists analyzer_version text;
