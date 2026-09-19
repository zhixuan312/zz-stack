/**
 * WHAT A PLUGIN VERSION'S SUBJECTS ARE — the one question, answered four ways.
 *
 * SPLIT OUT OF plugin-judge.ts BY SUBJECT. That file runs the round: it holds the tools, the
 * ruler guard, the control and the threshold pass. This one answers what is being marked, and
 * only that. A round and its sampling frame fail differently and are read by different people
 * — the round is checked against the ruler, the frame against the evidence — and keeping them
 * apart is what let the `sources/` defect below be seen as one line of SQL rather than as a
 * paragraph inside a six-hundred-line tool.
 *
 * All four are SELECTORS and none of them reads an artifact. Bodies are fetched at the moment
 * a subject is marked, so a round that stops early never paid to read what it did not mark.
 */
import type pg from "pg";

import { entryOf } from "./plugin-eval.js";
import { SUBJECT_CAP } from "./judge.js";

/** The runs a plugin version owns, through the skill membership recorded at release. The same
 *  join plugin-profile.ts uses and for the same reason — zz.event.step_version is stamped only
 *  when a skill is served whole, and release is the only moment anybody knows what a plugin
 *  version contained. */
const RUNS_OF = `
  from zz.run r
  join zz.plugin_version_skill pvs on pvs.skill_version_id = r.skill_version_id
  join zz.plugin_version pv on pv.id = pvs.plugin_version_id
  join zz.plugin p on p.id = pv.plugin_id
 where p.name = $1 and pv.version = $2`;

/** The documents this plugin version's runs produced, newest first.
 *
 * `scored` says whether a round has already marked it, and it is a fact the define stage needs
 * before it writes anything: a ruler derived from work that was already judged under an earlier
 * ruler is a ruler fitted to its own answers. */
export async function usageDocs(p: pg.Pool, plugin: string, version: string) {
  return (await p.query<{ team_slug: string; initiative: string; path: string; id: string; scored: boolean }>(`
    select d.team_slug, d.initiative, d.path, d.id::text as id,
           exists (select 1 from zz.eval_subject es
                    where es.doc_id = d.id and es.plugin_version_id = pv.id) as scored
      from zz.doc d
      join zz.run r on r.id = d.produced_by_run_id
      join zz.plugin_version_skill pvs on pvs.skill_version_id = r.skill_version_id
      join zz.plugin_version pv on pv.id = pvs.plugin_version_id
      join zz.plugin p on p.id = pv.plugin_id
     where p.name = $1 and pv.version = $2 and d.path not like '\\_versions/%'
     order by d.created_at desc limit ${SUBJECT_CAP}`, [plugin, version])).rows;
}

/** The runs of this plugin version that left events. A run with no events is not a subject —
 *  there is nothing for a judge to read — and it is reported as a gap by plugin_profile rather
 *  than silently dropped here. */
export async function usageRuns(p: pg.Pool, plugin: string, version: string) {
  return (await p.query<{ run_id: string; started: string; scored: boolean }>(`
    select r.id::text as run_id, to_char(r.started_at,'YYYY-MM-DD HH24:MI') as started,
           exists (select 1 from zz.eval_subject es
                    where es.run_id = r.id and es.plugin_version_id = pv.id) as scored
    ${RUNS_OF}
       and exists (select 1 from zz.event e where e.run_id = r.id)
     order by r.started_at desc limit ${SUBJECT_CAP}`, [plugin, version])).rows;
}

/** The INITIATIVES this plugin version CARRIED TO ITS OWN END, each with both of them.
 *
 * The subject is the sequence, not a document: "does the end deliver what the beginning asked
 * for" cannot be asked of one file. So each row is one initiative with the first and the last
 * of THE DOCUMENTS THIS FLOW'S OWN STAGES DECLARE.
 *
 * NOT THE OLDEST AND NEWEST FILE IN THE FOLDER, which is what this asked for one round and got
 * wrong three times out of three. An initiative folder holds more than the flow's stage output:
 * `source_add` registers supporting material under `sources/`, and `handover.md` is written
 * after the close by a different plugin's skill entirely. Ordered by creation, those win both
 * ends — so a ruler asking whether the conclusion answers the brief was handed a stakeholder
 * attachment and a spec, and marked them 4.55. The number was real and it was about the wrong
 * pair.
 *
 * The manifest already says which documents are this flow's: `stages[].produces`, in the order
 * the stages run, whenever it names a file rather than `source`, `record` or `nothing`. That
 * list arrives as `$3` and the join to it is what excludes everything else — `sources/`,
 * `handover.md` and `_versions/` alike, without naming any of them.
 *
 * AND THE CLOSING DOCUMENT MUST BE THERE. `$4` is the last entry in that list, and an
 * initiative without it is not a subject. An initiative still in flight has no end, and
 * feeding `explore.md -> spec.md` to a ruler that asks about DELIVERY marks the spec as though
 * it were the deliverable — a low mark would then be about the work being unfinished rather
 * than about the plugin. Thin evidence is a fact a report can state; a confident mark on the
 * wrong question is one it cannot recover from. */
export async function usageInitiatives(p: pg.Pool, plugin: string, version: string, stageDocs: string[]) {
  if (stageDocs.length < 2) return [];
  return (await p.query<{ team_slug: string; initiative: string; open_path: string;
                          close_path: string; open_id: string; scored: boolean }>(`
    with touched as (
      select distinct d.team_slug, d.initiative
        from zz.doc d
        join zz.run r on r.id = d.produced_by_run_id
        join zz.plugin_version_skill pvs on pvs.skill_version_id = r.skill_version_id
        join zz.plugin_version pv on pv.id = pvs.plugin_version_id
        join zz.plugin p on p.id = pv.plugin_id
       where p.name = $1 and pv.version = $2
    ),
    ends as (
      select t.team_slug, t.initiative,
             (array_agg(d.path order by sd.ord))[1]            as open_path,
             (array_agg(d.id::text order by sd.ord))[1]        as open_id,
             (array_agg(d.path order by sd.ord desc))[1]       as close_path,
             count(*)                                          as docs
        from touched t
        join zz.doc d on d.team_slug = t.team_slug and d.initiative = t.initiative
        -- STAGE ORDER, NOT CLOCK ORDER. A flow can revisit a stage -- an audit sends the spec
        -- back -- so the newest write is not the furthest point reached. The manifest's
        -- position is what "first" and "last" mean here.
        join unnest($3::text[]) with ordinality as sd(path, ord) on sd.path = d.path
       group by t.team_slug, t.initiative
    )
    select e.team_slug, e.initiative, e.open_path, e.close_path, e.open_id,
           exists (select 1 from zz.eval_subject es
                    where es.doc_id = e.open_id::uuid
                      and es.plugin_version_id = (select pv.id from zz.plugin_version pv
                                                    join zz.plugin p on p.id = pv.plugin_id
                                                   where p.name = $1 and pv.version = $2)) as scored
      from ends e
     where e.docs > 1 and e.close_path = $4
     order by e.initiative desc limit ${SUBJECT_CAP}`,
    [plugin, version, stageDocs, stageDocs[stageDocs.length - 1]])).rows;
}

/** The documents THIS FLOW'S OWN STAGES produce, in the order the stages run.
 *
 * `produces` is one of a filename, `source`, `record` or `nothing`, and only the first is a
 * document of this flow's. A plugin that declares no stages, or none that write a document,
 * returns an empty list and cannot be judged on its initiatives at all — which is the correct
 * answer for a plugin that is not a flow. */
export function stageDocsOf(plugin: string): string[] {
  const out: string[] = [];
  for (const s of entryOf(plugin)?.manifest.stages ?? []) {
    if (/\.md$/.test(s.produces) && !out.includes(s.produces)) out.push(s.produces);
  }
  return out;
}
