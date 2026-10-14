/**
 * The evaluation the platform's Evaluation read is drawn from, seeded into a throwaway database, and
 * the values a reader must find beside it: `checks/console-platform-evaluation.ts` drives the
 * gateway's own route over them.
 *
 * Times are fixed instants, chosen for the reporting timezone Pacific/Auckland (UTC+12 until 27
 * September 2026, UTC+13 after): six scorings fall on six local dates and on four UTC dates, so days
 * counted on UTC's calendar come out 4 where the local count is 6.
 *
 * What it writes, one team and one initiative owning every run:
 *
 *   - `alpha`, protocol `alpha-protokey` version 1: an established score on 20 Sep observed at
 *     plugin version 1.0.0 by scorer 0.90.0, an established score on 27 Sep (local) observed at
 *     1.1.0 by scorer 0.91.0, and a run created on 6 Oct and never scored. One series: the plugin
 *     version and the scorer differ, the protocol version and the population kind do not; a trend.
 *   - `beta`, protocol `beta-protokey` versions 1 and 2: established under version 1 on 26 Sep,
 *     provisional with a failed guardrail under version 2 on 3 Oct, both with no surface recorded.
 *     Two series, `Not comparable: a different protocol version`.
 *   - `gamma`, protocol `gamma-protokey` version 1: established on 4 Oct (local) observed at the
 *     nearest recorded version's surface, then not established with no score and no guardrail
 *     verdict on 5 Oct at the version's own. Two series, `Not comparable: a different population`.
 *   - `delta`, a run never scored, which no part may name.
 *   - findings, inserted out of date order: four waiting (a plugin-owned defect on `alpha`, an
 *     unknown with no public owner category on `beta`, an environment defect on `beta`, a platform
 *     defect on `gamma`), one applied, one rejected, one rejected and superseded by the environment
 *     defect, and one strength.
 *
 * Every free text a member may not read is a sentinel the check looks for in the raw answer.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs.
 */
import type pg from "pg";

/** The people a reader signs in as: a member of the team that owns every run, and a superadmin in no team. */
export const MEMBER = "member@evaluation.example.test";
export const SUPERADMIN = "superadmin@evaluation.example.test";

const TEAM = "eval-sentinel-team";
const INITIATIVE = "2026-09-01-eval-sentinel-initiative";

/** Protocol and measure keys, the owning team's words: the superadmin reads them and a member does not. */
export const KEYS = {
  protocols: ["alpha-protokey", "beta-protokey", "gamma-protokey"],
  measures: { alpha: "alpha-measurekey", beta: "beta-measurekey", gamma: "gamma-measurekey" },
} as const;

/** Free text nobody reads through the route, and the team and initiative no answer names. */
const HIDDEN = {
  decisionNote: "DECISION-NOTE-SENTINEL", ownerRef: "OWNER-REF-SENTINEL", evidenceRef: "EVIDENCE-REF-SENTINEL",
};

type Plugin = "alpha" | "beta" | "gamma" | "delta";
type Standing = "established" | "provisional" | "not_established";

/** One run: its plugin and protocol version, the snapshot's surface sentence, and its scoring. */
interface Run {
  name: string; plugin: Plugin; protocol: number; pluginVersion: string; surface: string | null;
  createdAt: string; scoredAt: string | null; scorer: string | null; standing: Standing | null;
  score: number | null; lower: number | null; upper: number | null; guardrail: "pass" | "fail" | null;
}

const RUNS: readonly Run[] = [
  { name: "a1", plugin: "alpha", protocol: 1, pluginVersion: "1.0.0", surface: "zz.plugin_tool at 1.0.0",
    createdAt: "2026-09-20T09:00:00Z", scoredAt: "2026-09-20T10:00:00Z", scorer: "0.90.0",
    standing: "established", score: 6.2, lower: 5.8, upper: 6.6, guardrail: "pass" },
  { name: "a2", plugin: "alpha", protocol: 1, pluginVersion: "1.1.0", surface: "zz.plugin_tool at 1.1.0",
    createdAt: "2026-09-26T12:00:00Z", scoredAt: "2026-09-26T13:00:00Z", scorer: "0.91.0",
    standing: "established", score: 7.1, lower: 6.7, upper: 7.5, guardrail: "pass" },
  { name: "a3", plugin: "alpha", protocol: 1, pluginVersion: "1.1.0", surface: "zz.plugin_tool at 1.1.0",
    createdAt: "2026-10-06T00:00:00Z", scoredAt: null, scorer: null,
    standing: null, score: null, lower: null, upper: null, guardrail: null },
  { name: "b1", plugin: "beta", protocol: 1, pluginVersion: "3.0.0", surface: null,
    createdAt: "2026-09-26T09:00:00Z", scoredAt: "2026-09-26T10:00:00Z", scorer: "0.91.0",
    standing: "established", score: 5, lower: 4.1, upper: 5.9, guardrail: "pass" },
  { name: "b2", plugin: "beta", protocol: 2, pluginVersion: "3.0.0", surface: null,
    createdAt: "2026-10-03T08:00:00Z", scoredAt: "2026-10-03T09:00:00Z", scorer: "0.91.0",
    standing: "provisional", score: 5.4, lower: 4.6, upper: 6.2, guardrail: "fail" },
  { name: "g1", plugin: "gamma", protocol: 1, pluginVersion: "2.1.0",
    surface: "zz.plugin_tool at 2.0.0, the nearest version that recorded one",
    createdAt: "2026-10-03T11:00:00Z", scoredAt: "2026-10-03T12:00:00Z", scorer: "0.92.0",
    standing: "established", score: 8, lower: 7.5, upper: 8.5, guardrail: "pass" },
  { name: "g2", plugin: "gamma", protocol: 1, pluginVersion: "2.1.0", surface: "zz.plugin_tool at 2.1.0",
    createdAt: "2026-10-04T23:00:00Z", scoredAt: "2026-10-05T00:00:00Z", scorer: "0.92.0",
    standing: "not_established", score: null, lower: null, upper: null, guardrail: null },
  { name: "d1", plugin: "delta", protocol: 1, pluginVersion: "0.1.0", surface: "no door of its own: the tools its skills name",
    createdAt: "2026-10-01T00:00:00Z", scoredAt: null, scorer: null,
    standing: null, score: null, lower: null, upper: null, guardrail: null },
];

/** One finding on a run. `pattern` is a sentinel too; `supersededBy` names another finding of the same run. */
interface Finding {
  name: string; run: string; kind: "defect" | "unknown" | "strength";
  owner: "plugin" | "dependency" | "platform" | "environment" | "unknown"; measure: boolean;
  decision: "applied" | "rejected" | "deferred" | null; createdAt: string; supersededBy?: string;
}

/** In insertion order, which is not date order. */
const FINDING_ROWS: readonly Finding[] = [
  { name: "gamma-platform", run: "g1", kind: "defect", owner: "platform", measure: true, decision: "deferred", createdAt: "2026-10-04T00:00:00Z" },
  { name: "beta-environment", run: "b1", kind: "defect", owner: "environment", measure: true, decision: "deferred", createdAt: "2026-09-28T00:00:00Z" },
  { name: "alpha-plugin", run: "a1", kind: "defect", owner: "plugin", measure: true, decision: "deferred", createdAt: "2026-09-21T00:00:00Z" },
  { name: "beta-unknown", run: "b1", kind: "unknown", owner: "unknown", measure: false, decision: "deferred", createdAt: "2026-09-27T00:00:00Z" },
  { name: "alpha-applied", run: "a2", kind: "defect", owner: "platform", measure: true, decision: "applied", createdAt: "2026-09-27T00:00:00Z" },
  { name: "beta-rejected", run: "b2", kind: "defect", owner: "dependency", measure: false, decision: "rejected", createdAt: "2026-10-03T10:00:00Z" },
  { name: "beta-superseded", run: "b1", kind: "defect", owner: "plugin", measure: false, decision: "rejected", createdAt: "2026-09-26T11:00:00Z",
    supersededBy: "beta-environment" },
  { name: "alpha-strength", run: "a1", kind: "strength", owner: "plugin", measure: false, decision: null, createdAt: "2026-09-20T11:00:00Z" },
];

/** Every finding's name. */
export const FINDING_NAMES = FINDING_ROWS.map((f) => f.name);

/** A finding's pattern: the superadmin reads a waiting one's, and a member reads none. */
export const patternOf = (name: string): string => `PATTERN-SENTINEL-${name}`;

/** The sentinels no answer holds, to anybody. */
export const NOBODY_READS = [HIDDEN.decisionNote, HIDDEN.ownerRef, HIDDEN.evidenceRef, TEAM, INITIATIVE];

/** What a reader must find, written out by hand from the lists above and not computed from them. */
export const EXPECTED = {
  tiles: { waiting: 4, established: 1, lastScored: "2026-10-05T00:00:00Z", daysScored: 6 },
  coverageFrom: "2026-09-20T10:00:00Z",
  plugins: [
    { plugin: "alpha", score: { value: 7.1, why: null }, lower: 6.7, upper: 7.5, standing: "established", guardrails: "pass",
      protocol: { key: "alpha-protokey", version: 1 }, scoredAt: "2026-09-26T13:00:00Z" },
    { plugin: "beta", score: { value: 5.4, why: null }, lower: 4.6, upper: 6.2, standing: "provisional", guardrails: "fail",
      protocol: { key: "beta-protokey", version: 2 }, scoredAt: "2026-10-03T09:00:00Z" },
    { plugin: "gamma", score: { value: null, why: "no_data" }, lower: null, upper: null, standing: "not_established",
      guardrails: "not_established", protocol: { key: "gamma-protokey", version: 1 }, scoredAt: "2026-10-05T00:00:00Z" },
  ],
  history: [
    { plugin: "alpha", statement: "Comparable: one protocol version and population", series: [
      { protocol: { key: "alpha-protokey", version: 1 }, population: "the surface recorded at that version", runs: [
        { scoredAt: "2026-09-20T10:00:00Z", score: 6.2, lower: 5.8, upper: 6.6, standing: "established" },
        { scoredAt: "2026-09-26T13:00:00Z", score: 7.1, lower: 6.7, upper: 7.5, standing: "established" },
      ] },
    ] },
    { plugin: "beta", statement: "Not comparable: a different protocol version", series: [
      { protocol: { key: "beta-protokey", version: 1 }, population: null, runs: [
        { scoredAt: "2026-09-26T10:00:00Z", score: 5, lower: 4.1, upper: 5.9, standing: "established" },
      ] },
      { protocol: { key: "beta-protokey", version: 2 }, population: null, runs: [
        { scoredAt: "2026-10-03T09:00:00Z", score: 5.4, lower: 4.6, upper: 6.2, standing: "provisional" },
      ] },
    ] },
    { plugin: "gamma", statement: "Not comparable: a different population", series: [
      { protocol: { key: "gamma-protokey", version: 1 }, population: "the nearest recorded version's surface", runs: [
        { scoredAt: "2026-10-03T12:00:00Z", score: 8, lower: 7.5, upper: 8.5, standing: "established" },
      ] },
      { protocol: { key: "gamma-protokey", version: 1 }, population: "the surface recorded at that version", runs: [
        { scoredAt: "2026-10-05T00:00:00Z", score: null, lower: null, upper: null, standing: "not_established" },
      ] },
    ] },
  ],
  byDecision: { applied: 1, rejected: 1, deferred: 4 },
  byOwner: { platform: 2, dependency: 1, environment: 1, plugin: 1, unknown: 1 },
  /** Oldest first, by finding name; the superadmin's measure key, or null where the finding names none. */
  waiting: [
    { finding: "alpha-plugin", plugin: "alpha", kind: "defect", owner: "plugin", measure: "alpha-measurekey",
      waitingSince: "2026-09-21T00:00:00Z", summary: "A finding on alpha, owned by plugin, awaiting a decision" },
    { finding: "beta-unknown", plugin: "beta", kind: "unknown", owner: "unknown", measure: null,
      waitingSince: "2026-09-27T00:00:00Z", summary: "Evaluation finding awaiting a decision" },
    { finding: "beta-environment", plugin: "beta", kind: "defect", owner: "environment", measure: "beta-measurekey",
      waitingSince: "2026-09-28T00:00:00Z", summary: "A finding on beta, owned by environment, awaiting a decision" },
    { finding: "gamma-platform", plugin: "gamma", kind: "defect", owner: "platform", measure: "gamma-measurekey",
      waitingSince: "2026-10-04T00:00:00Z", summary: "A finding on gamma, owned by platform, awaiting a decision" },
  ],
} as const;

/**
 * Seeds the people, the team, the initiative and every row above into `db`, and answers each
 * finding's id by its name.
 *
 * The database must hold no other evaluation: the route reads every scored run there is.
 */
export async function seedEvaluation(db: pg.ClientBase | pg.Pool): Promise<Map<string, string>> {
  const one = async (sql: string, args: unknown[]): Promise<string> => (await db.query<{ id: string }>(sql, args)).rows[0].id;
  const person = (email: string, role: string): Promise<string> => one(
    "insert into zz.principal (email, display_name, role) values ($1, $2, $3) returning id", [email, email.split("@")[0], role]);
  const member = await person(MEMBER, "member");
  await person(SUPERADMIN, "superadmin");
  const team = await one("insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [TEAM, member]);
  await db.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'admin', $2)", [team, member]);
  await db.query("update zz.principal set active_team_id = $1 where id = $2", [team, member]);
  const initiative = await one("insert into zz.initiative (team_id, slug, opened_by) values ($1, $2, $3) returning id", [team, INITIATIVE, member]);

  const plugins = new Map<string, string>();
  const protocols = new Map<string, string>();
  const measures = new Map<string, string>();
  for (const name of ["alpha", "beta", "gamma", "delta"] as const) {
    const plugin = await one("insert into zz.plugin (name, origin, owner_team_id) values ($1, 'platform', $2) returning id", [name, team]);
    plugins.set(name, plugin);
    for (const version of [...new Set(RUNS.filter((r) => r.plugin === name).map((r) => r.protocol))]) {
      const protocol = await one(
        `insert into zz.eval_protocol_version
           (version, purpose, qualification_policy, scoring_policy, improvement_policy, content_digest, created_at,
            plugin_id, protocol_key, observable_surfaces, recorded_by)
         values ($1, 'seeded', '{}', '{}', '{}', $2, '2026-09-01T00:00:00Z', $3, $4, '{}', $5) returning id`,
        [version, `digest-${name}-${version}`, plugin, `${name}-protokey`, member]);
      protocols.set(`${name}@${version}`, protocol);
      const dimension = await one(
        `insert into zz.eval_dimension (protocol_version_id, key, canonical_kind, weight, required)
         values ($1, 'effectiveness', 'effectiveness', 1, true) returning id`, [protocol]);
      measures.set(`${name}@${version}`, await one(
        `insert into zz.eval_measure (dimension_id, key, evaluator_type, weight, required, definition, protocol_version_id, fact_key)
         values ($1, $2, 'deterministic', 1, true, '{}', $3, 'seeded_fact') returning id`, [dimension, `${name}-measurekey`, protocol]));
    }
  }

  const versions = new Map<string, string>();
  const runs = new Map<string, string>();
  for (const r of RUNS) {
    const at = `${r.plugin}@${r.pluginVersion}`;
    if (!versions.has(at)) {
      versions.set(at, await one("insert into zz.plugin_version (plugin_id, version, digest) values ($1, $2, $3) returning id",
                                 [plugins.get(r.plugin), r.pluginVersion, `digest-${at}`]));
    }
    const snapshot = await one(
      `insert into zz.eval_observation_snapshot
         (usable_run_count, total_run_count, evidence_digest, created_at, plugin_version_id, surface_observed,
          surface_total, surface_source, platform_version, recorded_by)
       values (5, 5, $1, $2, $3, 1, 1, $4, '0.90.0', $5) returning id`,
      [`evidence-${r.name}`, r.createdAt, versions.get(at), r.surface, member]);
    runs.set(r.name, await one(
      `insert into zz.eval_run
         (protocol_version_id, score_status, overall_score, guardrail_status, created_at, team_id, initiative_id,
          observation_snapshot_id, score_lower, score_upper, scorer_version, started_by, scored_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
      [protocols.get(`${r.plugin}@${r.protocol}`), r.standing, r.score, r.guardrail, r.createdAt, team, initiative,
       snapshot, r.lower, r.upper, r.scorer, member, r.scoredAt]));
  }

  // A superseding finding is written before the one it replaces.
  const ids = new Map<string, string>();
  const ordered = [...FINDING_ROWS.filter((f) => !f.supersededBy), ...FINDING_ROWS.filter((f) => f.supersededBy)];
  for (const f of ordered) {
    const run = RUNS.find((r) => r.name === f.run)!;
    ids.set(f.name, await one(
      `insert into zz.eval_finding
         (eval_run_id, kind, pattern, owner_kind, owner_ref, measure_id, evidence_refs, decision, decision_note,
          created_at, superseded_by)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11) returning id`,
      [runs.get(f.run), f.kind, patternOf(f.name), f.owner, f.owner === "plugin" ? null : HIDDEN.ownerRef,
       f.measure ? measures.get(`${run.plugin}@${run.protocol}`) : null, JSON.stringify([HIDDEN.evidenceRef]),
       f.decision, HIDDEN.decisionNote, f.createdAt, f.supersededBy ? ids.get(f.supersededBy) : null]));
  }
  return ids;
}
