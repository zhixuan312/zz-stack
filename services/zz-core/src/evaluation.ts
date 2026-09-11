/**
 * The evaluation queries, in ONE place, behind MCP tools.
 *
 * They began as `.mjs` scripts beside their skills — which was right, and half of an answer.
 * An agent on this platform has MCP tools and no shell, so a stage that says "run
 * scripts/profile.mjs" is a stage an agent cannot perform: the evaluation flows were
 * unrunnable by the very thing meant to run them.
 *
 * The fix is not to duplicate the SQL here and leave the scripts alongside — two copies of a
 * query drift, and a round that counted differently from the last is worse than one that did
 * not run. So the implementation lives HERE and has two front doors: these tools for an
 * agent, and the scripts, which now call them, for a terminal.
 *
 * READ-ONLY, ALL OF THEM. Evaluation measures; nothing here writes. The one part of
 * evaluation that must not be a tool is the JUDGING: that runs a pinned model through the
 * claude CLI, deliberately outside the conversation, because a judge an agent could invoke is
 * a judge that varies with the agent.
 */
import type pg from "pg";

export interface Row { [k: string]: unknown }

/** Every query below returns rows; the caller renders. One shape, so a tool cannot format
 *  what a script would not. */
async function q(p: pg.Pool, sql: string, args: unknown[] = []): Promise<Row[]> {
  return (await p.query(sql, args)).rows as Row[];
}

/** Every ruler this SKILL has, affirmed or not.
 *
 * skillVersions() joins `zz.rubric` through `skill_version.rubric_id` — the AFFIRMED link —
 * so a rubric that is loaded and not yet affirmed is invisible to it. eval_skill_ruler's
 * description promises "every rubric the skill has, and which version declares which", and it
 * delivered only the second half.
 *
 * That is not a reporting nicety. zz-skill-define's decision table branches on it: told
 * `rubric_version: null, dims: 0`, the stage correctly concludes "no ruler exists, derive one"
 * — and derives one in a vacuum, beside a rubric the catalog already ships. It happened on the
 * first real run: using-casebox had two loaded rubrics, three dimensions each, and the
 * stage was told there were none, so it hand-wrote a third that scored obedience to conduct
 * rules this platform had already decided were harmful in its flows. Every skill on the shelf
 * is in that state, so it would have happened fifteen times. */
export async function skillRubrics(p: pg.Pool, skill: string): Promise<Row[]> {
  return q(p, `
    select r.version as rubric_version, r.id::text as rubric_id, r.subject,
           to_char(r.created_at,'YYYY-MM-DD') as loaded_on,
           (select count(*) from zz.rubric_dimension d where d.rubric_id = r.id) as dims,
           coalesce((select string_agg(sv.version, ', ' order by sv.version)
                       from zz.skill_version sv where sv.rubric_id = r.id), '') as affirmed_for
      from zz.rubric r join zz.skill s on s.id = r.skill_id
     where s.name = $1
     order by r.version::numeric desc`, [skill]);
}

/** A skill's identity, versions, and the ruler each version declares. */
export async function skillVersions(p: pg.Pool, skill: string): Promise<Row[]> {
  return q(p, `
    select s.name as skill, s.kind, coalesce(s.flow, b.name) as owner, b.origin,
           sv.version, sv.id::text as version_id, sv.body_hash,
           to_char(sv.released_at, 'YYYY-MM-DD') as released_at,
           (sv.released_at = max(sv.released_at) over ()) as is_latest,
           r.version as rubric_version, r.id::text as rubric_id, r.subject as rubric_subject,
           (select count(*) from zz.rubric_dimension d where d.rubric_id = r.id) as dims
      from zz.skill s
      left join zz.block b on b.id = s.block_id
      join zz.skill_version sv on sv.skill_id = s.id
      left join zz.rubric r on r.id = sv.rubric_id
     where s.name = $1
     order by sv.released_at desc nulls last, sv.version desc`, [skill]);
}

/** Reach and cost. NOT per version: zz.event records the step by NAME and carries no
 *  version, so a per-version split of these would be invented. */
export async function skillCounts(p: pg.Pool, skill: string): Promise<Row[]> {
  return q(p, `
    select
      (select count(*) from zz.event e where e.kind = 'tool_call'
        and e.subject = 'core:skill_view' and e.detail->'ids'->>'name' = $1) as loads,
      (select count(*) from zz.event e where e.step = $1) as stamped,
      (select count(*) from zz.event e where e.step = $1 and e.ok is false) as refused,
      (select count(*) from zz.event e where e.step = $1 and e.ok is true) as ok_calls,
      (select count(distinct e.detail->>'run') from zz.event e
        where e.step = $1 and e.detail ? 'run') as runs,
      (select count(distinct e.initiative) from zz.event e
        where e.step = $1 and e.initiative is not null) as initiatives,
      to_char((select min(e.ts) from zz.event e where e.step = $1),'YYYY-MM-DD') as first_seen,
      to_char((select max(e.ts) from zz.event e where e.step = $1),'YYYY-MM-DD') as last_seen`, [skill]);
}

/** Documents produced BY THIS VERSION, per document name. The one figure that is genuinely
 *  per version, through doc.produced_by_run_id -> run.skill_version_id. Counts, never bodies:
 *  what a version produced belongs in a profile, what it said belongs to the judge. */
export async function skillDocuments(p: pg.Pool, versionId: string): Promise<Row[]> {
  return q(p, `
    select d.path, count(*) as n,
           count(*) filter (where d.status = 'approved') as approved,
           count(distinct d.initiative) as initiatives
      from zz.doc d join zz.run r on r.id = d.produced_by_run_id
     where r.skill_version_id = $1::uuid and d.path not like '\\_versions/%'
     group by d.path order by 2 desc`, [versionId]);
}

/** The runs of one version — genuinely per version, because zz.run carries it. */
export async function skillRuns(p: pg.Pool, versionId: string): Promise<Row[]> {
  return q(p, `
    select count(*) as runs, coalesce(sum(r.turns),0) as turns,
           coalesce(sum(r.calls),0) as calls, coalesce(sum(r.refusals),0) as refusals,
           round(avg(extract(epoch from (r.ended_at - r.started_at))/60)) as avg_minutes,
           round(max(extract(epoch from (r.ended_at - r.started_at))/60)) as max_minutes
      from zz.run r where r.skill_version_id = $1::uuid`, [versionId]);
}

/** WHAT THE SKILL ACTUALLY TOUCHED: how many distinct tools, on how many blocks.
 *
 * Every findings.md so far reported what a judge thought of the documents and nothing about
 * what the skill DID. ops-build made 960 calls across 88 distinct tools and three blocks in
 * the window it was judged on, and none of that reached the page — a reader was told a
 * document scored 3.22 with no idea whether the skill ran twice or two hundred times.
 *
 * Stamped by the LAST SKILL SERVED to the caller, which is the same attribution every other
 * reader of zz.event lives with. The report says so rather than implying the numbers are
 * exact. */
export async function skillSurface(p: pg.Pool, skill: string): Promise<Row[]> {
  return q(p, `
    select count(distinct e.subject) as tools,
           count(distinct e.block) filter (where e.block is not null) as blocks,
           string_agg(distinct e.block, ', ') filter (where e.block is not null) as block_names
      from zz.event e where e.step = $1 and e.kind = 'tool_call'`, [skill]);
}

/** HOW MANY DISTINCT SUBJECTS THIS VERSION HAS ACTUALLY BEEN SCORED ON, across every round.
 *
 * Not "the last evaluation's subject count", which is what the coverage line first used and
 * which understates the moment a round is resumed. ops-verify v1.0 was judged in two sessions
 * — a call timed out after 3 subjects and finished server-side, the next call scored the
 * remaining 7 — so the last row says 3 and the truth is 7. A denominator is worth nothing if
 * the numerator beside it is a session's tally rather than the version's. */
export async function judgedSubjects(p: pg.Pool, versionId: string): Promise<Row[]> {
  // COUNT THE ARTIFACT, not the row. zz.eval_subject mints a fresh row per evaluation, so
  // distinct subject_id counted the same seven documents once per round and reported 17 of 7.
  // The thing judged is the document, the run or the path, which is exactly the key
  // eval_skill_judge dedupes a resumed round on.
  return q(p, `
    select count(distinct coalesce(es.doc_id::text, es.run_id::text, es.path)) as judged
      from zz.eval_score sc
      join zz.eval ev on ev.id = sc.eval_id
      join zz.eval_subject es on es.id = sc.subject_id
     where ev.skill_version_id = $1::uuid and sc.is_control is false`, [versionId]);
}

export async function skillRefusals(p: pg.Pool, skill: string): Promise<Row[]> {
  return q(p, `
    select coalesce(e.refusal,'(no text)') as refusal, count(*) as n
      from zz.event e where e.step = $1 and e.ok is false
     group by 1 order by 2 desc limit 8`, [skill]);
}

/** Runs that called a block skill's BLOCK and never opened the skill. A skill nobody opened
 *  is unmeasured rather than poor, and no other number says so. */
export async function skillBlind(p: pg.Pool, skill: string, block: string): Promise<Row[]> {
  return q(p, `
    with calling as (
      select distinct e.detail->>'run' as run from zz.event e
       where e.block = $2 and e.detail ? 'run'),
    loaded as (
      select distinct e.detail->>'run' as run from zz.event e
       where e.kind='tool_call' and e.subject='core:skill_view'
         and e.detail->'ids'->>'name' = $1 and e.detail ? 'run')
    select $2 as block,
           (select count(*) from calling) as runs_calling,
           (select count(*) from calling c where not exists
              (select 1 from loaded l where l.run = c.run)) as runs_blind,
           (select count(*) from zz.event e where e.block = $2) as block_calls`, [skill, block]);
}

/** Every score ever taken, oldest first — cumulative, never a delta. */
export async function skillEvaluations(p: pg.Pool, skill: string): Promise<Row[]> {
  return q(p, `
    select sv.version, ev.judge_model as judge, r.version as rubric,
           -- STARTED, when the round never recorded a finish. A resumed evaluation whose
           -- last call landed server-side leaves finished_at null, and the table printed a
           -- literal "null" in the date column of a round that plainly happened.
           to_char(coalesce(ev.finished_at, ev.started_at),'YYYY-MM-DD') as on_date,
           (ev.finished_at is null) as unfinished,
           count(distinct sc.subject_id) as subjects, round(avg(sc.score),2) as mean
      from zz.eval ev
      join zz.skill_version sv on sv.id = ev.skill_version_id
      join zz.skill s on s.id = sv.skill_id
      join zz.rubric r on r.id = ev.rubric_id
      left join zz.eval_score sc on sc.eval_id = ev.id and sc.is_control is false
     where s.name = $1
     group by 1,2,3,4,5, ev.finished_at, ev.started_at
     -- AN EVAL WITH NO SCORES IS AN OPEN ROUND, not a result, and it was reported as one:
     -- every report carried a subjects-0 mean-null row and then a paragraph of prose
     -- explaining that the tool own output meant nothing. A round that has scored nothing
     -- has nothing to say here; remaining on eval_skill_judge is where an open round lives.
    having count(sc.subject_id) > 0
     order by ev.started_at`, [skill]);
}

export async function skillDimensions(p: pg.Pool, skill: string): Promise<Row[]> {
  return q(p, `
    select r.version as rubric, ev.judge_model as judge, d.name as dimension,
           count(*) as n, round(avg(sc.score),2) as mean,
           min(sc.score) as worst, max(sc.score) as best
      from zz.eval_score sc
      join zz.eval ev on ev.id = sc.eval_id
      join zz.rubric r on r.id = ev.rubric_id
      join zz.rubric_dimension d on d.id = sc.dimension_id
      join zz.skill_version sv on sv.id = ev.skill_version_id
      join zz.skill s on s.id = sv.skill_id
     where s.name = $1 and sc.is_control is false
     group by 1,2,3,d.ordinal order by 1,2,d.ordinal`, [skill]);
}

/** The judge on trial: the real mean against the control.
 *
 * NOT "scrambled", which is what this said and what the reports repeated. The control is
 * ANOTHER SKILL'S WORK OF THE SAME KIND — another initiative's document, another skill's run
 * trace, another skill's text — scored under THIS skill's ruler. Nothing is degraded or
 * shuffled.
 *
 * The difference decides what a gap means. A document ruler is stage-specific, so another
 * stage's document genuinely cannot satisfy it and the gap is large: every document round on
 * this deployment cleared by 2.25 to 3.73. A body ruler asks generic questions about a
 * skill's text, and another decent skill's text answers them perfectly well — so the control
 * CANNOT FAIL, and all four body rounds came out at or below zero. That is a fact about the
 * ruler, not about the judge or the skill, and calling the control "scrambled" hid it. */
export async function skillControl(p: pg.Pool, skill: string): Promise<Row[]> {
  return q(p, `
    select r.version as rubric, ev.judge_model as judge,
           round(avg(sc.score) filter (where sc.is_control is false),2) as real_mean,
           round(avg(sc.score) filter (where sc.is_control is true),2) as control_mean
      from zz.eval_score sc
      join zz.eval ev on ev.id = sc.eval_id
      join zz.rubric r on r.id = ev.rubric_id
      join zz.skill_version sv on sv.id = ev.skill_version_id
      join zz.skill s on s.id = sv.skill_id
     where s.name = $1
     group by 1,2 having count(*) filter (where sc.is_control is true) > 0`, [skill]);
}

/** A block's recorded surface, newest version first, with the observed byte cost. */
export async function blockSurface(p: pg.Pool, block: string): Promise<Row[]> {
  return q(p, `
    select bv.id::text as version_id, bv.version,
           to_char(bv.first_seen_at,'YYYY-MM-DD') as seen,
           (select count(*) from zz.block_tool t where t.block_version_id = bv.id) as tools
      from zz.block_version bv join zz.block b on b.id = bv.block_id
     where b.name = $1 order by bv.first_seen_at desc limit 2`, [block]);
}

export async function blockTools(p: pg.Pool, versionId: string): Promise<Row[]> {
  return q(p, `
    select t.name, t.verdict, t.calls_observed as calls,
           t.observed_bytes_avg as avg_bytes, t.observed_bytes_max as max_bytes
      from zz.block_tool t where t.block_version_id = $1::uuid
     order by t.observed_bytes_max desc nulls last, t.name`, [versionId]);
}

/** WHAT MOVED — a renamed or removed tool breaks every caller silently. */
export async function blockMoved(p: pg.Pool, cur: string, prev: string): Promise<Row[]> {
  return q(p, `
    with now_t as (select name from zz.block_tool where block_version_id = $1::uuid),
         was_t as (select name from zz.block_tool where block_version_id = $2::uuid)
    select 'gone' as how, name from was_t where name not in (select name from now_t)
    union all
    select 'new' as how, name from now_t where name not in (select name from was_t)
    order by 1,2`, [cur, prev]);
}

/** Tool by tool, ordered by USAGE LOAD. The most-used tool is where a problem costs most; a
 *  list ordered by failures puts a tool called twice above one called four hundred times. */
export async function blockUsage(p: pg.Pool, block: string): Promise<Row[]> {
  return q(p, `
    select e.subject as tool, count(*) as calls,
           count(*) filter (where e.ok is false) as refused,
           round(100.0 * count(*) filter (where e.ok is false) / count(*)) as pct_refused,
           count(distinct e.initiative) filter (where e.initiative is not null) as initiatives,
           to_char(min(e.ts),'MM-DD') as first_seen, to_char(max(e.ts),'MM-DD') as last_seen
      from zz.event e where e.block = $1 and e.kind = 'tool_call'
     group by 1 order by count(*) desc`, [block]);
}

/** Refusal classes and how far each spread. Two or more unrelated initiatives makes it the
 *  block's; one may be a single run's mistake. */
export async function blockRefusals(p: pg.Pool, block: string): Promise<Row[]> {
  return q(p, `
    select e.subject as tool, coalesce(left(e.refusal,120),'(no text)') as refusal,
           count(*) as n,
           count(distinct e.initiative) filter (where e.initiative is not null) as initiatives,
           to_char(max(e.ts),'YYYY-MM-DD') as last_seen
      from zz.event e where e.block = $1 and e.ok is false
     group by 1,2 order by 4 desc, 3 desc limit 15`, [block]);
}

/** Knowledge nodes about a block, under EITHER tag convention, superseded ones excluded.
 *  A snapshot, not a history: a claim, its correction and the correction's refinement are one
 *  fact and two dead ends. */
export async function blockNodes(p: pg.Pool, block: string): Promise<Row[]> {
  return q(p, `
    select d.path, d.title, d.tags::text as tags,
           to_char(d.updated_at,'YYYY-MM-DD') as written,
           (current_date - d.updated_at::date) as days_old,
           substring(d.body from 'verified_against:[ ]*"?([^"\\n]*)') as verified_against
      from zz.doc d
     where d.initiative = '_knowledge' and d.path like 'nodes/%'
       and (d.tags @> array['block:' || $1] or d.tags @> array[$1])
       and coalesce(d.superseded_by,'') = ''
       and d.body not ilike '%supersededBy: 00%'
     order by d.path desc`, [block]);
}
