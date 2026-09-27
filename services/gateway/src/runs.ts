/**
 * The run relation: one row per conversation of one skill version, and the timer that repairs it.
 *
 * `zz.skill_run.skill_version_id` attributes work to a version of a skill, `zz.doc.produced_by_run_id`
 * hangs off it, and the evaluation track judges a skill from the documents and traces its runs point
 * at. A skill whose runs stop being recorded is indistinguishable, in every query, from one nobody
 * used.
 *
 * Stamped at the door, not derived on a timer (FR-19, FR-20). Phase 0 argued the opposite here —
 * that a run is a grouping of events and writing rows per call would put a second write in the hot
 * path of every tool call — and this phase reverses it. The cost is real: one transaction per event
 * instead of one insert. What it buys is that the trace and the row it belongs to cannot disagree,
 * because they are written together, and that an event's `run_id` is on the row from the moment the
 * row exists rather than from the next tick of a five-minute timer.
 *
 * `logEvent` (events.ts) composes a run's identity from the event's own stamps and writes the run
 * and the event in one transaction. The identity is `(team, initiative, skill version, session)` —
 * the tuple `skill_run_identity` declares — and `RUN_CONFLICT` below is the only place it is
 * spelled, so the door cannot drift from the index. Which session a call belongs to is decided by
 * step-trace.ts; which version was running is `versionAtEvent` below.
 *
 * The timer is repair-only. `reconcileRuns` recomputes the counters of runs that already exist and
 * attributes documents to them; it never computes which run an event belongs to, never writes
 * `zz.event.run_id`, and never inserts a run for an event that arrived without one. A run that
 * exists is a run the door created, and the counters are the only thing here a late event can
 * change.
 *
 * COUPLED: `checks/gate-run-binding.ts` plants a defect into `versionAtEvent`'s release-time bound,
 * and `scripts/gate/checks/data-sql.ts` reads `CHANGED`, the one conflict target and the repair
 * below.
 */
import { catalogEntries } from "@zz/catalog";
import { platformDb, platformDbReady } from "./db.js";

/** Whether a write would change the stored run: the stored columns against the values the write
 *  lands, which for started_at and ended_at are the least and greatest expressions rather than the
 *  recomputed bounds alone.
 *
 *  A function of the two sides, because the comparison has to be the same one in both writers — the
 *  door's upsert compares the stored row against `excluded`, the repair against the aggregate it
 *  recomputed — and a change to what "nothing moved" means has to reach both. Both sides are a row
 *  of the run's own shape, which is why the repair's aggregate is aliased to the run's column names
 *  rather than to shorter ones. Started and ended move in one direction each: `started_at` stays at
 *  the earliest seen, `ended_at` moves forward. Without the least/greatest the two sides would
 *  disagree for a late event and a run whose counters moved would read as unchanged. */
const CHANGED = (stored: string, incoming: string): string =>
  `(${stored}.calls, ${stored}.refusals, ${stored}.bytes_total,
                        ${stored}.started_at, ${stored}.ended_at)
      is distinct from (${incoming}.calls, ${incoming}.refusals, ${incoming}.bytes_total,
                        least(${stored}.started_at, ${incoming}.started_at),
                        greatest(${stored}.ended_at, ${incoming}.ended_at))`;

/** The one run upsert, appended by the door to the statement that writes a run.
 *
 *  One conflict target, because the tuple is the run's whole identity: every column of
 *  `skill_run_identity` and nothing else. It is `nulls not distinct`, so the index also decides a
 *  run with no initiative — a row rather than a case needing a second, partial-target statement to
 *  keep in step.
 *
 *  The counts are recomputed by the insert rather than incremented here, so writing the same event
 *  twice leaves the same run. `CHANGED` is what keeps a recomputation that changed nothing from
 *  writing a dead tuple; at the door it is all but always true, because the event being written is
 *  part of what is counted. */
export const RUN_CONFLICT =
  `on conflict (team_id, initiative_id, skill_version_id, session)
      do update set calls = excluded.calls, refusals = excluded.refusals,
          bytes_total = excluded.bytes_total,
          started_at = least(zz.skill_run.started_at, excluded.started_at),
          ended_at = greatest(zz.skill_run.ended_at, excluded.ended_at)
      where ${CHANGED("zz.skill_run", "excluded")}`;

/** Which version of a skill was loaded at `at` — answered by time.
 *
 *  A release is the moment a version's content is fixed, and `released_at` is written then, so
 *  "which version was running" is a question about time: the latest version of that skill released
 *  at or before the event. It answers for history already recorded rather than only for data
 *  collected from now on. `skill` is the skill's name as the caller had it loaded; `at` is a
 *  timestamp expression the caller supplies, so the one statement that resolves a version spells
 *  this resolution once — the door's, and no reader re-deriving it.
 *
 *  COUPLED: the binding is the `released_at <=` comparison. A join that dropped it resolves every
 *  version ever released and files the call under the newest; one that resolved by anything but time
 *  resolves nothing for an installed skill, which stamps no version of its own. Either way every
 *  call leaves the per-version report it exists for. */
export const versionAtEvent = (at: string, skill: string): string =>
  `(select v.id from zz.skill s
        join zz.skill_version v on v.skill_id = s.id and v.released_at <= ${at}
       where s.name = ${skill}
       order by v.released_at desc limit 1)`;

/** Repair, on start and on a timer. Nothing else keeps a run's counters in step with its trace: the
 *  door recomputes the counters of the run it is writing at the moment it writes it, and an event
 *  that arrives for a run whose counters were already written leaves that run counting one call less
 *  than the trace holds — which is the only thing this pass is for.
 *
 *  Returns the runs this pass rewrote, the events standing behind them, and the documents it
 *  attributed — the three numbers the boot line reports. */
export async function reconcileRuns(): Promise<{ runs: number; linked: number; docs: number }> {
  if (!platformDbReady()) return { runs: 0, linked: 0, docs: 0 };
  const db = platformDb();

  // zz.initiative is no longer derived here (002_initiative_anchor.sql, Task I-6):
  // `initiative_open` inserts the row itself, synchronously, in the same call that opens the
  // work — including `opened_at`/`opened_by`, which this reconciler never knew. An event or a
  // document naming an initiative this table has never heard of is now telemetry for work that
  // predates a database, or a store this reconciler cannot repair; it is no longer grounds to
  // mint a row for it.

  // The counters, recomputed rather than added to: running this every few minutes has to produce
  // the same answer as running it once at the end. The guard is the same comparison the door's
  // upsert uses, so a pass over runs nothing moved rewrites nothing — 805,942 updates on 723 rows
  // was what an unguarded version cost.
  //
  // The identity is not rewritten. Which run an event belongs to was decided by the door that wrote
  // the event; this recounts what is already attributed, and an event naming a run that does not
  // exist is not one this can place. started_at stays at the earliest seen and ended_at moves
  // forward, the same arithmetic the door's upsert does.
  //
  // RETURNING is where the second number comes from: the events standing behind the runs this pass
  // rewrote. Not rows touched — what a reader of boot wants from that line is how much trace moved,
  // not how many of its headings did.
  const repaired = await db.query<{ events: string }>(`
    update zz.skill_run r
       set calls = c.calls, refusals = c.refusals, bytes_total = c.bytes_total,
           started_at = least(r.started_at, c.started_at),
           ended_at = greatest(r.ended_at, c.ended_at)
      from (select e.run_id as id, count(*)::int as calls,
                   (count(*) filter (where e.ok is false))::int as refusals,
                   sum(e.response_bytes) as bytes_total, min(e.ts) as started_at,
                   max(e.ts) as ended_at
              from zz.event e
             where e.run_id is not null
             group by e.run_id) c
     where r.id = c.id and ${CHANGED("r", "c")}
    returning (select count(*) from zz.event x where x.run_id = r.id) as events`);

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
  // `zz.doc.initiative_id` is no longer backfilled here (Task I-6): `indexDoc`
  // (packages/indexing/src/index.ts) resolves it inline, in the same insert that writes the
  // row, from the anchor row `initiative_open` now writes synchronously. A document indexed
  // before this release, or before its initiative's anchor row existed, still carries null
  // until it is next written or reindexed — a knowing loss, not a gap this reconciler fills.
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
        from zz.skill_run run
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

  return { runs: repaired.rowCount ?? 0,
           linked: repaired.rows.reduce((n, row) => n + Number(row.events), 0),
           docs };
}
