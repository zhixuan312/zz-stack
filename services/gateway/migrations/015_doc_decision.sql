-- The outcome table and the prediction table, brought up to the guideline.
--
-- ── zz.doc ───────────────────────────────────────────────────────────────────
--
-- ONE SIGNATURE, NOT TWO. Splitting it into `approved_by` and `accepted_by` is a distinction
-- that should not have been drawn: to a model the two words are interchangeable — "they
-- approved" and "they accepted" are semantically inseparable — so choosing between them was a
-- dice roll. It is also one of the three instances of the same shape the principles name, all
-- of them "two paths to the same thing, one cheaper": `outcome: accepted` demands a signature
-- while `delivered` does not; two signature words with only one enforced; `revise_document`
-- clears a signature while `patch_file` edits the same document and clears nothing.
-- `approved_by` survives as the single word.
--
-- CLOSED_BY IS INDEXED. The platform already validates and stamps it — a close is the most
-- consequential act here — and stored it nowhere, so "who closed this" could only be answered
-- by opening a document.
--
-- APPROVED_AT BECOMES A TIMESTAMP. A date cannot order approve -> revise -> approve within one
-- day, which is exactly the sequence a gate has to be able to reconstruct.
--
-- THE CLOSED SETS BECOME CONSTRAINTS. `status` and `outcome` have been closed vocabularies in
-- TypeScript and in prose and open text in the database, so anything writing directly to
-- Postgres bypassed every check that existed. A rule that has been broken becomes a guardrail.
alter table zz.doc add column if not exists closed_by text;

alter table zz.doc alter column approved_at type timestamptz
  using approved_at::timestamptz;

-- NORMALISE BEFORE CLOSING, because a constraint is checked against rows that already exist.
-- This migration applied cleanly to an empty database and to UAT, and refused production: six
-- documents from real delivery rounds carried values the vocabulary does not have. A migration
-- that only works where there is no data is not a migration, it is a schema.
--
-- `accepted` -> `approved` needs no record kept. This file argues above that the two words are
-- semantically inseparable and that `approved_by` is the survivor; rewriting the status is that
-- decision applied to the rows, not information being discarded.
update zz.doc set status = 'approved' where status = 'accepted';

-- The other two carry wording the closed set cannot hold, so it goes into `tags` before the
-- column is overwritten. Losing WHY a document was parked, or that an acceptance carried
-- waivers, would be this migration quietly deleting the only record of a real decision.
update zz.doc
   set tags = coalesce(tags, '{}') || array['was-outcome:' || outcome],
       outcome = 'accepted'
 where outcome is not null and outcome not in ('delivered', 'accepted', 'abandoned');

update zz.doc
   set tags = coalesce(tags, '{}') || array['was-status:' || status],
       status = 'draft'
 where status not in ('', 'draft', 'approved', 'adopted', 'superseded');

alter table zz.doc drop constraint if exists doc_status_closed;
-- TWO LIFECYCLES IN ONE COLUMN, because the table holds two kinds of document. A flow document
-- is `draft` or `approved` and nothing else. A knowledge node under `_knowledge/nodes/` is
-- `adopted` and later `superseded` — the distillate lifecycle, which is the whole reason
-- `superseded` was removed from `outcome`: it is a relationship between two documents, not the
-- fate of an initiative. A constraint naming only the flow half refused 22 rows the platform
-- writes itself.
alter table zz.doc add constraint doc_status_closed
  check (status in ('', 'draft', 'approved', 'adopted', 'superseded'));

alter table zz.doc drop constraint if exists doc_outcome_closed;
alter table zz.doc add constraint doc_outcome_closed
  check (outcome is null or outcome in ('delivered', 'accepted', 'abandoned'));

-- ── zz.decision ──────────────────────────────────────────────────────────────
--
-- NO `step` COLUMN, though the question it would answer is a real one. Nothing declares which
-- step wrote a document, so the column would be null on every row — the same write-only-column
-- defect that left `team_slug` unset on 6,137 of 6,225 tool calls while two reports depended on
-- it. It is derivable instead: zz.event now carries `step` and `initiative`, so "which step
-- wrote selection.md" is a join rather than a field somebody has to remember to set.
--
-- AGAINST WHICH VERSION OF THE BLOCK. "casebox handles AC-6.1 natively" was true against a
-- particular casebox. When the block moves, the claim may be silently stale — the same drift the
-- usage skills now guard against with `verified_against`. Without this, reconcile compares a
-- prediction made against one version with calls made against another and reports a
-- discrepancy that is nobody's defect. A jsonb map rather than an array parallel to `blocks`,
-- because parallel arrays go out of step with each other.
alter table zz.decision add column if not exists block_versions jsonb not null default '{}'::jsonb;

alter table zz.decision drop constraint if exists decision_verdict_closed;
alter table zz.decision add constraint decision_verdict_closed
  check (verdict in ('', 'native', 'achievable', 'workaround', 'not_possible'));


comment on column zz.doc.approved_by is
  'The one signature field. A person, never a team slug, "the user" or "the agent" — and
   stamped by approve() / close() from the session, never typed by a model.';
comment on column zz.decision.block_versions is
  'What each named block reported as its version when the claim was made. A claim is only true
   against the block it was checked against.';
