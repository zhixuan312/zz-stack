/**
 * Skills and the runs that measured them.
 *
 * A skill's versions, what one version says, and the scores it earned — which is the largest
 * route in the console because a score is only meaningful beside what it was scored against:
 * the ruler, the judge, the affirmations, and the runs each of those came from.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import { handler, teamless } from "./shared.js";

export function mountSkills(app: Express): void {
  /** Every skill the platform has run or evaluated, with what it cost to run.
   *
   * COST FIRST. A mean score with no idea how many calls or how long it took is
   * a number nobody can act on, and it was the first thing asked for when this
   * view was reviewed. The eval half may legitimately be absent — ops-build
   * produces side effects, not a document a judge can read — and an absent
   * rubric is reported as absent rather than as a zero. */
  app.get("/api/console/skills", teamless("skills", async (_req, res) => {
    // NO TEAM DIMENSION: this is every skill the platform has run, aggregated by skill and
    // version across every team that ran it. A skill is a platform-wide capability, not a
    // team's own data, so a team scope and a platform scope see the identical response.
    const db = platformDb();
    const [runs, evals, stepEvents] = await Promise.all([
      db.query(
        // `retired` travels with the row. This view is "every skill the platform has RUN",
        // so a skill removed from the catalog still belongs here — it owns those runs, and
        // dropping it would silently re-attribute its history. What it must not do is read
        // as current: casebox-stg-usage and zz-learn both appear here and neither is served any
        // more, and nothing on the row said so.
        `select s.name, sv.version, s.kind, s.flow, s.retired,
                count(*)                                            as runs,
                coalesce(sum(r.calls),0)                            as calls,
                round(avg(r.calls)::numeric,1)                      as calls_avg,
                coalesce(max(r.calls),0)                            as calls_max,
                coalesce(sum(r.refusals),0)                         as refusals,
                coalesce(sum(r.turns),0)                            as turns,
                round(avg(extract(epoch from (r.ended_at-r.started_at)))::numeric,0) as dur_avg,
                round(percentile_cont(0.5) within group
                      (order by extract(epoch from (r.ended_at-r.started_at)))::numeric,0) as dur_med,
                round(max(extract(epoch from (r.ended_at-r.started_at)))::numeric,0) as dur_max,
                round(avg(r.bytes_total)/1024.0,1)                  as kb_avg,
                round((sum(r.bytes_total)/1048576.0)::numeric,1)    as mb_total
           from zz.run r
           join zz.skill_version sv on sv.id = r.skill_version_id
           join zz.skill s on s.id = sv.skill_id
          group by 1,2,3,4,5`),
      db.query(
        `select s.name, sv.version, e.id as eval_id, e.judge_model, e.doc_count,
                to_char(e.started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as ran,
                round(avg(sc.score) filter (where sc.is_control = false)::numeric,2) as mean,
                round(avg(sc.score) filter (where sc.is_control = true)::numeric,2)  as control,
                count(*) filter (where sc.is_control = true)                         as control_n
           from zz.eval e
           join zz.skill_version sv on sv.id = e.skill_version_id
           join zz.skill s on s.id = sv.skill_id
           left join zz.eval_score sc on sc.eval_id = e.id
          group by 1,2,3,4,5,6`),
      db.query(
        `select step, count(*) as calls, count(*) filter (where ok = false) as failed,
                count(distinct subject) as tools
           from zz.event where kind = 'tool_call' and step is not null and step <> ''
          group by 1`),
    ]);
    const evalBy = new Map(evals.rows.map((e) => [`${e.name} ${e.version}`, e]));
    const evBy = new Map(stepEvents.rows.map((e) => [e.step as string, e]));
    res.json({ skills: runs.rows.map((r) => {
      const e = evalBy.get(`${r.name} ${r.version}`);
      const ev = evBy.get(r.name as string);
      return {
        name: r.name, version: r.version, kind: r.kind, flow: r.flow,
        // EMITTED, not merely selected. The column was added to the query and to nothing
        // else, so the view kept listing casebox-stg-usage and zz-learn exactly as it lists a
        // skill that is still served — which is the state the column was added to end.
        retired: !!r.retired,
        runs: +r.runs, calls: +r.calls, callsAvg: +r.calls_avg, callsMax: +r.calls_max,
        refusals: +r.refusals,
        // Reported as null, never 0. zz.run.turns is zero on every row while the
        // event log holds turn events with no run id, so a 0 here would read as
        // "this skill used no LLM turns" — which is false, not merely unknown.
        turns: +r.turns > 0 ? +r.turns : null,
        durationAvg: +r.dur_avg, durationMedian: +r.dur_med, durationMax: +r.dur_max,
        kbPerRun: +r.kb_avg, mbTotal: +r.mb_total,
        logged: ev ? { calls: +ev.calls, failed: +ev.failed, tools: +ev.tools } : null,
        evaluated: e
          ? { evalId: e.eval_id, judge: e.judge_model, documents: +e.doc_count, ran: e.ran,
              mean: e.mean === null ? null : +e.mean,
              control: e.control === null ? null : +e.control, controlN: +e.control_n }
          : null,
      };
    }) });
  }));

  /** One skill: its rubric with both anchors, its per-dimension scores, its
   * findings, and which surfaces its calls went to. */
  app.get("/api/console/skills/:name", teamless("the skill", async (req, res) => {
    // NO TEAM DIMENSION: a skill's rubric, findings and call mix are properties of the
    // skill itself, aggregated across every team that ran it — see /skills above.
    const db = platformDb();
    const name = req.params.name;
    const [dims, findings, mix, top] = await Promise.all([
      db.query(
        `select d.name, d.ordinal, d.five_means, d.one_means,
                count(sc.*) filter (where sc.is_control = false)                   as n,
                round(avg(sc.score) filter (where sc.is_control = false)::numeric,2) as mean,
                round(stddev_samp(sc.score) filter (where sc.is_control = false)::numeric,2) as sd,
                count(*) filter (where sc.is_control = false and sc.score <= 1)     as low,
                count(*) filter (where sc.is_control = false and sc.score >= 4)     as high
           from zz.rubric_dimension d
           join zz.rubric r on r.id = d.rubric_id
           join zz.skill s on s.id = r.skill_id
           left join zz.eval_score sc on sc.dimension_id = d.id
          where s.name = $1 group by 1,2,3,4 order by d.ordinal`, [name]),
      db.query(
        `select f.pattern, f.docs_affected, f.scope, f.decision, f.proposed_change
           from zz.eval_finding f
           join zz.eval e on e.id = f.eval_id
           join zz.skill_version sv on sv.id = e.skill_version_id
           join zz.skill s on s.id = sv.skill_id
          where s.name = $1 order by f.docs_affected desc`, [name]),
      db.query(
        `select coalesce(block,'platform') as surface, count(*) as calls,
                count(*) filter (where ok = false) as failed, count(distinct subject) as tools
           from zz.event where kind = 'tool_call' and step = $1
          group by 1 order by count(*) desc`, [name]),
      db.query(
        `select subject as tool, count(*) as calls,
                count(*) filter (where ok = false) as failed
           from zz.event where kind = 'tool_call' and step = $1
          group by 1 order by count(*) desc limit 8`, [name]),
    ]);
    res.json({
      skill: name,
      dimensions: dims.rows.map((d) => ({
        name: d.name, ordinal: +d.ordinal, fiveMeans: d.five_means, oneMeans: d.one_means,
        n: +d.n, mean: d.mean === null ? null : +d.mean, sd: d.sd === null ? null : +d.sd,
        low: +d.low, high: +d.high,
      })),
      findings: findings.rows.map((f) => ({ ...f, docs_affected: +f.docs_affected })),
      surfaces: mix.rows.map((m) => ({ surface: m.surface, calls: +m.calls, failed: +m.failed, tools: +m.tools })),
      busiestTools: top.rows.map((t) => ({ tool: t.tool, calls: +t.calls, failed: +t.failed })),
    });
  }));

  /** EVERY DOCUMENT THIS SKILL PRODUCED, scored or not.
   *
   * The skill page gives a mean per dimension and nothing under it — a number
   * with no way to ask which documents made it, or which documents are missing
   * from it. That second question is the one that matters: ops-intent has 81
   * intent.md documents in the store and 30 of them have ever been judged, and
   * a page that only lists the 30 reports a mean over a sample it does not
   * disclose.
   *
   * WHICH DOCUMENT A SKILL PRODUCES IS DERIVED, NOT LISTED. The flow manifest
   * declares its stages and its documents as two flat lists and maps neither to
   * the other, so there is nothing to read. What the store DOES record is which
   * path this skill's evals were run against — so the produced path comes from
   * the eval history. A skill that has never been evaluated has no such path,
   * and the honest answer there is an empty list with the reason, not a guess.
   *
   * CONTROLS ARE EXCLUDED EVERYWHERE. `zz.eval_score.is_control` marks a score
   * given to a deliberately degraded copy, and there are more of those rows
   * than real ones — 543 against 537. Averaging them together drags every mean
   * toward the floor and produces numbers that look like a failing skill. */
  app.get("/api/console/skills/:name/scores", handler("the scores", async (req, res, scope) => {
    const db = platformDb();
    const name = req.params.name;
    const produced = await db.query<{ path: string }>(
      `select s.path, count(*) as n
         from zz.eval_subject s
         join zz.eval e on e.id = s.eval_id
         join zz.skill_version sv on sv.id = e.skill_version_id
         join zz.skill sk on sk.id = sv.skill_id
        where sk.name = $1
        group by 1 order by count(*) desc limit 1`, [name]);
    const path = produced.rows[0]?.path ?? null;
    // ONE RULER'S DIMENSIONS, not every ruler the skill has ever had.
    //
    // This joined zz.rubric by skill alone, so a skill carrying two rubric versions offered
    // the UNION of their dimensions — and the ones belonging to the version nobody affirmed
    // appeared in the table with a dash, an empty n and no way to tell them from a dimension
    // that was scored badly. using-casebox showed six rows where its ruler has three.
    //
    // The ruler is the one its versions declare; failing that, the newest the catalog has
    // loaded. Both are "the ruler in force" — the first because somebody affirmed it, the
    // second because nothing else is a candidate.
    const dims = await db.query(
      `select d.name, d.ordinal from zz.rubric_dimension d
        where d.rubric_id = coalesce(
          (select sv.rubric_id from zz.skill_version sv
             join zz.skill s on s.id = sv.skill_id
            where s.name = $1 and sv.rubric_id is not null
            order by sv.released_at desc nulls last limit 1),
          (select r.id from zz.rubric r join zz.skill s on s.id = r.skill_id
            where s.name = $1 order by r.version::numeric desc limit 1))
        order by d.ordinal`, [name]);
    // No eval has ever named a document for this skill, so there is no set to
    // list. Said as an empty list with the path missing, which the page reads
    // as "this skill produces nothing a judge can score" — ops-build's answer,
    // and a true one.
    if (!path) {
      res.json({ skill: name, path: null, versions: [],
                 dimensions: dims.rows.map((d) => d.name as string), documents: [] });
      return;
    }
    // THE DOCUMENT LIST CARRIES `d.team_slug` — every team's initiatives and titles for
    // this skill, to anyone who can read the console. A team scope narrows it to the
    // caller's own team's documents; a platform scope keeps today's cross-team view.
    //
    // TWO COMPLETE STATEMENTS, not one assembled from `scope` — see the note in
    // /api/console/initiatives above; `check:sql` can only PREPARE a literal it can read
    // whole. The team branch's `d.team_slug = $3` is its own literal argument list to
    // match, not a hole filled in from `teamArgs`.
    const docsQuery = scope.kind === "platform"
      ? db.query(
        `select d.team_slug as team, d.initiative, d.path, d.title, d.status,
                to_char(d.updated_at,'YYYY-MM-DD') as updated,
                case when k.name = $2 then sv.version end as run_version,
                (select w.version
                   from zz.skill_version w
                   join zz.skill wk on wk.id = w.skill_id
                  where wk.name = $2 and w.released_at <= d.created_at
                  order by w.released_at desc limit 1)                  as era_version
           from zz.doc d
           left join zz.run r  on r.id  = d.produced_by_run_id
           left join zz.skill_version sv on sv.id = r.skill_version_id
           left join zz.skill k on k.id = sv.skill_id
          where d.path = $1 and d.initiative <> '_knowledge'
          order by d.created_at desc, d.initiative desc`, [path, name])
      : db.query(
        // WHICH VERSION WROTE IT, from the run that produced it. `zz.doc` carries
        // `produced_by_run_id` and a run carries its `skill_version_id`, so the
        // version is recorded MECHANICALLY at write time — no column on the document
        // repeating it, and nothing for a person to keep in step.
        //
        // GUARDED BY SKILL, and this is not defensive coding: a document is stamped
        // with whichever run last wrote it, and an intent.md revised inside an
        // ops-spec run points at that run. Version strings collide — "1.0" is every
        // skill's first — so an unguarded join reads another skill's 1.0 as this
        // one's. One intent.md on this deployment carries a zz-knowledge run.
        `select d.team_slug as team, d.initiative, d.path, d.title, d.status,
                to_char(d.updated_at,'YYYY-MM-DD') as updated,
                case when k.name = $2 then sv.version end as run_version,
                -- THE VERSION IN FORCE WHEN THIS DOCUMENT WAS WRITTEN, for the ones
                -- older than the run link. The latest version of THIS skill released
                -- on or before the document's creation — see migration 025 for why
                -- the window is evidence rather than a guess.
                (select w.version
                   from zz.skill_version w
                   join zz.skill wk on wk.id = w.skill_id
                  where wk.name = $2 and w.released_at <= d.created_at
                  order by w.released_at desc limit 1)                  as era_version
           from zz.doc d
           left join zz.run r  on r.id  = d.produced_by_run_id
           left join zz.skill_version sv on sv.id = r.skill_version_id
           left join zz.skill k on k.id = sv.skill_id
          where d.path = $1 and d.initiative <> '_knowledge' and d.team_slug = $3
          -- NEWEST FIRST, BY DATE rather than by name. Most initiatives are named
          -- for the day they opened, so ordering on the name descending looks like
          -- the same thing; it is not. The ones NOT named that way -- team2-only,
          -- post-rename-uat -- sort above every dated one on the first letter alone,
          -- and '28-08-2026' sorts above '2026-08-30' on the second character, so
          -- the top of the list was test initiatives and August the 28th.
          order by d.created_at desc, d.initiative desc`, [path, name, scope.slug]);
    const [docs, scores] = await Promise.all([
      // THE UNIVERSE IS THE STORE, not the eval table — that is what makes an
      // unscored document visible. `_versions/` never matches: a snapshot is
      // filed under its own name, not the live path.
      docsQuery,
      db.query(
        // WHICH VERSION WROTE THE DOCUMENT — `eval_subject.skill_version_id`, not
        // the eval's. A document is produced by exactly one version of the skill, so
        // the version is a property of the DOCUMENT and it can only ever be scored
        // as that version's work. The eval's own `skill_version_id` says which
        // version a ROUND was about; they agree today, and only the subject's is
        // right for the question this page asks.
        //
        // It matters because a mean is a claim about a version. Averaging 1.0's
        // documents with 1.1's produces a number describing neither.
        `select s.initiative_slug as initiative, sv.version, d.name as dimension, sc.score,
                sc.reason, sc.quote, e.judge_model as judge,
                to_char(s.evaluated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as judged_at
           from zz.eval_subject s
           join zz.eval e on e.id = s.eval_id
           join zz.skill_version sv on sv.id = s.skill_version_id
           join zz.skill sk on sk.id = sv.skill_id
           join zz.eval_score sc on sc.subject_id = s.id
           join zz.rubric_dimension d on d.id = sc.dimension_id
          where sk.name = $1 and s.path = $2 and sc.is_control = false
          order by s.evaluated_at, s.initiative_slug, d.ordinal`, [name, path]),
    ]);
    // Keyed by initiative. A document judged twice keeps the LATEST verdict —
    // the rows arrive oldest first, so a later round simply overwrites.
    // ONE VERDICT PER DOCUMENT. A document is written by one skill version and
    // judged as that version's work, so there is nothing to collapse and no round
    // to prefer — the key is the document.
    const byInitiative = new Map<string, {
      version: string; judge: string; evaluatedAt: string;
      scores: Record<string, { score: number; reason: string; quote: string }>;
    }>();
    // KEYED BY INITIATIVE AND JUDGE. Two judges scoring one subject are two readings, and
    // collapsing them onto the initiative alone made a body-subject skill — whose subjects
    // carry no initiative at all — merge every round into a single row whose n counted them
    // twice. A mean across two judges is a number about neither: every query in evaluation.ts
    // groups by judge for exactly this reason, and this page was the one place that did not.
    for (const r of scores.rows as Record<string, string>[]) {
      const key = `${r.initiative}\u0000${r.judge}`;
      const got = byInitiative.get(key)
        ?? { version: r.version, judge: r.judge, evaluatedAt: r.judged_at, scores: {} };
      got.version = r.version; got.judge = r.judge; got.evaluatedAt = r.judged_at;
      got.scores[r.dimension] = { score: +r.score, reason: r.reason, quote: r.quote };
      byInitiative.set(key, got);
    }
    // THE READING THIS PAGE SHOWS for a document, when more than one judge has read it: the
    // most recent. Keeping every reading keyed by judge is what stops them being averaged;
    // choosing the newest here is what stops the row being ambiguous. The judge's name travels
    // with the row, so which reading is on screen is never a guess.
    const latest = new Map<string, { version: string; judge: string; evaluatedAt: string;
                                     scores: Record<string, { score: number; reason: string; quote: string }> }>();
    for (const [key, reading] of byInitiative) {
      const initiative = key.slice(0, key.indexOf("\u0000"));
      const have = latest.get(initiative);
      if (!have || reading.evaluatedAt > have.evaluatedAt) latest.set(initiative, reading);
    }
    const byVersion = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
    // EVERY VERSION THAT HAS EVER BEEN JUDGED, oldest first. Not every version the
    // skill has: a version nobody evaluated is a filter that could only ever return
    // an empty list, and offering it would be offering an empty answer.
    // FROM BOTH SOURCES. Built from the scored rows alone this offered only the
    // versions a judge happened to reach — so a version with twelve documents and
    // no eval round could not be selected at all, which is exactly the set someone
    // fine-tuning that version needs to see.
    const versions = [...new Set([
      ...(scores.rows as { version: string }[]).map((r) => r.version),
      ...(docs.rows as { run_version: string | null; era_version: string | null }[])
        .flatMap((r) => [r.run_version, r.era_version]).filter(Boolean) as string[],
    ])].sort(byVersion);
    res.json({
      skill: name,
      path,
      versions,
      dimensions: dims.rows.map((d) => d.name as string),
      documents: (docs.rows as Record<string, string>[]).map((d) => {
        const ev = latest.get(d.initiative);
        const vals = ev ? Object.values(ev.scores).map((x) => x.score) : [];
        return {
          team: d.team, initiative: d.initiative, path: d.path,
          title: d.title, status: d.status, updated: d.updated,
          // NULL ON AN UNSCORED DOCUMENT, and unavoidably so: nothing outside the
          // eval record says which version of a skill wrote a given document, so
          // for the ones no judge has read the version is genuinely unknown rather
          // than absent. They answer "how much of this version's work is unjudged"
          // only under "all versions".
          // THE RUN FIRST. It is the write-time record — stamped by the platform
          // when the document was produced — where the eval's copy is a stamp put
          // on afterwards by whoever ran the round. They agree on all 28 documents
          // that have both; the order is stated so it stays chosen rather than
          // accidental. Null on neither, which is honest: 40 of these were written
          // before the run link existed and nothing anywhere recorded it.
          // THE RUN, THEN THE EVAL, THEN THE ERA. The first two are records of what
          // actually happened; the third is the version that was the only one in
          // existence when the document was written. Every row carrying both a
          // record and an era agrees, which is what earns the era its place as the
          // answer where no record exists.
          version: (d.run_version as string | null) ?? ev?.version ?? (d.era_version as string | null) ?? null,
          // WHICH OF THE THREE said so, because "recorded" and "inferred from the
          // catalog's history" are different strengths of claim and the page should
          // not present them as one.
          versionFrom: d.run_version ? 'run' : ev?.version ? 'eval' : d.era_version ? 'era' : null,
          judge: ev?.judge ?? null,
          evaluatedAt: ev?.evaluatedAt ?? null,
          scores: ev?.scores ?? null,
          mean: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null,
        };
      }),
    });
  }));

  /** Runs, as recorded. Includes the two gaps rather than hiding them: turns
   * that are never attributed, and runs that end with no outcome. */
  app.get("/api/console/runs", teamless("runs", async (_req, res) => {
    // NO TEAM DIMENSION: `zz.run` carries no team column and this reports platform-wide
    // outcome and volume totals, the same census category as /overview.
    const db = platformDb();
    const [outcomes, totals] = await Promise.all([
      db.query(`select coalesce(outcome,'(not recorded)') as outcome, count(*) as n
                  from zz.run group by 1 order by count(*) desc`),
      db.query(`select count(*) as runs, coalesce(sum(calls),0) as calls,
                       coalesce(sum(refusals),0) as refusals, coalesce(sum(turns),0) as turns,
                       round((sum(bytes_total)/1048576.0)::numeric,1) as mb,
                       (select count(*) from zz.event where kind='turn') as turn_events
                  from zz.run`),
    ]);
    const t = totals.rows[0];
    res.json({
      totals: { runs: +t.runs, calls: +t.calls, refusals: +t.refusals, mb: +t.mb },
      outcomes: outcomes.rows.map((r) => ({ outcome: r.outcome, n: +r.n })),
      gaps: {
        // Both stated as data so the front end never has to hardcode a caveat
        // that stops being true the day the platform starts recording them.
        //
        // A GAP YOU CANNOT HAVE IS NOT A GAP. This was `+t.turns > 0` alone, which is false
        // on a platform that has never run anything — so a fresh install opened its Runs page
        // to a warning banner reading "zz.run.turns is 0 on all 0 rows, while the event log
        // holds 0 turn events", reporting a defect where there is simply no data yet. Nothing
        // is unattributed when nothing exists, and a caveat that fires on emptiness teaches
        // the reader to ignore the ones that mean something.
        turnsAttributed: +t.turns > 0 || (+t.runs === 0 && +t.turn_events === 0),
        turnEvents: +t.turn_events,
        runsWithoutOutcome: +(outcomes.rows.find((r) => r.outcome === "(not recorded)")?.n ?? 0),
      },
    });
  }));
}
