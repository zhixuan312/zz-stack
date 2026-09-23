-- A LATER FACT CAN WITHDRAW AN EARLIER ONE, AND THE LOG STILL ONLY GROWS.
--
-- `zz.control_evidence` is append-only by design: a fact is a fact, and the log is the history
-- of what the platform was told. That is right, and it left the loop answering a question about
-- a run's CURRENT state with facts that no longer stand.
--
-- The case that found it: a gated document is revised. The platform clears the approval it
-- carried and puts it back to draft — the approval really was given, so deleting the row would
-- falsify the history, and counting it says the step is met when the document is a draft nobody
-- has agreed to. Measured by driving sdlc-flow's whole declared procedure and then revising its
-- spec: `close:initiative` was granted, and granted again afterwards.
--
-- Nothing leaked, because `documentGuards` still refuses a draft gated document. That
-- duplication is what the control loop exists to replace, so the loop being wrong is the whole
-- problem rather than a harmless one.
--
-- AN ID, NOT A KIND. The kernel does not know what a revision is; it knows that a later entry
-- said an earlier one no longer stands. Nothing enforces that the id exists: an entry may
-- withdraw something that was never recorded, which is simply a withdrawal of nothing, and a
-- foreign key here would refuse the write instead of recording the fact.
alter table zz.control_evidence add column if not exists supersedes text;

-- Read on every rehydration of every run, filtered to the entries that withdraw something —
-- which is a small minority of the log.
create index if not exists control_evidence_supersedes
  on zz.control_evidence (run_id, supersedes) where supersedes is not null;
