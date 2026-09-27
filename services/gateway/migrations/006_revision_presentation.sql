-- 006_revision_presentation.sql — the fact that a person was shown a revision.
--
-- `document_approve` REFUSES a document whose current bytes nobody has seen, and
-- `shownSinceLastChange` is what answers it. That record used to be a line in
-- `<initiative>/activity.jsonl` — permanent, per-initiative, and beside the document it described.
-- When the store was retired it moved to a `zz.event` row, and that was wrong for one reason: an
-- event table is unbounded and ephemeral, and the spec's own rule for such a table is that it
-- declares its retention. `zz.event` declares none, so the day somebody writes one — which is
-- exactly what an undeclared retention invites — a sweep deletes the evidence and
-- `document_approve` stops refusing. **That gate fails OPEN.** An approval on bytes nobody read is
-- not an approval, and the person harmed is whoever's document goes through unread.
--
-- So the fact moves to where it cannot be swept. Presentation is about the CURRENT BYTES, and the
-- current bytes are a revision, so `doc_revision` is the right grain: the column is set on the
-- revision that was shown, and a later revision carries none until it too is shown.
--
-- DELIBERATE: `presented_at > written_at` is the whole of the question, and the comparison is why
-- this column and not a boolean. A `document_patch` rewrites the CURRENT revision in place, so its
-- `written_at` moves forward while `presented_at` stays where the present left it — and a patched
-- document refuses an approval again with no journal to consult and nothing to remember to clear.
-- A boolean would need a writer to put it back, and a writer that forgot is a gate that opens.
--
-- DELIBERATE: nullable, and null means "nobody has been shown this revision" rather than "the fact
-- was not captured". A revision written and never presented is the ordinary state, and null is its
-- honest spelling; a default of `now()` would mark every write presented, which is the gate
-- switched off.
--
-- DELIBERATE: the `shown` row in `zz.event` STAYS, as a projection. It is what a reader uses to
-- ask "what has been fetched here" across a whole initiative, and it costs nothing. Nothing reads
-- it for the gate any more, which is the point: a sweep may take it and the gate still holds.
--
-- COUPLED: the PART-COVERAGE bookkeeping (`document.shown_part` rows, which `document-parts.ts`
-- reads) stays in `zz.event` too, because a column cannot hold a span set. A sweep that takes
-- those makes a partly-presented document read as unpresented, which refuses an approval — it
-- fails CLOSED, and that is the direction this platform fails in.
--
-- COUPLED: `schema-target/documents.ts` declares this column, last in `doc_revision`'s ordinal
-- order because an `ADD COLUMN` appends, and `checks/schema-inventory.ts` is what proves the two
-- agree. The writer is `document_present` (`services/zz-core/src/tools/artifacts.ts`) and the
-- reader is `shownSinceLastChange` (`services/zz-core/src/attest.ts`); each names this column in
-- its own docstring so neither has to be read to find the other. A comment on the column is Task
-- I-42's.

--
-- Name: doc_revision presented_at; Type: COLUMN; Schema: zz; Owner: -
--

-- Null on every row this file meets: the rows the carry wrote (Task I-38) come from a store whose
-- journal recorded presents in a different grain altogether (one line per act, matched on path and
-- version) and were never translated. A legacy revision therefore reads as never presented, which
-- refuses an approval that a person may in fact have made — the safe direction, and the only
-- direction available: inventing a `presented_at` from an approval's own timestamp would be
-- asserting that the approver was shown the bytes, which is exactly the claim the gate exists to
-- check rather than assume.
--

ALTER TABLE ONLY zz.doc_revision
    ADD COLUMN presented_at timestamp with time zone;

-- The comment the target declares for it, in the same file as the column that needs it: the
-- inventory check compares the catalog's comments against the target's, so a column added without
-- its comment is a difference in either direction. Task I-42 renders these from the target; a
-- column that arrives with its own migration carries its own.
COMMENT ON COLUMN zz.doc_revision.presented_at IS 'class=current_state; authority=this; question=When were these exact bytes put in front of a person? It is what `document_approve` is refused by, and a column rather than an event row so no sweep can take it.';
