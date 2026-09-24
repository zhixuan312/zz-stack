/**
 * The four numbers the overview leads with, and the marks drawn under them.
 *
 * One question each, and they do not overlap: is work progressing (initiative), is what we write
 * down worth reading (knowledge), is the tool surface breaking (tools), is the system straining
 * (system).
 *
 * No prose is composed here or in the browser. Every string on a tile is a fixed label that ships
 * with the component, or a template with these numbers substituted into it — the console must
 * render without a model in the path.
 */
import type { Pool } from "pg";

import { flowShape } from "./shared.js";
import type { ResolvedScope } from "./shared.js";

/** More than this many nodes minted by one source in a single hour is an archive import.
 *
 * A behaviour, not a list of names: matching slugs containing "archive" holds only until somebody
 * names an initiative differently. The threshold is stated on the tile that uses it. */
const IMPORT_NODES_PER_HOUR = 50;

/** How complete one initiative is against its own flow's declared documents.
 *
 * Never against a document called `spec.md`. A flow declares `documents[]` and marks which of them
 * are gates; scoring against one flow's filenames renders every other flow permanently stuck.
 *
 * Absent counts 0, written counts a half, approved counts 1. */
type Stage = "noflow" | "notstarted" | "drafting" | "agreed" | "gated" | "closed";

interface OverviewMetrics {
  /** 1 · initiative. Median completeness across the open initiatives active in the window —
   *  closed ones are 100% by definition and are excluded, or they pin the tile at 100. */
  progressing: {
    /** Null when no open scoreable initiative was active. Percent, 0–100. */
    value: number | null;
    active: number;
    /** Open initiatives with a declared flow — the ones the median is taken over. */
    scoreable: number;
    /** Every active initiative in exactly one stage — the mark under the tile. */
    stages: Record<Stage, number>;
    /** Gate documents that are written and unapproved across the open initiatives — the
     *  work that is finished and sitting on a human. See `progressOf`. */
    waiting: number;
    /** How long the oldest of those has waited, in days. Null when nothing is waiting. */
    waitingOldestDays: number | null;
    /** Why this tile carries no delta. Stated by the API so the browser invents nothing. */
    noDeltaBecause: string;
  };
  /** 2 · knowledge. Share of the shelf minted by work rather than dumped by an import.
   *
   * COUPLED: both spellings of the search tool are counted. `tool-telemetry.ts` resolves a subject
   * through `resolveToolKey` as it writes, so rows from this release on say `core:knowledge_search`
   * and older rows say `core:search_knowledge` — matching one spelling counts half the history. */
  knowledge: {
    value: number | null;
    prev: number | null;
    fromWork: number; imported: number;
    /** Knowledge searches in the window.
     *
     * Counts searches, not the node ids the `knowledge.search` event carries: those events cover
     * only part of the history, and a tile built on them would read as a platform nobody had
     * searched before they began. */
    searches: number;
    importThresholdPerHour: number;
  };
  /** 3 · tools. Refusal rate in points. */
  refusals: {
    value: number | null; prev: number | null;
    refused: number; calls: number;
    /**
     * Which door is refusing — the mark under the tile, and the one thing the rate itself cannot
     * say. Largest first, and it sums exactly to `refused`: the same predicate
     * (`kind='tool_call' and ok = false`), grouped rather than counted.
     *
     * The door comes from `subject`, which is `<door>:<tool>` and always present.
     *
     * Not the `refusals[]` list on the overview payload, which is a top-12 of every failed event
     * of any kind — a different population with a different total.
     */
    byOwner: { guardrail: number; ours: number; theirs: number };
    byDoor: { door: string; n: number }[];
  };
  /** 4 · system. Bytes a run hands back to the agent, which is context it must then carry. */
  context: {
    /** KB. Median of the runs started in the window. */
    value: number | null; prev: number | null;
    p90: number | null;
    /** One entry per measured run, for the distribution mark. The median alone hides a
     *  tail that runs two orders of magnitude past it. */
    runs: { kb: number; skill: string }[];
    /** Runs whose bytes were never measured. Counted and excluded, never folded in as
     *  zero — see the note where the rows are read. */
    unmeasured: number;
    /** True when the run query hit its 400-row cap, so `prev` is a median over a truncated
     *  tail rather than over the whole previous window. */
    capped: boolean;
    /** Rule of thumb at ~4 bytes per token. Not a measurement: nothing on this platform
     *  counts tokens, and the tile says so. */
    contextWindowKb: number;
  };
}

const CONTEXT_WINDOW_KB = 800;

/** A `count(*)`, which is never SQL-null — the `?? 0` guards an absent row, not a null aggregate,
 *  and this helper must never be pointed at one. An aggregate that can come back null (`sum`,
 *  `avg`, a nullable column) is tested for null at its own call site and reported as unmeasured.
 *  COUPLED: `checks/console-nulls.ts` pins both halves. */
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
  flow: string,
  docs: { path: string; status: string | null; outcome: string | null; updatedAt?: string | null }[],
): { completeness: number | null; stage: Stage; waiting: string[] } {
  const declared = flowShape(flow || null);
  if (declared.size === 0) return { completeness: null, stage: "noflow", waiting: [] };

  const byPath = new Map(docs.map((d) => [d.path, d.status]));
  let score = 0, present = 0, approved = 0, gates = 0, gatesCleared = 0;
  const waiting: string[] = [];
  for (const [name, shape] of declared) {
    // Not the handover: it is written after the close, so counting it makes every open initiative
    // one document short of a flow it has not finished. It is in `declared` because the platform
    // gates it.
    if (shape.role === "handover") continue;
    const status = byPath.get(name);
    if (shape.gate) gates++;
    if (status === undefined) continue;
    present++;
    if (status === "approved") {
      approved++; score += 1;
      if (shape.gate) gatesCleared++;
    } else {
      score += 0.5;
      /* Waiting on a person: a gate that has been written and not approved, and both halves are
       * load-bearing. A gate nobody has drafted is waiting on the agent, not a human, and a
       * document that declares no gate has no approver and never will — counting "documents with
       * no approver" reports work as blocked that is not. Which documents gate is the flow's
       * answer, read from its manifest, never a list of filenames kept here. */
      if (shape.gate) waiting.push(name);
    }
  }
  const completeness = (score / declared.size) * 100;
  /* Clearing every gate is not being done. An initiative can have every gate approved and still be
   * open. Closure is recorded as an `outcome` on the flow's closing document and nowhere else —
   * `initiative.closed_at` is written by nothing and the schema does not carry it — so `gated` is its
   * own rung on the ladder. */
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
  return { completeness, stage, waiting };
}

/**
 * Read all four, for a platform scope or one team.
 *
 * Two complete statements per query, never one assembled from `scope`: `check:sql` can only
 * prepare a literal it can read whole. The team branch reaches events through `team_id` and runs
 * through `run.initiative_id → initiative.team_id`, because `zz.run` carries no team column of its
 * own and the denormalised `event.team_slug` is written only by acts that belong to a team.
 *
 * `prevSince` is null for an all-time window, and a tile with nothing to compare against draws no
 * delta rather than an arrow meaning nothing.
 *
 * Active means a tool call, not any event: most events on this platform carry no run and are bulk
 * import or admin rather than somebody working.
 *
 * Initiatives are not deleted here; they are closed with an outcome recorded on the flow's closing
 * document.
 */
export async function readMetrics(
  db: Pool, scope: ResolvedScope, since: Date | null, prevSince: Date | null,
): Promise<OverviewMetrics> {
  const [calls, runs, shelf, inits, doors] = scope.kind === "platform"
    ? await Promise.all([
      db.query<{ calls: string; refused: string; refused_guardrail: string; refused_ours: string;
                 refused_theirs: string; prev_calls: string; prev_refused: string; searches: string }>(
        `select count(*) filter (where kind='tool_call'
                  and ($1::timestamptz is null or ts >= $1))                        as calls,
                count(*) filter (where kind='tool_call' and ok = false
                  and ($1::timestamptz is null or ts >= $1))                        as refused,
                -- Split by who it belongs to: "not ok" is four different facts — see @zz/contracts'
                -- refusalOwner.
                count(*) filter (where kind='tool_call' and refusal_owner = 'guardrail'
                  and ($1::timestamptz is null or ts >= $1))                        as refused_guardrail,
                count(*) filter (where kind='tool_call' and refusal_owner = 'ours'
                  and ($1::timestamptz is null or ts >= $1))                        as refused_ours,
                count(*) filter (where kind='tool_call' and refusal_owner = 'theirs'
                  and ($1::timestamptz is null or ts >= $1))                        as refused_theirs,
                count(*) filter (where kind='tool_call'
                  and $2::timestamptz is not null and ts >= $2 and ts < $1)         as prev_calls,
                count(*) filter (where kind='tool_call' and ok = false
                  and $2::timestamptz is not null and ts >= $2 and ts < $1)         as prev_refused,
                count(*) filter (where coalesce(tool_key, subject) = 'core:knowledge_search' and ok
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
          -- Capped, and the cap is reported. This spans the current window and the previous one,
          -- newest first, so past 400 runs the previous window is truncated first and its median is
          -- taken over an arbitrary tail; the capped flag below makes that a fact the tile can print.
          order by r.started_at desc limit 400`,
        [since, prevSince]),
      db.query<{ from_work: string; imported: string; prev_from_work: string; prev_imported: string }>(
        // The shelf is a stock, so it is counted as it stands, and the comparison is the
        // same stock as it stood one window ago — not what was minted inside the window.
        `with node as (
           select coalesce(evidence[1],'') as src, created_at
             from zz.knowledge_node),
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
                 docs: { path: string; status: string | null; outcome: string | null;
                         updatedAt: string | null }[] }>(
        `select i.slug, t.slug as team, coalesce(i.flow,'') as flow,
                coalesce((select json_agg(json_build_object('path', d.path, 'status', d.status,
                                                           'outcome', d.outcome, 'updatedAt', d.updated_at))
                            from zz.doc d
                           where d.initiative = i.slug and d.team_slug = t.slug), '[]'::json) as docs
           from zz.initiative i join zz.team t on t.id = i.team_id
          where ($1::timestamptz is null
                 or i.created_at >= $1
                 or exists (select 1 from zz.event e
                             where e.kind = 'tool_call'
                               and e.initiative = i.slug and e.team_id = i.team_id and e.ts >= $1))`,
        [since]),
      // A second statement, not another `filter` on the one above: that query returns a
      // single row of counts and cannot also group.
      db.query<{ door: string; n: string }>(
        `select coalesce(nullif(split_part(coalesce(tool_key, subject),':',1),''),'(unnamed)') as door, count(*) as n
           from zz.event
          where kind='tool_call' and ok = false
            and ($1::timestamptz is null or ts >= $1)
          group by 1 order by count(*) desc`,
        [since]),
    ])
    : await Promise.all([
      db.query<{ calls: string; refused: string; refused_guardrail: string; refused_ours: string;
                 refused_theirs: string; prev_calls: string; prev_refused: string; searches: string }>(
        `select count(*) filter (where e.kind='tool_call'
                  and ($1::timestamptz is null or e.ts >= $1))                       as calls,
                count(*) filter (where e.kind='tool_call' and e.refusal_owner = 'guardrail'
                  and ($1::timestamptz is null or e.ts >= $1))                       as refused_guardrail,
                count(*) filter (where e.kind='tool_call' and e.refusal_owner = 'ours'
                  and ($1::timestamptz is null or e.ts >= $1))                       as refused_ours,
                count(*) filter (where e.kind='tool_call' and e.refusal_owner = 'theirs'
                  and ($1::timestamptz is null or e.ts >= $1))                       as refused_theirs,
                count(*) filter (where e.kind='tool_call' and e.ok = false
                  and ($1::timestamptz is null or e.ts >= $1))                       as refused,
                count(*) filter (where e.kind='tool_call'
                  and $2::timestamptz is not null and e.ts >= $2 and e.ts < $1)      as prev_calls,
                count(*) filter (where e.kind='tool_call' and e.ok = false
                  and $2::timestamptz is not null and e.ts >= $2 and e.ts < $1)      as prev_refused,
                count(*) filter (where coalesce(e.tool_key, e.subject) = 'core:knowledge_search' and e.ok
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
           -- DELIBERATE: an inner join. A teamless run belongs to no team, so this scope cannot see it,
           -- while the platform branch above counts it: "the median context of my team's work" and
           -- "the median context of all work" are different questions.
           join zz.initiative i on i.id = r.initiative_id
           join zz.team t on t.id = i.team_id
          where t.slug = $3
            and ($1::timestamptz is null or r.started_at >= coalesce($2::timestamptz, $1))
          order by r.started_at desc limit 400`,
        [since, prevSince, scope.slug]),
      db.query<{ from_work: string; imported: string; prev_from_work: string; prev_imported: string }>(
        `with node as (
           select coalesce(evidence[1],'') as src, created_at
             from zz.knowledge_node where team_slug = $3),
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
                 docs: { path: string; status: string | null; outcome: string | null;
                         updatedAt: string | null }[] }>(
        `select i.slug, t.slug as team, coalesce(i.flow,'') as flow,
                coalesce((select json_agg(json_build_object('path', d.path, 'status', d.status,
                                                           'outcome', d.outcome, 'updatedAt', d.updated_at))
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
        `select coalesce(nullif(split_part(coalesce(e.tool_key, e.subject),':',1),''),'(unnamed)') as door, count(*) as n
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
  /* Closed work is not scored. A closed initiative is 100% complete by definition and stays there,
   * so each one is a permanent vote for the maximum and enough of them pin the median at 100. This
   * tile asks whether work is advancing, which is a question about work that is still going.
   *
   * `stages` still counts all six — where the active set is, closed rows included, is a different
   * question from how far the unfinished work has got. */
  /* Open initiatives only, for the same reason the median is. An unapproved gate on a closed
     initiative is waiting on nobody, and counting it would make this number climb forever. */
  const scores: number[] = [];
  let waiting = 0;
  let oldest: number | null = null;
  for (const row of inits.rows) {
    const { completeness, stage, waiting: openGates } = progressOf(row.flow, row.docs ?? []);
    stages[stage]++;
    if (completeness !== null && stage !== "closed") scores.push(completeness);
    if (stage === "closed") continue;
    waiting += openGates.length;
    for (const path of openGates) {
      const at = (row.docs ?? []).find((d) => d.path === path)?.updatedAt;
      if (!at) continue;
      const days = (Date.now() - new Date(at).getTime()) / 86_400_000;
      if (Number.isFinite(days) && (oldest === null || days > oldest)) oldest = days;
    }
  }

  /* A run nobody measured is not a run that moved nothing, and `Number(null ?? 0)` is 0 — which
   * would draw an unmeasured run as a dot on the floor and pull the median down with it.
   * `bytes_total` is nullable so that a gap stays a gap; unmeasured runs are counted and reported
   * instead, and the tile says how many. */
  const measured = runs.rows.filter((r) => r.bytes !== null);
  const kb = measured.map((r) => ({ kb: Number(r.bytes) / 1024, skill: r.skill, prev: r.is_prev }));
  const nowKb = kb.filter((r) => !r.prev).map((r) => r.kb);
  const prevKb = kb.filter((r) => r.prev).map((r) => r.kb);
  /* Over the current window only, like the median it is printed beside. The query's bound is
   * `coalesce(prevSince, since)`, so `runs.rows` spans both windows, and a caveat has to be about
   * the number it sits under. */
  const unmeasured = runs.rows.filter((r) => !r.is_prev && r.bytes === null).length;
  /* The cap, reached or not. The run query takes the 400 most recent across both windows, so at the
   * cap the previous window is the half that gets cut and `prev` becomes a median over an arbitrary
   * tail. */
  const capped = runs.rows.length >= 400;

  const fromWork = count(k?.from_work), imported = count(k?.imported);
  const prevFromWork = count(k?.prev_from_work), prevImported = count(k?.prev_imported);

  return {
    progressing: {
      value: median(scores),
      active: inits.rows.length,
      scoreable: scores.length,
      stages,
      waiting,
      waitingOldestDays: oldest === null ? null : Math.round(oldest * 10) / 10,
      // Reconstructing how complete an initiative was one window ago needs per-document history
      // this platform does not reliably record: `doc.approved_at` is truncated to midnight and
      // `doc.created_at` is rewritten when a document is revised. So this tile draws no delta and
      // says why.
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
      // Who each one belongs to, so the console can say which part of the number is the platform
      // enforcing a rule and which is a client that needs fixing. `other` is the remainder rather
      // than a fourth column: its whole definition is "the text did not say".
      byOwner: {
        guardrail: count(c?.refused_guardrail),
        ours: count(c?.refused_ours),
        theirs: count(c?.refused_theirs),
      },
      byDoor: doors.rows.map((r) => ({ door: r.door, n: +r.n })),
    },
    context: {
      value: median(nowKb),
      prev: prevSince ? median(prevKb) : null,
      p90: quantile(nowKb, 0.9),
      runs: kb.filter((r) => !r.prev).map((r) => ({ kb: r.kb, skill: r.skill })),
      unmeasured,
      capped,
      contextWindowKb: CONTEXT_WINDOW_KB,
    },
  };
}
