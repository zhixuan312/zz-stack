/**
 * What a plugin version's subjects are — the one question, answered four ways.
 *
 * plugin-judge.ts runs the round: the tools, the ruler guard, the control and the threshold
 * pass. This one answers what is being marked, and only that.
 *
 * All four are selectors and none of them reads an artifact. Bodies are fetched at the moment a
 * subject is marked, so a round that stops early never paid to read what it did not mark.
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

/** The documents this plugin version governs, newest first — and which route says so depends
 *  on whether the plugin owns a door.
 *
 * DELIBERATE: a flow's documents are the ones `zz.doc.flow` names, never
 * `zz.doc.produced_by_run_id`. That column is null on almost every document, because a document
 * is written by whatever is holding the conversation and only some of those carry a run; a
 * round joined through it scores a fraction of the corpus and reports it as the plugin's usage
 * evidence. `flow` is stamped on the document when it is written, from the flow that governs
 * the initiative, and needs no run to exist.
 *
 * Counted across every version, the way the door arm counts tool use: a document governed by
 * this flow is this flow's work whichever release was current while it was written.
 *
 * A door-owner's documents are the ones written through its door. zz-core's own skills barely
 * write documents — every document is written by another flow's stage calling zz-core's
 * `document_write` — so a skill join returns nothing for the one plugin that touches every
 * document there is, and the round falls through to marking run transcripts against a ruler
 * whose dimensions ask about documents.
 *
 * The door route attributes a document to a plugin when that plugin's door recorded work on the
 * document's initiative. `zz.event` carries the initiative and the door but not the document's
 * path, so this is the finest link the record holds. The round's denominator is what the report
 * prints beside the cap.
 *
 * `scored` says whether a round has already marked it, which the define stage needs before it
 * writes anything: a ruler derived from work already judged under an earlier ruler is a ruler
 * fitted to its own answers. */
export async function usageDocs(
  p: pg.Pool, plugin: string, version: string, ownsDoor: boolean, flowName: string,
) {
  const pvId = `(select pv.id from zz.plugin_version pv join zz.plugin p on p.id = pv.plugin_id
                  where p.name = $1 and pv.version = $2)`;
  // A plugin the catalog does not carry governs no flow, so no document is attributable to it.
  // Empty is the honest answer and plugin_profile reports it as the gap it is.
  if (!ownsDoor && !flowName) return [];
  return ownsDoor
    ? (await p.query<{ team_slug: string; initiative: string; path: string; id: string; scored: boolean }>(`
        select d.team_slug, d.initiative, d.path, d.id::text as id,
               exists (select 1 from zz.eval_subject es
                        where es.doc_id = d.id and es.plugin_version_id = ${pvId}) as scored
          from zz.doc d
         where d.path not like '\_versions/%'
           -- A call that wrote a document, not any call at all: a door whose calls merely happened
           -- while an initiative was the session's context has not produced that initiative's
           -- documents, and crediting it would mark one plugin's artifacts under another's ruler.
           --
           -- The writing tools are spelled out rather than matched by prefix: document_read,
           -- document_list, document_present and document_approve begin the same way and write
           -- nothing.
           --
           -- tool_call is implied by the tool names but kept explicit: zz.event.team_slug is nullable,
           -- and other kinds are written by acts that belong to a person rather than a team.
           and exists (select 1 from zz.event e
                        where e.kind = 'tool_call' and e.plugin = $1
                          and split_part(coalesce(e.tool_key, e.subject), ':', 2)
                              in ('document_write', 'document_patch', 'document_revise')
                          and e.initiative = d.initiative and e.team_slug = d.team_slug)
         order by d.created_at desc limit ${SUBJECT_CAP}`, [plugin, version])).rows
    : (await p.query<{ team_slug: string; initiative: string; path: string; id: string; scored: boolean }>(`
        select d.team_slug, d.initiative, d.path, d.id::text as id,
               exists (select 1 from zz.eval_subject es
                        where es.doc_id = d.id and es.plugin_version_id = ${pvId}) as scored
          from zz.doc d
         where d.flow = $3 and d.path not like '\_versions/%'
         order by d.created_at desc limit ${SUBJECT_CAP}`, [plugin, version, flowName])).rows;
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

/** The initiatives this flow carried to its own end, each with its first and last document.
 *
 * The subject is the sequence, not a document: "does the end deliver what the beginning asked
 * for" cannot be asked of one file.
 *
 * DELIBERATE: which initiatives are this flow's is answered by `zz.doc.flow`, never
 * `zz.doc.produced_by_run_id`, which is null on most documents because only some conversations
 * carry a run. `flow` is stamped on the document when it is written, from the flow that governs
 * the initiative, and is the same string the catalog entry carries.
 *
 * Counted across every version, the way a door plugin's tool use is: an initiative governed by
 * this flow is this flow's work whichever release was current while it ran, and version-scoping
 * it reports a plugin's whole history as empty after a release that changed nothing in it.
 *
 * The ends are not the oldest and newest file in the folder. An initiative folder holds more
 * than the flow's stage output: `source_add` registers supporting material under `sources/`,
 * and `handover.md` is written after the close by a different plugin's skill, so ordering by
 * the clock hands a ruler a stakeholder attachment and a spec. The manifest says which
 * documents are this flow's: `stages[].produces`, in the order the stages run, whenever it
 * names a file rather than `source`, `record` or `nothing`. That list arrives as `$4` and the
 * join to it excludes everything else without naming any of it.
 *
 * The closing document must be there and approved. `$5` is the last entry in that list, and an
 * initiative without it is not a subject: an initiative still in flight has no end, and one
 * whose closing document was written and never signed has not finished its own gate, so judging
 * it as a delivered arc measures the work's incompleteness rather than the plugin. */
export async function usageInitiatives(
  p: pg.Pool, plugin: string, version: string, stageDocs: string[], flowName: string,
) {
  if (stageDocs.length < 2 || !flowName) return [];
  return (await p.query<{ team_slug: string; initiative: string; open_path: string;
                          close_path: string; open_id: string; scored: boolean }>(`
    with touched as (
      select distinct d.team_slug, d.initiative
        from zz.doc d where d.flow = $3
    ),
    ends as (
      select t.team_slug, t.initiative,
             (array_agg(d.path order by sd.ord))[1]            as open_path,
             (array_agg(d.id::text order by sd.ord))[1]        as open_id,
             (array_agg(d.path order by sd.ord desc))[1]       as close_path,
             count(*)                                          as docs
        from touched t
        join zz.doc d on d.team_slug = t.team_slug and d.initiative = t.initiative
        -- Stage order, not clock order: a flow can revisit a stage, so the newest write is not the
        -- furthest point reached. The manifest's position is what "first" and "last" mean here.
        join unnest($4::text[]) with ordinality as sd(path, ord) on sd.path = d.path
       group by t.team_slug, t.initiative
    )
    select e.team_slug, e.initiative, e.open_path, e.close_path, e.open_id,
           exists (select 1 from zz.eval_subject es
                    where es.doc_id = e.open_id::uuid
                      and es.plugin_version_id = (select pv.id from zz.plugin_version pv
                                                    join zz.plugin p on p.id = pv.plugin_id
                                                   where p.name = $1 and pv.version = $2)) as scored
      from ends e
      -- Signed, not merely written: an unsigned closing document is not delivered work.
      join zz.doc cd on cd.team_slug = e.team_slug and cd.initiative = e.initiative
                    and cd.path = e.close_path and cd.status = 'approved'
     where e.docs > 1 and e.close_path = $5
     order by e.initiative desc limit ${SUBJECT_CAP}`,
    [plugin, version, flowName, stageDocs, stageDocs[stageDocs.length - 1]])).rows;
}

/** The documents this flow's own stages produce, in the order the stages run.
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
