/**
 * zz.run, kept in step with the event log.
 *
 * `zz.run.skill_version_id` attributes work to a version of a skill, `zz.doc.produced_by_run_id`
 * hangs off it, and the evaluation track judges a skill from the documents and traces its runs
 * point at. A skill whose runs stop being recorded is indistinguishable, in every query, from
 * one nobody used.
 *
 * Derived, not written at the door. Every fact here is already in zz.event and a run is a
 * grouping of it, so writing rows per call would put a second write in the hot path of every
 * tool call and race with itself to store something recomputable exactly. This recomputes it
 * idempotently, on the unique key the migration declares, on start and on a timer.
 *
 * The grain is one run per (initiative, skill version, caller session). Keying on the session
 * alone collapses every step of an initiative into one row: a caller session spans several
 * steps inside a single initiative.
 */
import { catalogEntries } from "@zz/catalog";
import { platformDb, platformDbReady } from "./db.js";

/** Events that cannot be placed in a run stay unplaced. An event with no initiative belongs
 *  to work that had not yet opened one, and inventing an initiative for it would put calls in a
 *  piece of work that never happened. It is a limit of the grain, not something to paper over. */
const PLACEABLE = "e.detail ? 'run' and e.initiative is not null and e.initiative <> ''";

/** Whether an upsert's `do update` would change the stored run: the stored columns against the
 *  values the update writes, which for started_at and ended_at are the least and greatest
 *  expressions, not the recomputed bounds alone.
 *
 *  COUPLED: both `on conflict ... do update` clauses in `reconcileRuns` — each sets exactly
 *  these five columns with exactly these expressions. */
const CHANGED = `(zz.run.calls, zz.run.refusals, zz.run.bytes_total, zz.run.started_at, zz.run.ended_at)
      is distinct from (excluded.calls, excluded.refusals, excluded.bytes_total,
                        least(zz.run.started_at, excluded.started_at),
                        greatest(coalesce(zz.run.ended_at, excluded.ended_at), excluded.ended_at))`;

/** Which version of a skill was running when an event fired — answered by time.
 *
 * `e.step_version` is stamped only when a skill is served whole through skill_read
 * (step-trace.ts), and Claude Code reads an installed skill off disk, so in normal operation
 * nothing stamps it. Nothing is both placeable and version-resolvable through that column, and
 * a null `skill_version_id` cannot match the insert's conflict target — Postgres treats NULLs
 * as distinct — so `do update` never fires and every pass of the timer appends a duplicate.
 *
 * COUPLED: making the joins inner without changing this binding deletes the duplicates and then
 * writes nothing, for all time. Both halves are one change.
 *
 * A release is the moment a version's content is fixed, and `released_at` is written then, so
 * "which version was running" is a question about time: the latest version of that skill
 * released at or before the event. It answers for history already recorded rather than only
 * for data collected from now on.
 *
 * `s` and `e` must both be in scope. In an UPDATE this cannot be a LATERAL — Postgres rejects a
 * LATERAL in an UPDATE's FROM that references the update target — so the two linkbacks below
 * spell the same binding as a correlated scalar subquery instead. */
const VERSION_AT_EVENT = `
      join lateral (
        select v.id from zz.skill_version v
         where v.skill_id = s.id and v.released_at <= e.ts
         order by v.released_at desc limit 1
      ) sv on true`;

export async function reconcileRuns(): Promise<{ initiatives: number; runs: number; linked: number; docs: number }> {
  if (!platformDbReady()) return { initiatives: 0, runs: 0, linked: 0, docs: 0 };
  const db = platformDb();

  // The initiatives first, because a run points at one: zz.run.initiative_id is a foreign key,
  // so a run cannot be recorded for an initiative the table has never heard of.
  const i = await db.query(`
    insert into zz.initiative (team_id, slug, created_at)
    select t.id, e.initiative, min(e.ts)
      from zz.event e join zz.team t on t.slug = e.team_slug
     -- An initiative is a folder something was written into, and _knowledge is not one: it is
     -- the reserved directory the knowledge store lives in. Three conditions, each dropping a
     -- different kind of ghost:
     --   ok          -- nobody accepted this argument, so it says nothing
     --   the shape   -- initiative_open composes <YYYY-MM-DD>-<slug> from the platform's own
     --                  clock and safeName refuses a separator, so anything else was never a
     --                  name this platform created
     --   a write     -- reading an initiative is not evidence it is yours; only an act that put
     --                  something in the folder counts, which is also what makes the row true
     --                  of the team it is filed under
     -- Through coalesce(tool_key, subject) and both spellings, because older rows carry no
     -- tool_key -- see @zz/contracts' TOOL_ALIAS.
     -- DELIBERATE: no backticks in these comments; they sit inside a template literal.
     where e.initiative is not null and e.initiative not in ('', '_knowledge')
       and e.ok
       and e.initiative ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]*$'
       and coalesce(e.tool_key, e.subject) in (
             'core:initiative_open', 'core:initiative_close', 'core:close',
             'core:document_write', 'core:write_file',
             'core:document_patch', 'core:patch_file',
             'core:document_revise', 'core:revise_document',
             'core:document_approve', 'core:approve',
             'core:source_add', 'core:add_source')
     group by t.id, e.initiative
    on conflict (team_id, slug) do nothing`);
  // And from the documents, which are the record of what actually exists.
  //
  // The insert above derives an initiative from events, and events are telemetry: they can be
  // absent and they can predate a column, so a real initiative with documents can have no row
  // at all and be invisible to the progress tile and the stage bar. A folder holding a
  // document is an initiative, so the two sources are unioned and the count stops depending on
  // which table a reader happened to ask.
  const d = await db.query(`
    insert into zz.initiative (team_id, slug, created_at)
    select t.id, d.initiative, min(d.updated_at)
      from zz.doc d join zz.team t on t.slug = d.team_slug
     where d.initiative is not null and d.initiative not in ('', '_knowledge')
     group by t.id, d.initiative
    on conflict (team_id, slug) do nothing`);
  // The flow, from the documents rather than from the events. zz.doc carries the flow the
  // platform resolved and stamped; zz.event's own `flow` column is thinner, because the calls
  // made before any flow was resolved carry none. An initiative row
  // whose flow is blank is one the console cannot group.
  await db.query(`
    update zz.initiative i set flow = d.flow
      from (select distinct on (team_slug, initiative) team_slug, initiative, flow
              from zz.doc where flow is not null and flow <> ''
             order by team_slug, initiative, created_at) d
      join zz.team t on t.slug = d.team_slug
     where i.team_id = t.id and i.slug = d.initiative and i.flow <> d.flow`);

  // Then the runs. The statistics are recomputed rather than added to: an event arriving late
  // for a run that already exists has to change that run's counts, and `do update` is what
  // makes running this every few minutes produce the same answer as running it once at the
  // end. started_at is kept at the earliest seen; ended_at moves forward. `CHANGED` skips a
  // row the update would leave as it is, so a pass rewrites only the runs that moved.
  const r = await db.query(`
    insert into zz.run (initiative_id, skill_version_id, caller_session,
                        calls, refusals, bytes_total, started_at, ended_at)
    -- sum() over all-null is null, and deliberately not coalesced to 0: a run nobody measured
    -- has no total, which is a different fact from a run that transferred nothing.
    select i.id, sv.id, e.detail->>'run',
           count(*), count(*) filter (where e.ok is false),
           sum(e.response_bytes),
           min(e.ts), max(e.ts)
      from zz.event e
      join zz.team t       on t.slug = e.team_slug
      join zz.initiative i on i.team_id = t.id and i.slug = e.initiative
      join zz.skill s on s.name = e.step${VERSION_AT_EVENT}
     where ${PLACEABLE}
     group by i.id, sv.id, e.detail->>'run'
    on conflict (initiative_id, skill_version_id, caller_session) do update
      set calls = excluded.calls, refusals = excluded.refusals,
          bytes_total = excluded.bytes_total,
          started_at = least(zz.run.started_at, excluded.started_at),
          ended_at = greatest(coalesce(zz.run.ended_at, excluded.ended_at), excluded.ended_at)
      where ${CHANGED}`);

  // Runs that never opened an initiative. A skill can be loaded and used without one ever being
  // opened. Requiring an initiative leaves such a skill with stamped calls and zero runs —
  // indistinguishable, in every query the evaluation track makes, from a skill nobody used.
  const r2 = await db.query(`
    insert into zz.run (initiative_id, skill_version_id, caller_session,
                        calls, refusals, bytes_total, started_at, ended_at)
    select null, sv.id, e.detail->>'run',
           count(*), count(*) filter (where e.ok is false),
           sum(e.response_bytes),
           min(e.ts), max(e.ts)
      from zz.event e
      join zz.skill s on s.name = e.step${VERSION_AT_EVENT}
     where e.detail ? 'run' and (e.initiative is null or e.initiative = '')
     group by sv.id, e.detail->>'run'
    on conflict (skill_version_id, caller_session) where initiative_id is null do update
      set calls = excluded.calls, refusals = excluded.refusals,
          bytes_total = excluded.bytes_total,
          started_at = least(zz.run.started_at, excluded.started_at),
          ended_at = greatest(coalesce(zz.run.ended_at, excluded.ended_at), excluded.ended_at)
      where ${CHANGED}`);

  // And the link back, which is what makes a run's trace readable. The evaluation track reads
  // a run's ordered events as the artifact it scores, so a run with no events on it shows a
  // judge nothing.
  const l2 = await db.query(`
    update zz.event e set run_id = run.id
      from zz.run run
      join zz.skill_version sv on sv.id = run.skill_version_id
      join zz.skill s on s.id = sv.skill_id
     where e.run_id is null and run.initiative_id is null
       and e.detail ? 'run' and (e.initiative is null or e.initiative = '')
       and e.detail->>'run' = run.caller_session
       and e.step = s.name
       and sv.id = (select v.id from zz.skill_version v
                     where v.skill_id = s.id and v.released_at <= e.ts
                     order by v.released_at desc limit 1)`);

  const l = await db.query(`
    update zz.event e set run_id = run.id
      from zz.run run
      join zz.initiative i on i.id = run.initiative_id
      join zz.team t on t.id = i.team_id
     where e.run_id is null and ${PLACEABLE}
       and e.team_slug = t.slug and e.initiative = i.slug
       and e.detail->>'run' = run.caller_session
       -- Plain equality, not IS NOT DISTINCT FROM: the insert above never writes a null skill, and
       -- matching null to null would attach events to a run that identifies no skill.
       and run.skill_version_id = (
             select v.id from zz.skill s
              join zz.skill_version v on v.skill_id = s.id and v.released_at <= e.ts
             where s.name = e.step
             order by v.released_at desc limit 1)`);

  // And the document side.
  //
  // `zz.doc.produced_by_run_id` is how a document is attributed to the version of the skill
  // that wrote it — the join the whole evaluation track stands on. A document carrying NULL is
  // invisible to every round.
  //
  // From the manifest, not from a table of flow names: hardcoding one flow's step-to-role
  // pairs into the SQL attributes nothing for a second flow and attributes wrongly the day the
  // first renames a document. `stage` on a declared document says which step writes it and
  // `role` says what the document is, so the pairs are read off the catalog and passed as data.
  //
  // First the document's own initiative, because the attribution below joins on it.
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
       -- DELIBERATE: every condition touching the update target is in WHERE. Postgres does not admit
       -- the target inside a FROM-clause join, and this reconcile swallows its errors, so such a
       -- repair would silently never run.
       where d.produced_by_run_id is null
         and run.initiative_id = d.initiative_id
         and m.skill = s.name and m.role = d.type
         and d.path not like '\\_versions/%'`,
      [pairs.map((x) => x.skill), pairs.map((x) => x.role)]);
    docs = a.rowCount ?? 0;
  }
  docs += di.rowCount ?? 0;

  return { initiatives: (i.rowCount ?? 0) + (d.rowCount ?? 0), runs: (r.rowCount ?? 0) + (r2.rowCount ?? 0),
           linked: (l.rowCount ?? 0) + (l2.rowCount ?? 0), docs };
}
