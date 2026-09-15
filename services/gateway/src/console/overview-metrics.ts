/**
 * The four numbers the overview leads with, and the marks drawn under them.
 *
 * ONE QUESTION EACH, AND THEY DO NOT OVERLAP: is work progressing (initiative), is what we
 * write down worth reading (knowledge), is the tool surface breaking (tools), is the system
 * straining (system). The row used to lead with `events` and `documents` — a count that
 * quadruples when somebody imports an archive and a union of two unrelated things — and
 * neither answered a question anybody opening this page has.
 *
 * NO PROSE IS COMPOSED HERE OR IN THE BROWSER. Every string on a tile is a fixed label that
 * ships with the component or a template with these numbers substituted into it. The console
 * must render without a model in the path, so the API sends figures and the component owns
 * the words.
 *
 * Split out of overview.ts rather than added to it: that file already carries the census,
 * the trend and the refusal table, and four metrics with a platform and a team statement
 * apiece is not a tail somebody should have to scroll past to reach them.
 */
import type { Pool } from "pg";

import { flowShape } from "./shared.js";
import type { ResolvedScope } from "./shared.js";

/** More than this many nodes minted by one source in a single hour is an archive import.
 *
 * A BEHAVIOUR, NOT A LIST OF NAMES. The alternative was matching slugs containing
 * "archive", which is a rule that holds until somebody names an initiative differently.
 * The separation this produces on live data is not marginal: the three imports peak in the
 * hundreds per hour, and everything written by an initiative that was also doing work
 * peaks in single digits. The threshold is stated on the tile that uses it. */
const IMPORT_NODES_PER_HOUR = 50;

/** How complete one initiative is against ITS OWN flow's declared documents.
 *
 * Never against a document called `spec.md`. A flow declares `documents[]` and marks which
 * of them are gates; sdlc-flow declares three and gates two, another flow declares its own
 * set and may gate none. Scoring against one flow's filenames renders every other flow as
 * permanently stuck, which is the mistake the funnel on the old design made.
 *
 * Absent counts 0, written counts a half, approved counts 1 — so an initiative that has
 * drafted everything and had nothing approved reads as halfway, which is what it is. */
type Stage = "noflow" | "notstarted" | "drafting" | "agreed" | "gated" | "closed";

interface OverviewMetrics {
  /** 1 · initiative. Median completeness across the initiatives active in the window. */
  progressing: {
    /** Null when nothing scoreable was active. Percent, 0–100. */
    value: number | null;
    active: number;
    scoreable: number;
    /** Every active initiative in exactly one stage — the mark under the tile. */
    stages: Record<Stage, number>;
    /** Why this tile carries no delta. Stated by the API so the browser invents nothing. */
    noDeltaBecause: string;
  };
  /** 2 · knowledge. Share of the shelf minted by work rather than dumped by an import.
   *
   * BOTH SPELLINGS OF THE SEARCH TOOL ARE COUNTED. `tool-telemetry.ts` resolves a subject
   * through `resolveToolKey` as it WRITES, so rows recorded from this release on say
   * `core:knowledge_search` while every row already in the table says `core:search_knowledge`
   * — the name it was called by before TOOL_ALIAS carried the rename. Matching one spelling
   * counts half the history and the half it counts changes on the day of a deploy. */
  knowledge: {
    value: number | null;
    prev: number | null;
    fromWork: number; imported: number;
    /** Knowledge searches in the window.
     *
     * WHICH NODES CAME BACK IS NOW RECORDED, as of the release this ships in: knowledge_search
     * writes a `knowledge.search` event carrying the ids it returned, so "which nodes does
     * anybody actually read" has an answer for the first time. This tile still counts searches
     * rather than reading those ids — the events only start accumulating now, and a tile whose
     * history begins today would read as a platform nobody had ever searched. */
    searches: number;
    importThresholdPerHour: number;
  };
  /** 3 · tools. Refusal rate in points. */
  refusals: {
    value: number | null; prev: number | null;
    refused: number; calls: number;
    /**
     * WHICH DOOR IS REFUSING — the mark under the tile, and the one thing the rate itself
     * cannot say. "9.3% refused" names a number to worry about; this names where to go.
     * Largest first, and it sums EXACTLY to `refused`: same predicate
     * (`kind='tool_call' and ok = false`), grouped rather than counted.
     *
     * THE DOOR COMES FROM `subject`, NOT FROM `block`. 0.40.0 grouped by `event.block` and
     * shipped a mark that could only ever be one full-width slice: `block` is null on every
     * tool_call this platform has ever recorded — 781 of 781, all time — so every refusal
     * landed in the same `(platform)` bucket and the bar drew the number a second time.
     * `subject` is `<door>:<tool>` and is always present, which makes core / eval / manage
     * a real split.
     *
     * NOT the `refusals[]` list on the overview payload, which is a top-12 of every failed
     * event of any kind — a different population with a different total, and so not a
     * composition of anything this tile states.
     */
    byDoor: { door: string; n: number }[];
  };
  /** 4 · system. Bytes a run hands back to the agent, which is context it must then carry. */
  context: {
    /** KB. Median of the runs started in the window. */
    value: number | null; prev: number | null;
    p90: number | null;
    /** One entry per MEASURED run, for the distribution mark. The median alone hides a
     *  tail that runs two orders of magnitude past it. */
    runs: { kb: number; skill: string }[];
    /** Runs whose bytes were never measured. Counted and excluded, never folded in as
     *  zero — see the note where the rows are read. */
    unmeasured: number;
    /** Rule of thumb at ~4 bytes per token. NOT a measurement: nothing on this platform
     *  counts tokens, and the tile says so. */
    contextWindowKb: number;
  };
}

const CONTEXT_WINDOW_KB = 800;

/** A `count(*)`, which is never SQL-null — the `?? 0` guards an absent ROW, not a null
 *  aggregate, and this helper must never be pointed at one. An aggregate that can come back
 *  null (`sum`, `avg`, a nullable column) is tested for null at its own call site and
 *  reported as unmeasured; see where the run bytes are read. `checks/console-nulls.ts`
 *  pins both halves. */
const count = (v: unknown): number => Number(v ?? 0);
const pct = (a: number, b: number): number | null => (b ? (a / b) * 100 : null);
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

/** Where one initiative has got to, from the documents that exist and their approvals. */
function progressOf(
  flow: string, docs: { path: string; status: string | null; outcome: string | null }[],
): { completeness: number | null; stage: Stage } {
  const declared = flowShape(flow || null);
  if (declared.size === 0) return { completeness: null, stage: "noflow" };

  const byPath = new Map(docs.map((d) => [d.path, d.status]));
  let score = 0, present = 0, approved = 0, gates = 0, gatesCleared = 0;
  for (const [name, shape] of declared) {
    const status = byPath.get(name);
    if (shape.gate) gates++;
    if (status === undefined) continue;
    present++;
    if (status === "approved") {
      approved++; score += 1;
      if (shape.gate) gatesCleared++;
    } else {
      score += 0.5;
    }
  }
  const completeness = (score / declared.size) * 100;
  /* CLEARING EVERY GATE IS NOT BEING DONE, and collapsing the two was wrong. An initiative
   * can have every gate approved and still be open — work continues, nobody has said what
   * came of it — which is the state most of this platform's finished-looking initiatives are
   * actually in. Closure is recorded as an `outcome` on the flow's closing document and
   * nowhere else: `initiative.closed_at` is written by nothing and migration 049 removes it,
   * so a ladder that stopped at "every gate cleared" would report work as finished that
   * nobody had signed off. `gated` is the honest name for that rung. */
  const closingDoc = [...declared].find(([, d]) => d.closing)?.[0];
  const closed = closingDoc
    ? docs.some((d) => d.path === closingDoc && d.outcome !== null)
    // A flow that declares no closing document records its outcome wherever it likes; any
    // document carrying one closes it. Never "no closing document, therefore never closed".
    : docs.some((d) => d.outcome !== null);
  const allGates = gates > 0 ? gatesCleared >= gates : present >= declared.size && approved > 0;
  const stage: Stage = closed ? "closed"
    : present === 0 ? "notstarted"
      : allGates ? "gated"
        : approved > 0 ? "agreed" : "drafting";
  return { completeness, stage };
}

/**
 * Read all four, for a platform scope or one team.
 *
 * TWO COMPLETE STATEMENTS PER QUERY, never one assembled from `scope` — `check:sql` can
 * only PREPARE a literal it can read whole, and the same rule the rest of this console
 * follows applies here. The team branch reaches events through `team_id` and runs through
 * `run.initiative_id → initiative.team_id`, because `zz.run` carries no team column of its
 * own and the denormalised `event.team_slug` beside `team_id` is written only by acts that
 * belong to a team.
 *
 * `prevSince` is null for an all-time window: there is no previous all time, and a tile
 * with nothing to compare against draws no delta rather than an arrow meaning nothing.
 *
 * ACTIVE MEANS A TOOL CALL, not any event. Most events on this platform carry no run and
 * are bulk import or admin rather than somebody working, so an initiative counted active
 * because an admin act mentioned it would put a row in the stage bar that nobody touched.
 *
 * NOT FILTERED ON `initiative.deleted_at`, and there is nothing left to filter on: the column
 * was written by nothing and migration 054 drops it, for the reason this comment used to give
 * — a predicate on it excluded nothing while reading as though it did. Initiatives are not
 * deleted here; they are closed with an outcome, recorded on the flow's closing document.
 */
export async function readMetrics(
  db: Pool, scope: ResolvedScope, since: Date | null, prevSince: Date | null,
): Promise<OverviewMetrics> {
  const [calls, runs, shelf, inits, doors] = scope.kind === "platform"
    ? await Promise.all([
      db.query<{ calls: string; refused: string; prev_calls: string; prev_refused: string; searches: string }>(
        `select count(*) filter (where kind='tool_call'
                  and ($1::timestamptz is null or ts >= $1))                        as calls,
                count(*) filter (where kind='tool_call' and ok = false
                  and ($1::timestamptz is null or ts >= $1))                        as refused,
                count(*) filter (where kind='tool_call'
                  and $2::timestamptz is not null and ts >= $2 and ts < $1)         as prev_calls,
                count(*) filter (where kind='tool_call' and ok = false
                  and $2::timestamptz is not null and ts >= $2 and ts < $1)         as prev_refused,
                count(*) filter (where subject in ('core:knowledge_search','core:search_knowledge') and ok
                  and ($1::timestamptz is null or ts >= $1))                        as searches
           from zz.event
          where ($1::timestamptz is null or ts >= coalesce($2::timestamptz, $1))`,
        [since, prevSince]),
      db.query<{ bytes: string | null; skill: string; is_prev: boolean }>(
        `select r.bytes_total as bytes, s.name as skill,
                ($2::timestamptz is not null and r.started_at >= $2 and r.started_at < $1) as is_prev
           from zz.run r
           join zz.skill_version sv on sv.id = r.skill_version_id
           join zz.skill s on s.id = sv.skill_id
          where ($1::timestamptz is null or r.started_at >= coalesce($2::timestamptz, $1))
          order by r.started_at desc limit 400`,
        [since, prevSince]),
      db.query<{ from_work: string; imported: string; prev_from_work: string; prev_imported: string }>(
        // The shelf is a STOCK, so it is counted as it stands, and the comparison is the
        // same stock as it stood one window ago — not what was minted inside the window.
        `with node as (
           select coalesce(evidence[1],'') as src, created_at
             from zz.doc where initiative = '_knowledge'),
         peak as (
           select src, max(c) as ph from (
             select src, date_trunc('hour', created_at) as h, count(*) as c
               from node group by 1,2) q
            group by 1)
         select count(*) filter (where p.ph <= $2)                                   as from_work,
                count(*) filter (where p.ph >  $2)                                   as imported,
                count(*) filter (where p.ph <= $2
                  and $1::timestamptz is not null and n.created_at < $1)             as prev_from_work,
                count(*) filter (where p.ph >  $2
                  and $1::timestamptz is not null and n.created_at < $1)             as prev_imported
           from node n join peak p on p.src = n.src`,
        [since, IMPORT_NODES_PER_HOUR]),
      db.query<{ slug: string; team: string; flow: string;
                 docs: { path: string; status: string | null; outcome: string | null }[] }>(
        `select i.slug, t.slug as team, coalesce(i.flow,'') as flow,
                coalesce((select json_agg(json_build_object('path', d.path, 'status', d.status, 'outcome', d.outcome))
                            from zz.doc d
                           where d.initiative = i.slug and d.team_slug = t.slug), '[]'::json) as docs
           from zz.initiative i join zz.team t on t.id = i.team_id
          where ($1::timestamptz is null
                 or i.created_at >= $1
                 or exists (select 1 from zz.event e
                             where e.kind = 'tool_call'
                               and e.initiative = i.slug and e.team_id = i.team_id and e.ts >= $1))`,
        [since]),
      // A SECOND STATEMENT, not another `filter` on the one above: that query returns a
      // single row of counts and cannot also group.
      db.query<{ door: string; n: string }>(
        `select coalesce(nullif(split_part(subject,':',1),''),'(unnamed)') as door, count(*) as n
           from zz.event
          where kind='tool_call' and ok = false
            and ($1::timestamptz is null or ts >= $1)
          group by 1 order by count(*) desc`,
        [since]),
    ])
    : await Promise.all([
      db.query<{ calls: string; refused: string; prev_calls: string; prev_refused: string; searches: string }>(
        `select count(*) filter (where e.kind='tool_call'
                  and ($1::timestamptz is null or e.ts >= $1))                       as calls,
                count(*) filter (where e.kind='tool_call' and e.ok = false
                  and ($1::timestamptz is null or e.ts >= $1))                       as refused,
                count(*) filter (where e.kind='tool_call'
                  and $2::timestamptz is not null and e.ts >= $2 and e.ts < $1)      as prev_calls,
                count(*) filter (where e.kind='tool_call' and e.ok = false
                  and $2::timestamptz is not null and e.ts >= $2 and e.ts < $1)      as prev_refused,
                count(*) filter (where e.subject in ('core:knowledge_search','core:search_knowledge') and e.ok
                  and ($1::timestamptz is null or e.ts >= $1))                       as searches
           from zz.event e join zz.team t on t.id = e.team_id
          where t.slug = $3
            and ($1::timestamptz is null or e.ts >= coalesce($2::timestamptz, $1))`,
        [since, prevSince, scope.slug]),
      db.query<{ bytes: string | null; skill: string; is_prev: boolean }>(
        `select r.bytes_total as bytes, s.name as skill,
                ($2::timestamptz is not null and r.started_at >= $2 and r.started_at < $1) as is_prev
           from zz.run r
           join zz.skill_version sv on sv.id = r.skill_version_id
           join zz.skill s on s.id = sv.skill_id
           join zz.initiative i on i.id = r.initiative_id
           join zz.team t on t.id = i.team_id
          where t.slug = $3
            and ($1::timestamptz is null or r.started_at >= coalesce($2::timestamptz, $1))
          order by r.started_at desc limit 400`,
        [since, prevSince, scope.slug]),
      db.query<{ from_work: string; imported: string; prev_from_work: string; prev_imported: string }>(
        `with node as (
           select coalesce(evidence[1],'') as src, created_at
             from zz.doc where initiative = '_knowledge' and team_slug = $3),
         peak as (
           select src, max(c) as ph from (
             select src, date_trunc('hour', created_at) as h, count(*) as c
               from node group by 1,2) q
            group by 1)
         select count(*) filter (where p.ph <= $2)                                   as from_work,
                count(*) filter (where p.ph >  $2)                                   as imported,
                count(*) filter (where p.ph <= $2
                  and $1::timestamptz is not null and n.created_at < $1)             as prev_from_work,
                count(*) filter (where p.ph >  $2
                  and $1::timestamptz is not null and n.created_at < $1)             as prev_imported
           from node n join peak p on p.src = n.src`,
        [since, IMPORT_NODES_PER_HOUR, scope.slug]),
      db.query<{ slug: string; team: string; flow: string;
                 docs: { path: string; status: string | null; outcome: string | null }[] }>(
        `select i.slug, t.slug as team, coalesce(i.flow,'') as flow,
                coalesce((select json_agg(json_build_object('path', d.path, 'status', d.status, 'outcome', d.outcome))
                            from zz.doc d
                           where d.initiative = i.slug and d.team_slug = t.slug), '[]'::json) as docs
           from zz.initiative i join zz.team t on t.id = i.team_id
          where t.slug = $2
            and ($1::timestamptz is null
                 or i.created_at >= $1
                 or exists (select 1 from zz.event e
                             where e.kind = 'tool_call'
                               and e.initiative = i.slug and e.team_id = i.team_id and e.ts >= $1))`,
        [since, scope.slug]),
      db.query<{ door: string; n: string }>(
        `select coalesce(nullif(split_part(e.subject,':',1),''),'(unnamed)') as door, count(*) as n
           from zz.event e join zz.team t on t.id = e.team_id
          where t.slug = $2 and e.kind='tool_call' and e.ok = false
            and ($1::timestamptz is null or e.ts >= $1)
          group by 1 order by count(*) desc`,
        [since, scope.slug]),
    ]);

  const c = calls.rows[0], k = shelf.rows[0];

  const stages: Record<Stage, number> = {
    noflow: 0, notstarted: 0, drafting: 0, agreed: 0, gated: 0, closed: 0,
  };
  const scores: number[] = [];
  for (const row of inits.rows) {
    const { completeness, stage } = progressOf(row.flow, row.docs ?? []);
    stages[stage]++;
    if (completeness !== null) scores.push(completeness);
  }

  /* A RUN NOBODY MEASURED IS NOT A RUN THAT MOVED NOTHING, and `Number(null ?? 0)` is 0 —
   * which would draw an unmeasured run as a dot on the floor and pull the median down with
   * it. Migration 051 made `bytes_total` nullable for exactly this reason, so that a gap
   * stays a gap; folding it back to zero here would reintroduce that conflation one layer
   * up. Unmeasured runs are counted and reported instead, and the tile says how many. */
  const measured = runs.rows.filter((r) => r.bytes !== null);
  const kb = measured.map((r) => ({ kb: Number(r.bytes) / 1024, skill: r.skill, prev: r.is_prev }));
  const nowKb = kb.filter((r) => !r.prev).map((r) => r.kb);
  const prevKb = kb.filter((r) => r.prev).map((r) => r.kb);
  const unmeasured = runs.rows.length - measured.length;

  const fromWork = count(k?.from_work), imported = count(k?.imported);
  const prevFromWork = count(k?.prev_from_work), prevImported = count(k?.prev_imported);

  return {
    progressing: {
      value: median(scores),
      active: inits.rows.length,
      scoreable: scores.length,
      stages,
      // Reconstructing how complete an initiative was one window ago needs per-document
      // history this platform does not reliably record: `doc.approved_at` is truncated to
      // midnight and `doc.created_at` is rewritten when a document is revised. Comparing
      // today's document state against an earlier window's ACTIVE SET would answer a
      // question nobody asked, so this tile draws no delta and says why.
      noDeltaBecause:
        "approved_at is stored as a date and created_at is rewritten on revision, "
        + "so how complete an initiative was earlier cannot be reconstructed",
    },
    knowledge: {
      value: pct(fromWork, fromWork + imported),
      prev: prevSince ? pct(prevFromWork, prevFromWork + prevImported) : null,
      fromWork, imported,
      searches: count(c?.searches),
      importThresholdPerHour: IMPORT_NODES_PER_HOUR,
    },
    refusals: {
      value: pct(count(c?.refused), count(c?.calls)),
      prev: prevSince ? pct(count(c?.prev_refused), count(c?.prev_calls)) : null,
      refused: count(c?.refused), calls: count(c?.calls),
      byDoor: doors.rows.map((r) => ({ door: r.door, n: +r.n })),
    },
    context: {
      value: median(nowKb),
      prev: prevSince ? median(prevKb) : null,
      p90: quantile(nowKb, 0.9),
      runs: kb.filter((r) => !r.prev).map((r) => ({ kb: r.kb, skill: r.skill })),
      unmeasured,
      contextWindowKb: CONTEXT_WINDOW_KB,
    },
  };
}
