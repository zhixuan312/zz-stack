/**
 * zz.run, kept in step with the event log.
 *
 * THE TABLE HAD NO MAINTAINER. Migration 017 created `zz.run` and backfilled it from
 * `zz.event.detail->>'run'`, which was right — "the platform has been emitting a run
 * identifier per call all along" — and then nothing ever inserted another row. Every run on
 * this deployment was dated 08-30 or 08-31, the two days before that migration ran, and every
 * skill's measured reach froze there. Five days of delivery, four evaluation rounds and a
 * whole block evaluation left no run at all.
 *
 * That is not a cosmetic gap. `zz.run.skill_version_id` is what attributes work to a version
 * of a skill, `zz.doc.produced_by_run_id` hangs off it, and the evaluation track judges a
 * skill from the documents and traces its runs point at. A skill whose runs stopped being
 * recorded reads as a skill nobody used — indistinguishable, in every query, from one that is
 * genuinely unreached.
 *
 * DERIVED, NOT WRITTEN AT THE DOOR. Every fact here is already in zz.event; the run is a
 * grouping of it. Writing rows per call would put a second write in the hot path of every
 * tool call and race with itself, to store something that can be recomputed exactly. So this
 * recomputes it — idempotently, on the unique key the migration already declared — on start
 * and on a timer.
 *
 * THE GRAIN IS THE MIGRATION'S, unchanged: one run per (initiative, skill version, caller
 * session). 017's own comment says why it is not keyed on the session alone — "a caller
 * session spans eight different steps inside a single initiative; keying runs on it collapsed
 * every step of an initiative into one row and left 29 of 71 runs attached to no skill at
 * all."
 */
import { catalogEntries } from "@zz/catalog";
import { platformDb, platformDbReady } from "./db.js";

/** Events that cannot be placed in a run stay unplaced. An event with no initiative belongs
 *  to work that had not yet opened one — the whole measure stage of a block evaluation is
 *  like this — and inventing an initiative for it would put calls in a piece of work that
 *  never happened. It is a limit of the grain, not something to paper over. */
const PLACEABLE = "e.detail ? 'run' and e.initiative is not null and e.initiative <> ''";

export async function reconcileRuns(): Promise<{ initiatives: number; runs: number; linked: number; docs: number }> {
  if (!platformDbReady()) return { initiatives: 0, runs: 0, linked: 0, docs: 0 };
  const db = platformDb();

  // The initiatives first, because a run points at one. This is the same insert 017 made and
  // the same reason: zz.run.initiative_id is a foreign key, so a run cannot be recorded for
  // an initiative the table has never heard of.
  const i = await db.query(`
    insert into zz.initiative (team_id, slug, created_at)
    select t.id, e.initiative, min(e.ts)
      from zz.event e join zz.team t on t.slug = e.team_slug
     -- _knowledge IS NOT AN INITIATIVE. It is the reserved directory the knowledge store
     -- lives in, and the UPDATE thirteen lines down already excludes it -- this INSERT did
     -- not, so every deployment grew a _knowledge initiative row and runs were filed under
     -- it: 299 of them on production, attributed to a thing nobody can open.
     -- (No backticks in here: this is inside a template literal, and a backtick in a SQL
     -- comment closes it. That has broken this repository twice already.)
     where e.initiative is not null and e.initiative not in ('', '_knowledge')
     group by t.id, e.initiative
    on conflict (team_id, slug) do nothing`);
  // The flow, from the documents rather than from the events. zz.doc carries the flow the
  // platform resolved and stamped; zz.event's `flow` column is set on far fewer rows. An
  // initiative row whose flow is blank is one the console cannot group, and the column has
  // been empty on this deployment since the table was made.
  await db.query(`
    update zz.initiative i set flow = d.flow
      from (select distinct on (team_slug, initiative) team_slug, initiative, flow
              from zz.doc where flow is not null and flow <> '' and initiative <> '_knowledge'
             order by team_slug, initiative, created_at) d
      join zz.team t on t.slug = d.team_slug
     where i.team_id = t.id and i.slug = d.initiative and i.flow <> d.flow`);

  // Then the runs. The statistics are recomputed rather than added to: an event arriving late
  // for a run that already exists has to change that run's counts, and `do update` is what
  // makes running this every few minutes produce the same answer as running it once at the
  // end. started_at is kept at the earliest seen; ended_at moves forward.
  const r = await db.query(`
    insert into zz.run (initiative_id, skill_version_id, caller_session,
                        calls, refusals, bytes_total, started_at, ended_at)
    select i.id, sv.id, e.detail->>'run',
           count(*), count(*) filter (where e.ok is false),
           coalesce(sum((e.detail->>'bytes')::bigint), 0),
           min(e.ts), max(e.ts)
      from zz.event e
      join zz.team t       on t.slug = e.team_slug
      join zz.initiative i on i.team_id = t.id and i.slug = e.initiative
      left join zz.skill s          on s.name = e.step
      left join zz.skill_version sv on sv.skill_id = s.id and sv.version = e.step_version
     where ${PLACEABLE}
     group by i.id, sv.id, e.detail->>'run'
    on conflict (initiative_id, skill_version_id, caller_session) do update
      set calls = excluded.calls, refusals = excluded.refusals,
          bytes_total = excluded.bytes_total,
          started_at = least(zz.run.started_at, excluded.started_at),
          ended_at = greatest(coalesce(zz.run.ended_at, excluded.ended_at), excluded.ended_at)`);

  // Runs that never opened an initiative. A block usage skill's whole working life is here:
  // the agent loads the skill, works the block, and opens an initiative later or not at all.
  // Requiring an initiative left `using-casebox` with 22 stamped calls across 3
  // sessions and zero runs — indistinguishable, in every query the evaluation track makes,
  // from a skill nobody has ever opened.
  const r2 = await db.query(`
    insert into zz.run (initiative_id, skill_version_id, caller_session,
                        calls, refusals, bytes_total, started_at, ended_at)
    select null, sv.id, e.detail->>'run',
           count(*), count(*) filter (where e.ok is false),
           coalesce(sum((e.detail->>'bytes')::bigint), 0),
           min(e.ts), max(e.ts)
      from zz.event e
      join zz.skill s          on s.name = e.step
      join zz.skill_version sv on sv.skill_id = s.id and sv.version = e.step_version
     where e.detail ? 'run' and (e.initiative is null or e.initiative = '')
     group by sv.id, e.detail->>'run'
    on conflict (skill_version_id, caller_session) where initiative_id is null do update
      set calls = excluded.calls, refusals = excluded.refusals,
          bytes_total = excluded.bytes_total,
          started_at = least(zz.run.started_at, excluded.started_at),
          ended_at = greatest(coalesce(zz.run.ended_at, excluded.ended_at), excluded.ended_at)`);

  // And the link back, which is what makes a run's TRACE readable. zz.event.run_id was set by
  // nothing after 017 either, so even a rebuilt run had no events to show a judge: the
  // evaluation track reads a run's ordered events as the artifact it scores, and every one of
  // them came back empty.
  const l2 = await db.query(`
    update zz.event e set run_id = run.id
      from zz.run run
      join zz.skill_version sv on sv.id = run.skill_version_id
      join zz.skill s on s.id = sv.skill_id
     where e.run_id is null and run.initiative_id is null
       and e.detail ? 'run' and (e.initiative is null or e.initiative = '')
       and e.detail->>'run' = run.caller_session
       and e.step = s.name and e.step_version = sv.version`);

  const l = await db.query(`
    update zz.event e set run_id = run.id
      from zz.run run
      join zz.initiative i on i.id = run.initiative_id
      join zz.team t on t.id = i.team_id
     where e.run_id is null and ${PLACEABLE}
       and e.team_slug = t.slug and e.initiative = i.slug
       and e.detail->>'run' = run.caller_session
       and run.skill_version_id is not distinct from (
             select sv.id from zz.skill s
              join zz.skill_version sv on sv.skill_id = s.id and sv.version = e.step_version
             where s.name = e.step)`);

  // AND THE DOCUMENT SIDE, which had exactly the same hole and a worse blast radius.
  //
  // `zz.doc.produced_by_run_id` is how a document is attributed to the VERSION of the skill
  // that wrote it — the join the whole evaluation track stands on. It was written once, by
  // migration 018's backfill, and by nothing ever since. Every document written after that
  // migration carried NULL, so the track could only ever see the corpus as it stood on
  // 2026-08-31: sm-select's installed version reported zero subjects, sm-verify reported nine
  // judged against seven available, and six specs written this morning under a version
  // released to fix a measured weakness were invisible to the round that would measure it.
  //
  // FROM THE MANIFEST, not from a table of flow names. 018 hardcoded ops-flow's five
  // step-to-role pairs into the SQL, which is the per-flow table this codebase keeps finding
  // and removing — a second flow attributes nothing, and ops-flow attributes wrongly the day it
  // renames a document. `stage` on a declared document already says which step writes it and
  // `role` says what the document is, so the pairs are read off the catalog and passed as
  // data.
  // FIRST THE DOCUMENT'S OWN INITIATIVE, because the attribution below joins on it and it was
  // NULL on every document written since 018 — the same one-time backfill, one layer up. Two
  // columns, both filled once by a migration, both never maintained, and the second is
  // useless without the first.
  const di = await db.query(`
    update zz.doc d set initiative_id = i.id
      from zz.team t join zz.initiative i on i.team_id = t.id
     where d.initiative_id is null and t.slug = d.team_slug and i.slug = d.initiative`);

  const pairs: { skill: string; role: string }[] = [];
  for (const e of catalogEntries()) {
    for (const d of e.manifest.documents ?? []) {
      if (d.stage && d.role) pairs.push({ skill: d.stage, role: d.role });
    }
  }
  let docs = 0;
  if (pairs.length) {
    const a = await db.query(`
      update zz.doc d set produced_by_run_id = run.id
        from zz.run run
        join zz.skill_version sv on sv.id = run.skill_version_id
        join zz.skill s on s.id = sv.skill_id,
             unnest($1::text[], $2::text[]) as m(skill, role)
       -- THE TARGET TABLE IS NOT JOINABLE FROM INSIDE THE FROM CLAUSE. Written as a join
       -- whose ON touches d.type, this is "invalid reference to FROM-clause entry for table
       -- d" at runtime: Postgres does not admit the UPDATE target there. An UPDATE that
       -- throws inside a reconcile that swallows its errors is a repair that silently never
       -- runs, so every condition touching the target belongs in WHERE.
       where d.produced_by_run_id is null
         and run.initiative_id = d.initiative_id
         and m.skill = s.name and m.role = d.type
         and d.path not like '\\_versions/%'`,
      [pairs.map((x) => x.skill), pairs.map((x) => x.role)]);
    docs = a.rowCount ?? 0;
  }
  docs += di.rowCount ?? 0;

  return { initiatives: i.rowCount ?? 0, runs: (r.rowCount ?? 0) + (r2.rowCount ?? 0),
           linked: (l.rowCount ?? 0) + (l2.rowCount ?? 0), docs };
}
