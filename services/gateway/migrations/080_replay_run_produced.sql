-- Fix dispatch on initiative 2026-09-24-plugin-eval-next-version, tasks I-17/I-19: a replay's
-- score never measured the replay. The launcher (packages/tools/src/replay/launch.ts) ran a
-- candidate session end to end and threw away what it produced; replay_score (Task I-19) only
-- ever had the ORIGINAL recorded case's events to read, so every run's assessment was the same
-- templated sentence naming a subject_ref, never the candidate's own output. Additive only.

-- What the candidate (or subject) session produced, in the bounded, redacted shape
-- launch.ts's own module note settles: `{ transcript, artifacts: [{ path, sha256, bytes, head }] }`
-- — the session's final assistant text and a capped list of the files it wrote in its worktree,
-- with the run's own token redacted out of both. Written once, by replay_close's own `result`
-- (never by anything downstream); read by replay_score to build the text a model-backed measure
-- is actually asked to judge. Null until replay_close carries a `result.produced` — an older run,
-- or one replay_close never reached with one, has nothing here to score, which replay_score
-- refuses naming rather than silently scoring an empty subject.
alter table zz.replay_run
    add column produced jsonb null;
