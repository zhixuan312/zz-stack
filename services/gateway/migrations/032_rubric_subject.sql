-- What a rubric is a ruler FOR, kept with the rubric.
--
-- A definition of good implies the artifact it is applied to, and the catalog has always said
-- so — `produces_document` and `vendored` are fields in every `evals/rubric.json` — but
-- nothing carried them into the database, so the judge had to guess the subject from what the
-- skill happened to leave behind. That guess is wrong for exactly the skills this platform
-- most needs to judge.
--
-- using-casebox is the case. Its ruler asks whether a VENDORED FILE earns its place
-- beside the block's own tools: does it say anything casebox's documentation tools do not, is it
-- fit for the flows we serve it into, is it honest about its own staleness. Not one of those
-- can be answered from a run trace — and run traces are all the judge could see, because the
-- skill writes no documents. So the one question worth asking about it was unaskable, and a
-- stage reading the same evidence derived a ruler that scored obedience to conduct rules this
-- platform has already decided are harmful in its flows.
--
-- `subject` is the rubric's, not the caller's. It arrives from the catalog with the rubric it
-- belongs to and cannot be chosen at judging time: an evaluation whose subject is picked by
-- whoever runs it is not a measurement.
alter table zz.rubric add column if not exists subject text not null default 'auto'
  check (subject in ('auto', 'document', 'trace', 'body'));

comment on column zz.rubric.subject is
  'What this ruler is applied to: the skill body itself (a vendored file, judged on whether it '
  'earns its place), the documents a skill produced, its run traces, or auto — documents where '
  'they exist and traces otherwise.';
