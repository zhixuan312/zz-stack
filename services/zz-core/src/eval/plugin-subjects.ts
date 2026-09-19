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

/** The documents this plugin version GOVERNS, newest first — and which route says so depends
 *  on whether the plugin owns a door.
 *
 * A FLOW'S DOCUMENTS ARE THE ONES ITS STAGES WROTE, through the skill membership recorded at
 * release. That is the `false` arm, and it is right for a flow: sdlc's documents are the ones
 * sdlc's stages produced, and no others.
 *
 * A DOOR-OWNER'S DOCUMENTS ARE THE ONES WRITTEN THROUGH ITS DOOR, and the skill route gets
 * that badly wrong. zz-core's own skills barely write documents — every document on this
 * platform is written by another flow's stage CALLING zz-core's `document_write` — so the
 * skill join returned nothing for the one plugin that touches every document there is. The
 * consequence was not an empty round: it was a SILENT SUBSTITUTION. With no documents found,
 * the round fell through to marking run transcripts against a ruler whose dimensions ask
 * whether documents carry their frontmatter, cite their evidence and move version on approval.
 * A transcript answers none of those, so it scored 1.68 to 1.94 — and the report drawn from it
 * would have called the backbone weak for the second time, on the same mistaken attribution,
 * in the other half of the same file.
 *
 * The door route attributes a document to a plugin when that plugin's door recorded work on
 * the document's INITIATIVE. `zz.event` carries the initiative and the door but not the
 * document's path, so this is the finest link the record actually holds; it reaches 211 of the
 * platform's 365 documents where the run route reached 13. Announced rather than hidden — the
 * round's denominator is what the report prints beside the cap.
 *
 * `scored` says whether a round has already marked it, and it is a fact the define stage needs
 * before it writes anything: a ruler derived from work that was already judged under an earlier
 * ruler is a ruler fitted to its own answers. */
export async function usageDocs(p: pg.Pool, plugin: string, version: string, ownsDoor: boolean) {
  const pvId = `(select pv.id from zz.plugin_version pv join zz.plugin p on p.id = pv.plugin_id
                  where p.name = $1 and pv.version = $2)`;
  return ownsDoor
    ? (await p.query<{ team_slug: string; initiative: string; path: string; id: string; scored: boolean }>(`
        select d.team_slug, d.initiative, d.path, d.id::text as id,
               exists (select 1 from zz.eval_subject es
                        where es.doc_id = d.id and es.plugin_version_id = ${pvId}) as scored
          from zz.doc d
         where d.path not like '\_versions/%'
           -- A CALL THAT WROTE A DOCUMENT, not any call at all.
           --
           -- Matching on every tool_call credited a door with documents it never touched. An
           -- administration door proved it: two whoami and team_switch calls happened while
           -- an evaluation initiative was the session's context, so the event carried that
           -- initiative, and the query handed zz-access the whole of zz-core's evaluation to be
           -- judged on. That is the same substitution this file already refuses elsewhere --
           -- marking one plugin's artifacts under another plugin's ruler -- arriving through
           -- the selector instead of the fallback.
           --
           -- The three names are spelled out rather than matched by prefix. document_read,
           -- document_list, document_present and document_approve all begin the same way
           -- and none of them writes anything; a plugin whose door only READS documents has not
           -- produced them and must not be judged on them.
           --
           -- tool_call is implied by the tool names but kept explicit, because zz.event.team_slug
           -- is nullable and other kinds are written by acts that belong to a person rather than
           -- a team -- matching a document's team against one of those compares on a column that
           -- kind never filled.
           and exists (select 1 from zz.event e
                        where e.kind = 'tool_call' and e.plugin = $1
                          and split_part(coalesce(e.tool_key, e.subject), ':', 2)
                              in ('document_write', 'document_patch', 'document_revise')
                          and e.initiative = d.initiative and e.team_slug = d.team_slug)
         order by d.created_at desc limit ${SUBJECT_CAP}`, [plugin, version])).rows
    : (await p.query<{ team_slug: string; initiative: string; path: string; id: string; scored: boolean }>(`
        select d.team_slug, d.initiative, d.path, d.id::text as id,
               exists (select 1 from zz.eval_subject es
                        where es.doc_id = d.id and es.plugin_version_id = pv.id) as scored
          from zz.doc d
          join zz.run r on r.id = d.produced_by_run_id
          join zz.plugin_version_skill pvs on pvs.skill_version_id = r.skill_version_id
          join zz.plugin_version pv on pv.id = pvs.plugin_version_id
          join zz.plugin p on p.id = pv.plugin_id
         where p.name = $1 and pv.version = $2 and d.path not like '\_versions/%'
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

/** The INITIATIVES this flow CARRIED TO ITS OWN END, each with both of them.
 *
 * The subject is the sequence, not a document: "does the end deliver what the beginning asked
 * for" cannot be asked of one file. So each row is one initiative with the first and the last
 * of THE DOCUMENTS THIS FLOW'S OWN STAGES DECLARE.
 *
 * WHICH INITIATIVES ARE THIS FLOW'S IS ANSWERED BY `zz.doc.flow`, AND THAT IS THE THIRD TIME
 * THIS FILE HAS HAD TO LEARN IT. The first two routes both went through
 * `zz.doc.produced_by_run_id` -> a run -> the skill versions a plugin version shipped. That
 * column is null on 326 of this platform's 365 documents, because a document is written by
 * whatever is holding the conversation and only some of those carry a run. The consequence was
 * not an error: the query returned 3 initiatives where the store holds 17 governed by this
 * flow, and 1 of them had reached its closing document where 6 have. A round was scored on one
 * subject and reported as thin evidence, when the evidence was there and the join could not
 * see it.
 *
 * `flow` is stamped on the document when it is written, from the flow that governs the
 * initiative, and it is the same string the catalog entry carries. It needs no run to exist.
 *
 * COUNTED ACROSS EVERY VERSION, deliberately, the way a door plugin's tool use is. An
 * initiative governed by this flow is this flow's work whichever release happened to be
 * current while it ran, and version-scoping it reported a plugin's whole history as empty four
 * minutes after a release that changed nothing in it.
 *
 * NOT THE OLDEST AND NEWEST FILE IN THE FOLDER either, which is what the ends used to be. An
 * initiative folder holds more than the flow's stage output: `source_add` registers supporting
 * material under `sources/`, and `handover.md` is written after the close by a different
 * plugin's skill. Ordered by the clock, those won both ends — so a ruler asking whether the
 * conclusion answers the brief was handed a stakeholder attachment and a spec, and marked them
 * 4.55. The manifest says which documents are this flow's: `stages[].produces`, in the order
 * the stages run, whenever it names a file rather than `source`, `record` or `nothing`. That
 * list arrives as `$3` and the join to it excludes everything else without naming any of it.
 *
 * AND THE CLOSING DOCUMENT MUST BE THERE. `$4` is the last entry in that list, and an
 * initiative without it is not a subject. An initiative still in flight has no end, and
 * feeding `explore.md -> spec.md` to a ruler that asks about DELIVERY marks the spec as though
 * it were the deliverable. */
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
        -- STAGE ORDER, NOT CLOCK ORDER. A flow can revisit a stage -- an audit sends the spec
        -- back -- so the newest write is not the furthest point reached. The manifest's
        -- position is what "first" and "last" mean here.
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
     where e.docs > 1 and e.close_path = $5
     order by e.initiative desc limit ${SUBJECT_CAP}`,
    [plugin, version, flowName, stageDocs, stageDocs[stageDocs.length - 1]])).rows;
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
