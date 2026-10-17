/**
 * checks/console-platform-query-seed.ts — the record `checks/console-platform-query.ts` asks the Platform prepared query
 * and every Platform page about, written into a real zz-core's throwaway database.
 *
 * Weeks are Monday to Monday in the reporting time zone, counted back from the running one as `status-seed.ts` counts
 * them: `back` 0 is the running week, 1 the last whole week (L), 2 the one before it, and so on; an instant is `hours`
 * after its week's first instant, and the running week's are its first instants, so none lies after the clock. Two
 * reports are filed through zz-core's own `bug_report` and then moved; every other row is written as its own writer
 * writes it. What it writes, in the harness's team (one), a second team (two, `query-two`), no team and the shared
 * shelf (`zz-platform`):
 *
 *   - real-work calls from back 3 through the running week, registered and unregistered tools, refused under all four
 *     owners, in both teams and in none, and maintenance calls beside them;
 *   - searches that found something and nothing, widened, not and unrecorded, in both teams; model calls of two
 *     models; three releases and two migrations;
 *   - reports of every impact and status, team two's titled with a sentinel no member's answer may hold;
 *   - two plugins of team two's, scored and with findings of every decision, their patterns and protocol keys sentinels;
 *   - lessons on every shelf and kind, one imported, one superseded;
 *   - sign-ins, administration acts, a person in no team added three weeks back and one deactivated.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs, and this one is listed among those that
 * are not.
 */
import { randomBytes } from "node:crypto";

import { weekStart } from "../scripts/schema/status-seed.ts";
import type { Core } from "../scripts/schema/throwaway-core.ts";

export const TWO = "query-two";
export const SHARED = "zz-platform";
export const SUPERADMIN = "root@query.example.test";
export const TWO_ADMIN = "two@query.example.test";
export const LONER = "loner@query.example.test";
const GONE = "gone@query.example.test";
const HOUR = 3_600_000;

/** What no answer to a member may hold: team two's reports' own titles, its findings' patterns, its protocol keys and
 *  its measures' keys, and the questions searches asked. */
export const SENTINEL = "SENTINEL-PLATFORM-QUERY";

export interface Seeded { now: number; starts: Map<number, number>; member: string; owner: string; one: string }

type Owner = "guardrail" | "ours" | "theirs" | "other" | null;

export async function seedPlatformQuery(c: Core, timezone: string): Promise<Seeded> {
  const sql = c.sql;
  const now = Date.now();
  const starts = new Map<number, number>();
  for (let back = 0; back <= 4; back++) starts.set(back, weekStart(now, back, timezone));
  const at = (back: number, hours: number): string => new Date(starts.get(back)! + hours * HOUR).toISOString();
  const one = async (text: string, args: unknown[]): Promise<string> => (await sql.query<{ id: string }>(text, args)).rows[0].id;

  // Two reports through zz-core's own writer, before anything else is moved.
  const filed: string[] = [];
  for (const [title, impact, surface] of [["The read came back empty", "blocks_work", "document_read"], ["A label is cut short", "cosmetic", "a free-text place"]]) {
    const reply = await c.ok("bug_report", "bug_report", { title, detail: `${title}, seeded.`, impact, surface });
    filed.push(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(reply)?.[0] ?? c.fail("bug_report", reply));
  }

  const member = await c.member();
  const person = (email: string, role: string, back: number): Promise<string> => one(
    "insert into zz.principal (email, display_name, role, created_at) values ($1, $2, $3, $4) returning id::text as id",
    [email, email.split("@")[0], role, at(back, 9)]);
  const root = await person(SUPERADMIN, "superadmin", 3);
  const twoAdmin = await person(TWO_ADMIN, "member", 2);
  await person(LONER, "member", 3);
  await person(GONE, "member", 4);
  await sql.query("update zz.principal set status = 'deactivated' where email = $1", [GONE]);
  const owner = await one("select id::text as id from zz.principal where email = $1", [c.email]);
  const teamOne = await one("select id::text as id from zz.team where slug = $1", [c.team]);
  const two = await one("insert into zz.team (slug, name, created_by, created_at) values ($1, 'Query two', $2, $3) returning id::text as id",
    [TWO, twoAdmin, at(2, 8)]);
  await sql.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'admin', $2)", [two, twoAdmin]);
  await sql.query("update zz.principal set active_team_id = $1 where id = $2", [two, twoAdmin]);
  await sql.query("insert into zz.team (slug, name, created_by) select $1, 'Platform', $2 where not exists (select 1 from zz.team where slug = $1)",
    [SHARED, root]);
  const shared = await one("select id::text as id from zz.team where slug = $1", [SHARED]);
  const teams: Record<"one" | "two" | "shared" | "none", string | null> = { one: teamOne, two, shared, none: null };

  // The vocabulary: the tools zz-core's door registers, which a throwaway zz-core with no release row records none of.
  const core = await one(
    `with p as (insert into zz.plugin (name, origin) values ('zz-core', 'platform') returning id)
     insert into zz.plugin_version (plugin_id, version, digest) select id, '1.0.0', 'sha256:seed' from p returning id`, []);
  for (const tool of ["document_read", "document_write", "knowledge_search", "skill_read", "bug_report"]) {
    await sql.query("insert into zz.plugin_tool (plugin_version_id, name, door) values ($1, $2, 'core')", [core, tool]);
  }

  // Real-work calls: [back, hours, how many, team, tool, the owners of the first few refused, origin].
  const calls: [number, number, number, keyof typeof teams, string, Owner[], string][] = [
    [3, 10, 6, "one", "core:document_read", [], "work"],
    [2, 10, 12, "one", "core:document_read", ["ours", "theirs"], "work"],
    [2, 30, 5, "two", "core:knowledge_search", ["ours", "ours", "guardrail"], "work"],
    [2, 50, 3, "none", "core:quokka_unregistered", [], "work"],
    [1, 10, 15, "one", "core:document_write", ["ours", "ours", "ours", "theirs", "guardrail"], "work"],
    [1, 34, 10, "two", "core:skill_read", ["other", "other"], "work"],
    [1, 58, 4, "one", "core:quokka_unregistered", ["ours"], "work"],
    [1, 82, 2, "none", "core:document_read", [], "work"],
    [1, 106, 5, "one", "core:document_write", ["ours", "ours"], "platform"],
    [0, 0, 3, "two", "core:document_read", ["theirs"], "work"],
  ];
  for (const [back, hours, n, team, tool, owners, origin] of calls) {
    const ts = Array.from({ length: n }, (_, i) => new Date(Date.parse(at(back, hours)) + i * 1000).toISOString());
    const refused = Array.from({ length: n }, (_, i) => owners[i] ?? null);
    await sql.query(
      `insert into zz.event (ts, kind, subject, ok, tool_key, refusal_owner, refusal, origin, team_id, actor_id, session, duration_ms, batched)
       select u.ts, 'tool_call', $3, u.owner is null, $3, u.owner, case when u.owner is null then null else 'seeded refusal' end,
              $4, $5, $6, 'query-session', 100, false
         from unnest($1::timestamptz[], $2::text[]) as u(ts, owner)`,
      [ts, refused, tool, origin, teams[team], team === "two" ? twoAdmin : owner]);
  }

  // Searches: [back, hours, team, results, widened (null: not recorded)].
  const searches: [number, number, keyof typeof teams, number, boolean | null][] = [
    [2, 12, "one", 2, false], [2, 13, "two", 0, null],
    [1, 12, "one", 3, false], [1, 13, "one", 0, true], [1, 14, "one", 1, null],
    [1, 15, "two", 0, false], [1, 16, "two", 0, false], [1, 17, "shared", 2, true],
    [0, 0, "one", 0, false],
  ];
  for (const [i, [back, hours, team, n, widened]] of searches.entries()) {
    const returned = Array.from({ length: n }, (_, k) => `team:seeded/_knowledge/nodes/${String(k + 1).padStart(4, "0")}-seeded.md`);
    await sql.query(
      `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id) values ($1, 'knowledge.search', $2, $3::jsonb, 'work', $4, $5)`,
      [at(back, hours), `${SENTINEL} question ${i % 4}`, JSON.stringify({ returned, ...(widened === null ? {} : { broadened: widened }) }),
       teams[team], owner]);
  }

  // Model calls: [back, hours, purpose, model, ok].
  for (const [back, hours, purpose, model, ok] of [
    [2, 11, "assess", "model-a", true], [1, 11, "assess", "model-a", true], [1, 12, "assess", "model-b", false],
    [1, 13, "judge", "model-b", true], [0, 0, "judge", "model-a", true],
  ] as const) {
    await sql.query(
      `insert into zz.model_call (ts, purpose, model, input_tokens, output_tokens, duration_ms, ok, error) values ($1, $2, $3, 10, 5, 1000, $4, $5)`,
      [at(back, hours), purpose, model, ok, ok ? null : "seeded"]);
  }

  for (const [version, back, hours] of [["0.90.0", 2, 20], ["0.91.0", 1, 20], ["0.91.1", 1, 44]] as const) {
    await sql.query(
      `insert into zz.release (version, console_version, released_at, summary, changelog, upgrade_notes, client_action)
       values ($1, null, $2, $3, $3, null, null)`, [version, at(back, hours), `Release ${version}`]);
  }
  for (const [name, back, hours] of [["900_query_check_a.sql", 2, 21], ["901_query_check_b.sql", 1, 21]] as const) {
    await sql.query("insert into zz.schema_migration (name, applied_at) values ($1, $2)", [name, at(back, hours)]);
  }

  // Reports: [back, hours, team, surface, impact, status, resolved after hours].
  const reports: [number, number, keyof typeof teams, string | null, string, string, number | null][] = [
    [2, 14, "two", "knowledge_search", "wrong_result", "fixed", 30], [2, 40, "two", "core", "confusing", "open", null],
    [1, 14, "one", "document_write", "blocks_work", "duplicate", 2], [1, 15, "two", null, "cosmetic", "not_a_bug", 5],
    [1, 16, "none", "console", "wrong_result", "open", null],
  ];
  // A duplicate's target is a report of its own team's, the first one filed through zz-core.
  const ids: string[] = [];
  for (const [i, [back, hours, team, surface, impact, status, after]] of reports.entries()) {
    ids.push(await one(
      `insert into zz.bug (reported_at, title, detail, surface, platform_version, impact, status, resolution, resolved_at, team_id,
                           reported_by, duplicate_of)
       values ($1, $2, $2, $3, '0.91.0', $4, $5, $6, $7, $8, $9, $10) returning id::text as id`,
      [at(back, hours), `${SENTINEL} report ${i}`, surface, impact, status, after === null ? null : "Seeded.",
       after === null ? null : new Date(Date.parse(at(back, hours)) + after * HOUR).toISOString(), teams[team], owner,
       status === "duplicate" ? filed[0] : null]));
  }
  await sql.query("update zz.bug set reported_at = $2 where id = $1", [filed[0], at(2, 15)]);
  await sql.query("update zz.bug set reported_at = $2, status = 'fixed', resolution = 'Seeded.', resolved_at = $3 where id = $1",
    [filed[1], at(1, 17), at(1, 20)]);

  await seedEvaluation(sql, two, twoAdmin, at);

  // Lessons: [back, hours, shelf, kind, imported, superseded].
  const lessons: [number, number, keyof typeof teams, string, boolean, boolean][] = [
    [2, 10, "one", "decision", false, false], [2, 11, "two", "process", false, false],
    [1, 10, "one", "design", false, false], [1, 11, "one", "decision", true, false], [1, 12, "two", "style", false, false],
    [1, 13, "shared", "knowledge", false, false], [1, 14, "two", "process", false, true], [1, 15, "two", "process", false, false],
  ];
  const nodes: string[] = [];
  for (const [i, [back, hours, shelf, kind, imported]] of lessons.entries()) {
    const team = teams[shelf]!;
    const ordinal = String(i + 1).padStart(4, "0");
    const id = await one(
      `insert into zz.knowledge_node (kind, title, body, team_id, node_ordinal, slug, created_at)
       values ($1, 'seeded', 'seeded', $2, $3, $4, $5) returning id::text as id`, [kind, team, ordinal, `seeded-${ordinal}`, at(back, hours)]);
    nodes.push(id);
    await sql.query(
      `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id) values ($1, 'knowledge.add', $2, $3::jsonb, $4, $5, $6)`,
      [at(back, hours), ordinal, JSON.stringify({ title: "seeded", type: kind, scope: "team", ids: { node: id } }),
       imported ? "platform" : "work", team, owner]);
  }
  for (const [i, l] of lessons.entries()) {
    if (l[5]) await sql.query("update zz.knowledge_node set lifecycle = 'superseded', superseded_by_id = $2 where id = $1", [nodes[i], nodes[i + 1]]);
  }

  // Sign-ins and acts of administration: [back, hours, kind, actor, team].
  for (const [back, hours, kind, actor, team] of [
    [2, 9, "console.sign_in", root, null], [1, 9, "console.sign_in", root, null], [1, 10, "console.sign_in", owner, teamOne],
    [1, 11, "console.sign_in", twoAdmin, two], [1, 12, "console.sign_in", owner, teamOne], [0, 0, "console.sign_in", owner, teamOne],
    [2, 22, "admin.add_member", root, two], [1, 22, "admin.issue_pat", root, teamOne], [1, 23, "team.switch", twoAdmin, two],
  ] as const) {
    await sql.query(
      `insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id) values ($1, $2, $3, '{}'::jsonb, 'work', $4, $5)`,
      [at(back, hours), kind, kind === "admin.add_member" ? `${TWO}:${TWO_ADMIN}` : kind === "team.switch" ? TWO : "", team, actor]);
  }
  await sql.query("insert into zz.event (ts, kind, subject, detail, origin, team_id, actor_id) values ($1, 'console.page_view', 'platform', '{}'::jsonb, 'work', $2, $3)",
    [at(1, 30), teamOne, owner]);
  return { now, starts, member, owner, one: teamOne };
}

/** Two plugins of team two's, `alpha` scored established and then established again, `beta` established and then
 *  provisional; findings of every decision, one superseded and one a strength, which no count counts. */
async function seedEvaluation(sql: Core["sql"], team: string, by: string, at: (back: number, hours: number) => string): Promise<void> {
  const one = async (text: string, args: unknown[]): Promise<string> => (await sql.query<{ id: string }>(text, args)).rows[0].id;
  const initiative = await one("insert into zz.initiative (team_id, slug, opened_by) values ($1, '2026-09-01-query-eval', $2) returning id", [team, by]);
  const runs = new Map<string, string>();
  for (const plugin of ["alpha", "beta"]) {
    const id = await one("insert into zz.plugin (name, origin, owner_team_id) values ($1, 'platform', $2) returning id", [plugin, team]);
    const protocol = await one(
      `insert into zz.eval_protocol_version
         (version, purpose, qualification_policy, scoring_policy, improvement_policy, content_digest, created_at,
          plugin_id, protocol_key, observable_surfaces, recorded_by)
       values (1, 'seeded', '{}', '{}', '{}', $1, $2, $3, $4, '{}', $5) returning id`,
      [`digest-${plugin}`, at(4, 0), id, `${SENTINEL}-${plugin}-protokey`, by]);
    const dimension = await one(
      `insert into zz.eval_dimension (protocol_version_id, key, canonical_kind, weight, required)
       values ($1, 'effectiveness', 'effectiveness', 1, true) returning id`, [protocol]);
    const measure = await one(
      `insert into zz.eval_measure (dimension_id, key, evaluator_type, weight, required, definition, protocol_version_id, fact_key)
       values ($1, $2, 'deterministic', 1, true, '{}', $3, 'seeded_fact') returning id`, [dimension, `${SENTINEL}-${plugin}-measurekey`, protocol]);
    const version = await one("insert into zz.plugin_version (plugin_id, version, digest) values ($1, '1.0.0', $2) returning id", [id, `digest-${plugin}`]);
    for (const [k, back, standing] of [[0, 2, "established"], [1, 1, plugin === "alpha" ? "established" : "provisional"]] as const) {
      const snapshot = await one(
        `insert into zz.eval_observation_snapshot
           (usable_run_count, total_run_count, evidence_digest, created_at, plugin_version_id, surface_observed,
            surface_total, surface_source, platform_version, recorded_by)
         values (5, 5, $1, $2, $3, 1, 1, null, '0.90.0', $4) returning id`, [`evidence-${plugin}-${k}`, at(back, 1), version, by]);
      runs.set(`${plugin}${k}`, await one(
        `insert into zz.eval_run
           (protocol_version_id, score_status, overall_score, guardrail_status, created_at, team_id, initiative_id,
            observation_snapshot_id, score_lower, score_upper, scorer_version, started_by, scored_at)
         values ($1, $2, 7, 'pass', $3, $4, $5, $6, 6, 8, '0.90.0', $7, $8) returning id`,
        [protocol, standing, at(back, 2), team, initiative, snapshot, by, at(back, 3 + k)]));
    }
    runs.set(`${plugin}-measure`, measure);
  }
  // [run, kind, owner, decision, back, hours, superseded by the one after it, which is of the same run].
  const findings: [string, string, string, string, number, number, boolean][] = [
    ["alpha0", "defect", "plugin", "applied", 2, 5, false], ["alpha0", "defect", "platform", "rejected", 2, 6, true],
    ["alpha0", "defect", "platform", "deferred", 2, 8, false], ["beta0", "unknown", "unknown", "deferred", 2, 7, false],
    ["beta1", "defect", "environment", "deferred", 1, 6, false], ["beta1", "strength", "plugin", "none", 1, 7, false],
  ];
  const ids: string[] = [];
  for (const [run, kind, owner, decision, back, hours] of findings) {
    ids.push(await one(
      `insert into zz.eval_finding (eval_run_id, kind, pattern, owner_kind, owner_ref, measure_id, evidence_refs, decision, decision_note, created_at)
       values ($1, $2, $3, $4, null, $5, '[]'::jsonb, $6, 'seeded', $7) returning id`,
      [runs.get(run), kind, `${SENTINEL}-pattern-${randomBytes(4).toString("hex")}`, owner, runs.get(`${run.slice(0, -1)}-measure`),
       kind === "strength" ? null : decision, at(back, hours)]));
  }
  for (const [i, f] of findings.entries()) if (f[6]) await sql.query("update zz.eval_finding set superseded_by = $2 where id = $1", [ids[i], ids[i + 1]]);
}
