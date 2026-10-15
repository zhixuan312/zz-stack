/**
 * /api/console/platform/evaluation — each plugin's evaluation as the platform recorded it: the latest
 * score and its standing, every score grouped into the series it is comparable within, and the
 * findings by decision, by owner and those still waiting.
 *
 * A score is an `eval_run` with `scored_at` set. Two scores are comparable when they share the
 * protocol version and the population's kind, the form of the snapshot's `surface_source` with the
 * plugin version taken out; `scorer_version` is the platform's build at scoring and is never compared.
 * So successive plugin versions under one protocol read as one series, and a plugin scored under two
 * protocol versions or two populations says `Not comparable` and why.
 *
 * Public by route, through `platformPublic`. A member reads the protocol's version number and not its
 * key, a waiting finding's owner category and fixed summary and not its measure's key or its pattern:
 * a key and a pattern are the owning team's words. Nobody reads a finding's `decision_note`,
 * `owner_ref` or `evidence_refs`, or a run's team or initiative; none of them is selected.
 *
 * Each part is its own statement and fails alone, as `unavailable`, the others standing. The tiles
 * have no unavailable form, so a failed tile statement fails the read.
 *
 * COUPLED: the console's `Evaluation` in src/lib/platform-shapes.ts, and its fake answer in
 * scripts/fake-gateway/platform-evaluation.ts, which `checks/console-platform-evaluation.ts` compares
 * this route's answer with, key set by key set. `/api/console/plugins` (catalog.ts) reads each plugin's
 * public score and comparability from `scoreHistory` and `publicScore` here, so the two reads choose alike.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import type { Figure, Part, ReadMeta } from "./figures.js";
import { platformPublic, ZZ_TZ } from "./shared.js";

/** What the read counts, as `meta.population` says it. */
const POPULATION = "scored evaluation runs";

type Standing = "established" | "provisional" | "not_established";
type Protocol = { key: string | null; version: number };
type Series = {
  protocol: Protocol; population: string | null;
  runs: { scoredAt: string; score: number | null; lower: number | null; upper: number | null; standing: Standing }[];
};
/** One plugin's scores in the series they are comparable within, and what that makes of comparing them. */
type ScoreHistory = { plugin: string; series: Series[]; statement: string };
/** A plugin's latest score that has a value, with its range, standing, protocol and date. */
type PluginScore = {
  value: number; lower: number | null; upper: number | null; standing: Standing; protocol: Protocol; scoredAt: string;
};
type SafeFinding = {
  id: string; plugin: string; kind: "defect" | "unknown"; owner: string; measure: string | null;
  waitingSince: string; summary: string;
};
type Evaluation = {
  meta: ReadMeta;
  tiles: { waiting: number; established: number; lastScored: string | null; daysScored: number };
  plugins: Part<{
    plugin: string; score: Figure; lower: number | null; upper: number | null; standing: Standing;
    guardrails: "pass" | "fail" | "not_established"; protocol: Protocol; scoredAt: string;
  }[]>;
  history: Part<ScoreHistory[]>;
  byDecision: Part<Record<"applied" | "rejected" | "deferred", number>>;
  byOwner: Part<Record<string, number>>;
  waiting: Part<{ rows: (SafeFinding & { pattern?: string })[]; total: number }>;
};

/** A scored run as the plugins and history statements select it. */
type ScoredRow = {
  plugin: string; protocol_id: string; protocol_key: string; protocol_version: number; scored_ms: number;
  standing: Standing; score: number | null; lower: number | null; upper: number | null;
};

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The population kind each form `doorSurface` writes is read as; the first two name a plugin version,
 *  and the second a version other than the snapshot's own. COUPLED: the sentences `doorSurface` writes
 *  in services/zz-core/src/eval/observe.ts. */
const KINDS: [RegExp, string][] = [
  [/^zz\.plugin_tool at \S+, the nearest version that recorded one$/, "the nearest recorded version's surface"],
  [/^zz\.plugin_tool at \S+$/, "the surface recorded at that version"],
  [/^this service's registered door\b/, "this service's registered door"],
  [/^no door of its own\b/, "no door of its own"],
  [/^no surface recorded for this door\b/, "no surface recorded"],
];

/** A snapshot's population kind. A form not listed keeps its own words with any version taken out,
 *  so it is a kind of its own rather than a match for one above; none recorded is null, one kind. */
function populationOf(source: string | null): string | null {
  if (source === null) return null;
  const known = KINDS.find(([form]) => form.test(source));
  return known ? known[1] : source.replace(/\bv?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/g, "<version>");
}

/** Every plugin's scored runs up to `asOf`, each plugin's grouped into series: one protocol version and one
 *  population kind, in the order its first score came. The protocol's key is the superadmin's alone. */
export async function scoreHistory(asOf: string, superadmin: boolean): Promise<ScoreHistory[]> {
  const rows = (await platformDb().query<ScoredRow & { surface_source: string | null }>(
    `select p.name as plugin, pv.id::text as protocol_id, pv.protocol_key, pv.version as protocol_version,
            (extract(epoch from r.scored_at) * 1000)::float8 as scored_ms, r.score_status as standing,
            r.overall_score::float8 as score, r.score_lower::float8 as lower, r.score_upper::float8 as upper,
            os.surface_source
       from zz.eval_run r
       join zz.eval_protocol_version pv on pv.id = r.protocol_version_id
       join zz.plugin p on p.id = pv.plugin_id
       join zz.eval_observation_snapshot os on os.id = r.observation_snapshot_id
      where r.scored_at is not null and r.scored_at <= $1::timestamptz
      order by p.name, r.scored_at, r.id`, [asOf])).rows;
  const plugins = [...new Set(rows.map((r) => r.plugin))];
  return plugins.map((plugin) => {
    const series = new Map<string, Series>();
    const versions = new Set<string>();
    for (const r of rows.filter((x) => x.plugin === plugin)) {
      const population = populationOf(r.surface_source);
      const at = JSON.stringify([r.protocol_id, population]);
      if (!series.has(at)) {
        series.set(at, { protocol: { key: superadmin ? r.protocol_key : null, version: r.protocol_version }, population, runs: [] });
      }
      series.get(at)!.runs.push({ scoredAt: iso(r.scored_ms), score: r.score, lower: r.lower, upper: r.upper, standing: r.standing });
      versions.add(r.protocol_id);
    }
    const statement = series.size === 1 ? "Comparable: one protocol version and population"
      : versions.size > 1 ? "Not comparable: a different protocol version" : "Not comparable: a different population";
    return { plugin, series: [...series.values()], statement };
  });
}

/** What a plugin's catalog row says of its scores: the newest run of its history that has a score, and its
 *  history's statement; a plugin with none answers null and that there is nothing to compare. A newer run with
 *  no score leaves the last score standing rather than blanking it. */
export function publicScore(history: ScoreHistory | undefined): { score: PluginScore | null; comparability: string } {
  let latest: PluginScore | null = null;
  for (const s of history?.series ?? []) {
    for (const r of s.runs) {
      if (r.score === null || (latest && latest.scoredAt > r.scoredAt)) continue;
      latest = { value: r.score, lower: r.lower, upper: r.upper, standing: r.standing, protocol: s.protocol, scoredAt: r.scoredAt };
    }
  }
  return latest ? { score: latest, comparability: history!.statement } : { score: null, comparability: "No score to compare" };
}

/** The fixed sentence a waiting finding is read by: its plugin and owner category, or neither when the
 *  category is `unknown`. */
const summaryOf = (plugin: string, owner: string): string =>
  owner === "unknown" ? "Evaluation finding awaiting a decision" : `A finding on ${plugin}, owned by ${owner}, awaiting a decision`;

/** One part's statement, or `unavailable` when it fails: the other parts stand. */
async function part<T>(name: string, read: () => Promise<T>): Promise<Part<T>> {
  try {
    return { state: "ok", data: await read() };
  } catch (err) {
    console.error(`console evaluation ${name} failed:`, err);
    return { state: "unavailable", reason: "failed" };
  }
}

export function mountPlatformEvaluation(app: Express): void {
  app.get("/api/console/platform/evaluation", platformPublic("the platform's evaluation", async (_req, res, { superadmin }) => {
    const db = platformDb();
    // One instant for every statement, in whole seconds so the cutoff is the `asOf` the answer states.
    const asOfMs = Math.floor(Date.now() / 1000) * 1000;
    const asOf = iso(asOfMs);
    const protocol = (r: ScoredRow): Protocol => ({ key: superadmin ? r.protocol_key : null, version: r.protocol_version });

    // The tiles. A plugin's latest score is its most recent scoring; a day is a local date in ZZ_TZ.
    const tiles = (await db.query<{ established: number; first_ms: number | null; last_ms: number | null; days: number; waiting: number }>(
      `with scored as (
         select pv.plugin_id, r.id, r.scored_at, r.score_status
           from zz.eval_run r
           join zz.eval_protocol_version pv on pv.id = r.protocol_version_id
          where r.scored_at is not null and r.scored_at <= $1::timestamptz
       ), latest as (
         select distinct on (plugin_id) plugin_id, score_status from scored order by plugin_id, scored_at desc, id desc
       )
       select (select count(*)::int from latest where score_status = 'established') as established,
              (select (extract(epoch from min(scored_at)) * 1000)::float8 from scored) as first_ms,
              (select (extract(epoch from max(scored_at)) * 1000)::float8 from scored) as last_ms,
              (select count(distinct (scored_at at time zone $2::text)::date)::int from scored) as days,
              (select count(*)::int from zz.eval_finding f
                where f.decision = 'deferred' and f.kind in ('defect', 'unknown') and f.superseded_by is null
                  and f.created_at <= $1::timestamptz) as waiting`, [asOf, ZZ_TZ])).rows[0];

    const [plugins, history, byDecision, byOwner, waiting] = await Promise.all([
      part("plugins", async () => (await db.query<ScoredRow & { guardrails: "pass" | "fail" | "not_established" }>(
        `select distinct on (p.name) p.name as plugin, pv.id::text as protocol_id, pv.protocol_key,
                pv.version as protocol_version, (extract(epoch from r.scored_at) * 1000)::float8 as scored_ms,
                r.score_status as standing, r.overall_score::float8 as score, r.score_lower::float8 as lower,
                r.score_upper::float8 as upper, coalesce(r.guardrail_status, 'not_established') as guardrails
           from zz.eval_run r
           join zz.eval_protocol_version pv on pv.id = r.protocol_version_id
           join zz.plugin p on p.id = pv.plugin_id
          where r.scored_at is not null and r.scored_at <= $1::timestamptz
          order by p.name, r.scored_at desc, r.id desc`, [asOf])).rows.map((r) => ({
        plugin: r.plugin,
        score: r.score === null ? { value: null, why: "no_data" as const } : { value: r.score, why: null },
        lower: r.lower, upper: r.upper, standing: r.standing, guardrails: r.guardrails,
        protocol: protocol(r), scoredAt: iso(r.scored_ms),
      }))),

      part("history", () => scoreHistory(asOf, superadmin)),

      // Findings are counted once each: a superseded finding is counted as the one that replaced it,
      // and a strength has no decision to count.
      part("byDecision", async () => {
        const counts = { applied: 0, rejected: 0, deferred: 0 };
        for (const r of (await db.query<{ decision: keyof typeof counts; n: number }>(
          `select f.decision, count(*)::int as n
             from zz.eval_finding f
            where f.kind in ('defect', 'unknown') and f.superseded_by is null and f.created_at <= $1::timestamptz
            group by f.decision`, [asOf])).rows) counts[r.decision] = r.n;
        return counts;
      }),

      part("byOwner", async () => Object.fromEntries((await db.query<{ owner_kind: string; n: number }>(
        `select f.owner_kind, count(*)::int as n
           from zz.eval_finding f
          where f.kind in ('defect', 'unknown') and f.superseded_by is null and f.created_at <= $1::timestamptz
          group by f.owner_kind
          order by n desc, f.owner_kind`, [asOf])).rows.map((r) => [r.owner_kind, r.n]))),

      // Oldest first. The pattern and the measure's key leave the database only for the superadmin.
      part("waiting", async () => {
        const rows = (await db.query<{
          id: string; plugin: string; kind: "defect" | "unknown"; owner_kind: string; measure: string | null;
          since_ms: number; pattern: string | null;
        }>(
          `select f.id::text as id, p.name as plugin, f.kind, f.owner_kind,
                  case when $2::boolean then m.key end as measure,
                  (extract(epoch from f.created_at) * 1000)::float8 as since_ms,
                  case when $2::boolean then f.pattern end as pattern
             from zz.eval_finding f
             join zz.eval_run r on r.id = f.eval_run_id
             join zz.eval_protocol_version pv on pv.id = r.protocol_version_id
             join zz.plugin p on p.id = pv.plugin_id
             left join zz.eval_measure m on m.id = f.measure_id
            where f.decision = 'deferred' and f.kind in ('defect', 'unknown') and f.superseded_by is null
              and f.created_at <= $1::timestamptz
            order by f.created_at, f.id`, [asOf, superadmin])).rows;
        return {
          rows: rows.map((r) => ({
            id: r.id, plugin: r.plugin, kind: r.kind, owner: r.owner_kind, measure: r.measure,
            waitingSince: iso(r.since_ms), summary: summaryOf(r.plugin, r.owner_kind),
            ...(superadmin ? { pattern: r.pattern ?? "" } : {}),
          })),
          total: rows.length,
        };
      }),
    ]);

    const answer: Evaluation = {
      meta: {
        asOf, timezone: ZZ_TZ,
        period: { from: tiles.first_ms === null ? asOf : iso(tiles.first_ms), to: asOf },
        scope: superadmin ? "platform-admin" : "platform-public", population: POPULATION,
        coverageFrom: tiles.first_ms === null ? null : iso(tiles.first_ms),
      },
      tiles: {
        waiting: tiles.waiting, established: tiles.established,
        lastScored: tiles.last_ms === null ? null : iso(tiles.last_ms), daysScored: tiles.days,
      },
      plugins, history, byDecision, byOwner, waiting,
    };
    res.json(answer);
  }));
}
