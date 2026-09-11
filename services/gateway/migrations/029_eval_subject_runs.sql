-- A judgement need not be about a document.
--
-- zz.eval_subject.path was NOT NULL, so the only thing this platform could score was a file.
-- Of 40 registered skills, 5 write one. sm-build writes none — and sm-build made 278 calls
-- with 57 refusals across two initiatives on 2026-09-04, more than every other skill
-- combined. It had a rubric, it had a judgement against that rubric, and it had nowhere to
-- put it: the storage assumed every evaluation is about a file, so the busiest skill on the
-- platform was the one thing that could not be evaluated.
--
-- The document/non-document split is smaller than it looks. Every skill is scored against
-- its rubric and against its statistics; the only difference is whether a document is ALSO
-- judged. So a subject is now either a document (path) or a window of work (run), and the
-- rest of the table is unchanged.
alter table zz.eval_subject alter column path drop not null;
alter table zz.eval_subject add column if not exists run_id uuid references zz.run(id) on delete set null;

-- Exactly one of the two, always. A subject naming neither is a score about nothing; a
-- subject naming both would let two readers disagree about what was measured.
alter table zz.eval_subject drop constraint if exists eval_subject_names_its_subject;
alter table zz.eval_subject add constraint eval_subject_names_its_subject
  check ((path is not null and run_id is null) or (path is null and run_id is not null));

comment on column zz.eval_subject.run_id is
  'The window of work judged, when a skill produces no document. Exactly one of path/run_id.';
