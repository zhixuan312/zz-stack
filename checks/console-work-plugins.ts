#!/usr/bin/env node
/**
 * checks/console-work-plugins.ts — Plugins and skills are read in the caller's projection: the
 * catalog, the public score with its comparability, the install command, and the team's own use
 * (AC-6.5).
 *
 *   node checks/console-work-plugins.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner, seeds the evaluation, skills, runs
 * and calls written below over this repository's own catalog, and serves the gateway's own built
 * identity middleware and `/api/console/plugins`, `/skills`, `/skills/:name`,
 * `/plugins/:plugin/eval` and `/platform/evaluation` from this process, signed in with a real
 * console session cookie per person. What it establishes, against the values written below:
 *
 *   - each plugin row answers whether it is required (`zz-core` and the shelved `zz-access`) or
 *     optional, its version, skills and gates, its install command, and its latest public score with
 *     its bounds, standing, protocol version and date, the protocol's key to the superadmin alone;
 *   - the score and the comparability statement are the Evaluation read's own: the newest run of its
 *     history with a score, so a newer run with none leaves the last score standing, and the
 *     history's statement; a plugin never scored answers `score: null`;
 *   - calls, refusals and last run on a plugin and on each skill are the active team's alone, rows
 *     ordered by the team's last run, and another team's calls change none of them, nor does a
 *     maintenance call (`origin` not `work`) carrying the team's skill version;
 *   - `/skills` and `/skills/:name` answer the active team's figures, `plugin` narrows `/skills` to
 *     that plugin's skills, an unknown plugin answering none, and a plugin given twice is refused;
 *   - a person in no team is refused 400; no route under `/api/console/plugins` or `/skills` accepts
 *     a write, and reading starts no evaluation;
 *   - the owner's `/plugins/:plugin/eval` still refuses a member of another team;
 *   - the key sets match the console's fake answers, plugin by plugin.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { signIn } from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-work-plugins";
const DONE = "console-work-plugins: each plugin answers whether it is required, its install command and its public " +
  "score with the Evaluation read's selection and comparability, its calls the active team's alone, /skills narrowed " +
  "by plugin, no write and no evaluation started, and the key sets the fake's: ok";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "work-plugins.ts");

const ONE = "plugins-one";
const TWO = "plugins-two";
const MEMBER = "member@plugins.example.test";
const OTHER = "other@plugins.example.test";
const SUPERADMIN = "superadmin@plugins.example.test";
const NOBODY = "nobody@plugins.example.test";

type Obj = Record<string, unknown>;
interface Answer { status: number; body: Obj; text: string }

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);
const show = (v: unknown): string => JSON.stringify(v).slice(0, 700);
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (step: string, what: string, got: unknown, want: unknown): void => {
  if (!isDeepStrictEqual(got, want)) fail(step, `${what} reads ${show(got)}, not ${show(want)}`);
};

/* ---- The seed ----
 *
 * Over this repository's catalog: `sdlc` and `zz-plugin-eval` are optional, `zz-core` and `zz-access`
 * required. Evaluations, each plugin owned by team one:
 *
 *   - `sdlc`, protocol `sdlc-protokey` version 1: established 6.2 on 20 Sept observed at 1.0.0, then
 *     established 7.1 on 26 Sept observed at the platform's own version, its release. One series.
 *   - `zz-plugin-eval`, protocol `eval-protokey`: established 5.0 under version 1 on 26 Sept, then not
 *     established, with no score, under version 2 on 3 Oct. The Evaluation read's latest is the
 *     second; the catalog's score is the first, which has a value. Not comparable.
 *   - `zz-access`, a run never scored. `zz-core`, nothing.
 *
 * Calls (`zz.event` tool calls), each naming its skill's version:
 *
 *   team one   sdlc-spec    core:document_write x3 ok, core:document_read x1 refused, last 5 Oct 10:00
 *              sdlc-plan    core:document_write x2 ok, last 4 Oct 09:00
 *              zz-platform  core:skill_read x2 ok and x1 refused, last 6 Oct 08:00
 *   team two   sdlc-spec    eval:plugin_profile x5, 2 refused, last 7 Oct 12:00
 *              zz-access    access:whoami x2 ok, last 8 Oct 12:00
 *   no team    sdlc-plan    core:document_write x1, counted for nobody
 *
 * Runs (`zz.skill_run`):
 *
 *   team one   sdlc-spec    3 calls, 1 refused, 2,048 B, 5 Oct 09:00 to 09:30; and one call at 10:00, unmeasured
 *              zz-platform  3 calls, 1 refused, 4,096 B, 6 Oct 07:00 to 08:00
 *   team two   sdlc-spec    5 calls, 2 refused, 1 MiB, 7 Oct 11:00 to 12:00
 */
interface Scoring {
  plugin: string; protocol: number; version: string; surface: string | null; at: string;
  standing: "established" | "provisional" | "not_established" | null; score: number | null; lower: number | null; upper: number | null;
}
interface Call { team: string | null; skill: string; tool: string; ok: boolean; at: string }

const scorings = (platform: string): Scoring[] => [
  { plugin: "sdlc", protocol: 1, version: "1.0.0", surface: "zz.plugin_tool at 1.0.0", at: "2026-09-20T10:00:00Z",
    standing: "established", score: 6.2, lower: 5.8, upper: 6.6 },
  { plugin: "sdlc", protocol: 1, version: platform, surface: `zz.plugin_tool at ${platform}`, at: "2026-09-26T13:00:00Z",
    standing: "established", score: 7.1, lower: 6.7, upper: 7.5 },
  { plugin: "zz-plugin-eval", protocol: 1, version: "1.0.0", surface: null, at: "2026-09-26T10:00:00Z",
    standing: "established", score: 5, lower: 4.1, upper: 5.9 },
  { plugin: "zz-plugin-eval", protocol: 2, version: "1.0.0", surface: null, at: "2026-10-03T09:00:00Z",
    standing: "not_established", score: null, lower: null, upper: null },
  { plugin: "zz-access", protocol: 1, version: "1.0.0", surface: null, at: "", standing: null, score: null, lower: null, upper: null },
];
const PROTOKEY: Record<string, string> = { "sdlc": "sdlc-protokey", "zz-plugin-eval": "eval-protokey", "zz-access": "access-protokey" };

const calls = (team: string | null, skill: string, tool: string, n: number, refused: number, last: string): Call[] =>
  Array.from({ length: n }, (_, i) => ({
    team, skill, tool, ok: i >= refused, at: new Date(Date.parse(last) - (n - 1 - i) * 60_000).toISOString(),
  }));
const CALLS: Call[] = [
  ...calls(ONE, "sdlc-spec", "core:document_write", 3, 0, "2026-10-05T09:59:00Z"),
  ...calls(ONE, "sdlc-spec", "core:document_read", 1, 1, "2026-10-05T10:00:00Z"),
  ...calls(ONE, "sdlc-plan", "core:document_write", 2, 0, "2026-10-04T09:00:00Z"),
  ...calls(ONE, "zz-platform", "core:skill_read", 3, 1, "2026-10-06T08:00:00Z"),
  ...calls(TWO, "sdlc-spec", "eval:plugin_profile", 5, 2, "2026-10-07T12:00:00Z"),
  ...calls(TWO, "zz-access", "access:whoami", 2, 0, "2026-10-08T12:00:00Z"),
  ...calls(null, "sdlc-plan", "core:document_write", 1, 0, "2026-10-09T12:00:00Z"),
];
const RUNS = [
  { team: ONE, skill: "sdlc-spec", calls: 3, refusals: 1, bytes: 2_048, from: "2026-10-05T09:00:00Z", to: "2026-10-05T09:30:00Z" },
  { team: ONE, skill: "sdlc-spec", calls: 1, refusals: 0, bytes: null, from: "2026-10-05T10:00:00Z", to: "2026-10-05T10:00:00Z" },
  { team: ONE, skill: "zz-platform", calls: 3, refusals: 1, bytes: 4_096, from: "2026-10-06T07:00:00Z", to: "2026-10-06T08:00:00Z" },
  { team: TWO, skill: "sdlc-spec", calls: 5, refusals: 2, bytes: 1_048_576, from: "2026-10-07T11:00:00Z", to: "2026-10-07T12:00:00Z" },
];

async function seed(db: pg.ClientBase, platform: string): Promise<void> {
  const one = async (sql: string, args: unknown[]): Promise<string> => (await db.query<{ id: string }>(sql, args)).rows[0].id;
  const person = (email: string, role: string): Promise<string> => one(
    "insert into zz.principal (email, display_name, role) values ($1, $2, $3) returning id", [email, email.split("@")[0], role]);
  const ids = new Map<string, string>();
  for (const [email, role] of [[MEMBER, "member"], [OTHER, "member"], [SUPERADMIN, "superadmin"], [NOBODY, "member"]]) {
    ids.set(email, await person(email, role));
  }
  const teams = new Map<string, string>();
  for (const [slug, who] of [[ONE, [MEMBER, SUPERADMIN]], [TWO, [OTHER]]] as const) {
    const team = await one("insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [slug, ids.get(who[0])]);
    teams.set(slug, team);
    for (const email of who) {
      await db.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'admin', $2)", [team, ids.get(email)]);
      await db.query("update zz.principal set active_team_id = $1 where id = $2", [team, ids.get(email)]);
    }
  }
  const owner = ids.get(MEMBER)!;
  const initiative = await one("insert into zz.initiative (team_id, slug, opened_by) values ($1, '2026-09-01-plugins', $2) returning id",
                               [teams.get(ONE), owner]);

  const plugins = new Map<string, string>();
  const protocols = new Map<string, string>();
  const versions = new Map<string, string>();
  for (const s of scorings(platform)) {
    if (!plugins.has(s.plugin)) {
      plugins.set(s.plugin, await one("insert into zz.plugin (name, origin, owner_team_id) values ($1, 'platform', $2) returning id",
                                      [s.plugin, teams.get(ONE)]));
    }
    const pk = `${s.plugin}@${s.protocol}`;
    if (!protocols.has(pk)) {
      protocols.set(pk, await one(
        `insert into zz.eval_protocol_version
           (version, purpose, qualification_policy, scoring_policy, improvement_policy, content_digest, created_at,
            plugin_id, protocol_key, observable_surfaces, recorded_by)
         values ($1, 'seeded', '{}', '{}', '{}', $2, '2026-09-01T00:00:00Z', $3, $4, '{}', $5) returning id`,
        [s.protocol, `digest-${pk}`, plugins.get(s.plugin), PROTOKEY[s.plugin], owner]));
    }
    const vk = `${s.plugin}@${s.version}`;
    if (!versions.has(vk)) {
      versions.set(vk, await one("insert into zz.plugin_version (plugin_id, version, digest) values ($1, $2, $3) returning id",
                                 [plugins.get(s.plugin), s.version, `digest-${vk}`]));
    }
    const created = s.at || "2026-10-01T00:00:00Z";
    const snapshot = await one(
      `insert into zz.eval_observation_snapshot
         (usable_run_count, total_run_count, evidence_digest, created_at, plugin_version_id, surface_observed,
          surface_total, surface_source, platform_version, recorded_by)
       values (5, 5, $1, $2, $3, 1, 1, $4, '0.90.0', $5) returning id`,
      [`evidence-${vk}-${created}`, created, versions.get(vk), s.surface, owner]);
    await db.query(
      `insert into zz.eval_run
         (protocol_version_id, score_status, overall_score, guardrail_status, created_at, team_id, initiative_id,
          observation_snapshot_id, score_lower, score_upper, scorer_version, started_by, scored_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [protocols.get(pk), s.standing, s.score, s.standing ? "pass" : null, created, teams.get(ONE), initiative,
       snapshot, s.lower, s.upper, s.at ? "0.90.0" : null, owner, s.at || null]);
  }

  const skills = new Map<string, string>();
  for (const name of ["sdlc-spec", "sdlc-plan", "zz-platform", "zz-access"]) {
    const skill = await one("insert into zz.skill (name) values ($1) returning id", [name]);
    skills.set(name, await one("insert into zz.skill_version (skill_id, version, content_hash) values ($1, '1.0.0', $2) returning id",
                               [skill, createHash("sha256").update(name).digest("hex")]));
  }
  for (const c of CALLS) {
    await db.query(
      `insert into zz.event (ts, kind, subject, ok, team_id, tool_key, skill_version_id)
       values ($1, 'tool_call', $2, $3, $4, $2, $5)`,
      [c.at, c.tool, c.ok, c.team ? teams.get(c.team) : null, skills.get(c.skill)]);
  }
  for (const [i, r] of RUNS.entries()) {
    await db.query(
      `insert into zz.skill_run (team_id, skill_version_id, session, calls, refusals, bytes_total, started_at, ended_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [teams.get(r.team), skills.get(r.skill), `session-${i}`, r.calls, r.refusals, r.bytes, r.from, r.to]);
  }
}

/* ---- What a reader must find, written out by hand from the seed above ---- */

const score = (admin: boolean, plugin: string, s: { value: number; lower: number; upper: number; version: number; at: string }) => ({
  value: s.value, lower: s.lower, upper: s.upper, standing: "established",
  protocol: { key: admin ? PROTOKEY[plugin] : null, version: s.version }, scoredAt: s.at,
});
/** Each plugin's public facts as `admin` or not reads them, and team one's use, in the order team one's last run puts them. */
const expectedOne = (admin: boolean) => [
  { plugin: "zz-core", required: true, install: "claude plugin install zz-core@zz-stack", score: null,
    comparability: "No score to compare", yourTeam: { calls: 3, failed: 1, lastRun: "2026-10-06T08:00:00Z" } },
  { plugin: "sdlc", required: false, install: "claude plugin install sdlc@zz-stack",
    score: score(admin, "sdlc", { value: 7.1, lower: 6.7, upper: 7.5, version: 1, at: "2026-09-26T13:00:00Z" }),
    comparability: "Comparable: one protocol version and population", yourTeam: { calls: 6, failed: 1, lastRun: "2026-10-05T10:00:00Z" } },
  { plugin: "zz-access", required: true, install: "claude plugin install zz-access@zz-stack", score: null,
    comparability: "No score to compare", yourTeam: { calls: 0, failed: 0, lastRun: null } },
  { plugin: "zz-plugin-eval", required: false, install: "claude plugin install zz-plugin-eval@zz-stack",
    score: score(admin, "zz-plugin-eval", { value: 5, lower: 4.1, upper: 5.9, version: 1, at: "2026-09-26T10:00:00Z" }),
    comparability: "Not comparable: a different protocol version", yourTeam: { calls: 0, failed: 0, lastRun: null } },
];
/** Team one's skills, by name. */
const SKILLS_ONE = [
  { name: "sdlc-spec", version: "1.0.0", kind: "plugin_skill", flow: null, retired: false, runs: 2, calls: 4, callsAvg: 2, callsMax: 3,
    timedRuns: 1, refusals: 1, durationAvg: 1800, durationMedian: 1800, durationMax: 1800, durationTotal: 1800, kbPerRun: 2, mbTotal: 0,
    logged: { calls: 4, failed: 1, tools: 2 } },
  { name: "zz-platform", version: "1.0.0", kind: "plugin_skill", flow: null, retired: false, runs: 1, calls: 3, callsAvg: 3, callsMax: 3,
    timedRuns: 1, refusals: 1, durationAvg: 3600, durationMedian: 3600, durationMax: 3600, durationTotal: 3600, kbPerRun: 4, mbTotal: 0,
    logged: { calls: 3, failed: 1, tools: 1 } },
];
const DETAIL_ONE = {
  skill: "sdlc-spec",
  surfaces: [{ surface: "core", calls: 4, failed: 1, tools: 2 }],
  busiestTools: [{ tool: "core:document_write", calls: 3, failed: 0 }, { tool: "core:document_read", calls: 1, failed: 1 }],
};

/** Where two answers' shapes differ: at an object both hold, the key sets; at an array both hold, the first
 *  elements, the same way; a null on either side, nothing. */
function shapeDiffs(a: unknown, b: unknown, path: string, out: string[]): string[] {
  if (a === null || b === null) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length && b.length) shapeDiffs(a[0], b[0], `${path}[0]`, out);
  } else if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) out.push(`${path || "the answer"} has keys {${ka.join(", ")}} where the fake has {${kb.join(", ")}}`);
    for (const k of ka.filter((x) => kb.includes(x))) shapeDiffs(a[k], b[k], path ? `${path}.${k}` : k, out);
  }
  return out;
}

type Row = Obj & { plugin: string; skills: Obj[]; documents: { gate: boolean }[]; yourTeam: Obj };
const rowsOf = (step: string, a: Answer): Row[] => {
  if (a.status !== 200 || !Array.isArray(a.body.plugins)) fail(step, `answered ${a.status}: ${a.text.slice(0, 400)}`);
  return a.body.plugins as Row[];
};
const skillOf = (r: Row, name: string): Obj => r.skills.find((s) => s.name === name) ?? fail("a skill", `${r.plugin} ships no ${name}`);
const ofTeam = (r: Row) => ({ plugin: r.plugin, required: r.required, install: r.install, score: r.score, comparability: r.comparability, yourTeam: r.yourTeam });

async function cases(ask: (email: string | null, path: string, method?: string) => Promise<Answer>, db: pg.Client,
                     platform: string, fakes: { plugins: Fn; skills: Fn; skillDetail: Fn }): Promise<void> {
  let step = "the catalog in a member's projection";
  const member = await ask(MEMBER, "/plugins");
  const rows = rowsOf(step, member);
  same(step, "the rows", rows.map(ofTeam), expectedOne(false));
  for (const r of rows) {
    if (r.version !== platform || r.gates !== r.documents.filter((d) => d.gate).length || !r.skills.length) {
      fail(step, `${r.plugin} reads version ${show(r.version)}, gates ${show(r.gates)}, ${r.skills.length} skills`);
    }
    for (const gone of ["latestEval", "calls", "failed", "lastRun"]) if (gone in r) fail(step, `${r.plugin} still carries ${gone}`);
  }
  const sdlc = rows[1];
  same(step, "sdlc's release", sdlc.release, { version: platform, digest: `digest-sdlc@${platform}`, evals: 1 });
  same(step, "sdlc's skills", [skillOf(sdlc, "sdlc-spec"), skillOf(sdlc, "sdlc-plan"), skillOf(sdlc, "sdlc-explore")]
    .map((s) => [s.name, s.calls, s.everRun, s.lastRun]), [
    ["sdlc-spec", 4, true, "2026-10-05T10:00:00Z"], ["sdlc-plan", 2, true, "2026-10-04T09:00:00Z"], ["sdlc-explore", 0, false, null]]);
  same(step, "zz-core's zz-platform", [skillOf(rows[0], "zz-platform")].map((s) => [s.calls, s.everRun, s.lastRun]),
    [[3, true, "2026-10-06T08:00:00Z"]]);
  pass("zz-core and zz-access required, sdlc and zz-plugin-eval optional, each with the platform's version, its skills and " +
       "gates and its install line; sdlc 7.1 between 6.7 and 7.5 under protocol version 1 on 26 Sept with no key, zz-plugin-eval " +
       "5.0 under version 1, never-scored plugins null; team one's six sdlc calls, one refused, and three of zz-platform, the " +
       "unteamed call counted for nobody, rows by the team's last run");

  step = "a maintenance call is no use of a plugin";
  // The newest call of all, so counting it would move the last run as well as the calls. The skills' own reads,
  // taken before it, must read the same after it.
  const skillsBefore = (await ask(MEMBER, "/skills")).body;
  const skillBefore = (await ask(MEMBER, "/skills/sdlc-spec")).body;
  const maintained = (await db.query<{ id: string }>(
    `insert into zz.event (ts, kind, subject, ok, team_id, tool_key, skill_version_id, origin)
     select '2026-10-10T12:00:00Z', 'tool_call', 'core:document_write', true, t.id, 'core:document_write', sv.id, 'platform'
       from zz.team t, zz.skill_version sv join zz.skill s on s.id = sv.skill_id
      where t.slug = $1 and s.name = 'sdlc-spec' returning id::text as id`, [ONE])).rows[0].id;
  try {
    const after = rowsOf(step, await ask(MEMBER, "/plugins"));
    same(step, "the rows", after.map(ofTeam), expectedOne(false));
    same(step, "sdlc-spec", [skillOf(after[1], "sdlc-spec")].map((s) => [s.calls, s.lastRun]), [[4, "2026-10-05T10:00:00Z"]]);
    same(step, "/skills", (await ask(MEMBER, "/skills")).body, skillsBefore);
    same(step, "/skills/sdlc-spec", (await ask(MEMBER, "/skills/sdlc-spec")).body, skillBefore);
  } finally {
    await db.query("delete from zz.event where id = $1::bigint", [maintained]);
  }
  pass("a maintenance client's call of team one's sdlc-spec, the newest call recorded, moves neither sdlc's calls and last run nor the skill's, nor what /skills and /skills/sdlc-spec answer");

  step = "the superadmin reads the protocol's key";
  same(step, "the rows", rowsOf(step, await ask(SUPERADMIN, "/plugins")).map(ofTeam), expectedOne(true));
  pass("the superadmin, in team one, reads the same rows with each score's protocol key");

  step = "the Evaluation read's selection and comparability";
  const evaluation = await ask(MEMBER, "/platform/evaluation");
  type Scored = { scoredAt: string; score: number | null; lower: number | null; upper: number | null; standing: string };
  const history = (evaluation.body.history as { state: string; data: { plugin: string; series: { protocol: Obj; runs: Scored[] }[]; statement: string }[] });
  if (evaluation.status !== 200 || history?.state !== "ok") fail(step, `the Evaluation read answered ${evaluation.status}: ${evaluation.text.slice(0, 300)}`);
  for (const h of history.data) {
    const row = rows.find((r) => r.plugin === h.plugin) ?? fail(step, `no catalog row for ${h.plugin}`);
    const valued = h.series.flatMap((s) => s.runs.filter((r) => r.score !== null).map((r) => ({ ...r, protocol: s.protocol })))
      .sort((a, b) => b.scoredAt.localeCompare(a.scoredAt))[0];
    const want = valued ? { value: valued.score, lower: valued.lower, upper: valued.upper, standing: valued.standing, protocol: valued.protocol, scoredAt: valued.scoredAt } : null;
    same(step, `${h.plugin}'s score`, row.score, want);
    same(step, `${h.plugin}'s comparability`, row.comparability, valued ? h.statement : "No score to compare");
  }
  const latest = ((evaluation.body.plugins as { data: Obj[] }).data ?? []).find((p) => p.plugin === "zz-plugin-eval");
  same(step, "the Evaluation read's latest for zz-plugin-eval", [latest?.standing, (latest?.score as Obj)?.value], ["not_established", null]);
  pass("each catalog score is the newest scored run with a value in the Evaluation read's own history, with its statement; " +
       "zz-plugin-eval's newer run with no score is the Evaluation read's latest and leaves 5.0 standing in the catalog");

  step = "another team's projection";
  const two = rowsOf(step, await ask(OTHER, "/plugins"));
  same(step, "team two's use", two.map((r) => [r.plugin, r.yourTeam]), [
    ["zz-access", { calls: 2, failed: 0, lastRun: "2026-10-08T12:00:00Z" }], ["sdlc", { calls: 5, failed: 2, lastRun: "2026-10-07T12:00:00Z" }],
    ["zz-core", { calls: 0, failed: 0, lastRun: null }], ["zz-plugin-eval", { calls: 0, failed: 0, lastRun: null }]]);
  const evalOwn = await ask(MEMBER, "/plugins/sdlc/eval");
  const evalOther = await ask(OTHER, "/plugins/sdlc/eval");
  if (evalOwn.status !== 200 || evalOther.status !== 403) fail(step, `sdlc's eval answered the owner ${evalOwn.status}, team two ${evalOther.status}`);
  pass("team two reads its own five sdlc calls and two of zz-access, first by its last run, and the same scores; the owner's " +
       "sdlc eval answers team one's member and refuses team two's 403");

  step = "the skills, narrowed by plugin";
  const skills = await ask(MEMBER, "/skills");
  same(step, "team one's skills", skills.body, { skills: SKILLS_ONE });
  same(step, "?plugin=sdlc", (await ask(MEMBER, "/skills?plugin=sdlc")).body, { skills: [SKILLS_ONE[0]] });
  same(step, "?plugin=zz-core", (await ask(MEMBER, "/skills?plugin=zz-core")).body, { skills: [SKILLS_ONE[1]] });
  same(step, "?plugin=zz-access", (await ask(MEMBER, "/skills?plugin=zz-access")).body, { skills: [] });
  same(step, "?plugin=no-such-plugin", (await ask(MEMBER, "/skills?plugin=no-such-plugin")).body, { skills: [] });
  const twice = await ask(MEMBER, "/skills?plugin=sdlc&plugin=zz-core");
  if (twice.status !== 400) fail(step, `a plugin given twice answered ${twice.status}: ${twice.text.slice(0, 300)}`);
  const detail = await ask(MEMBER, "/skills/sdlc-spec");
  same(step, "sdlc-spec's calls by door", detail.body, DETAIL_ONE);
  same(step, "team two's sdlc-spec by door", ((await ask(OTHER, "/skills/sdlc-spec")).body.surfaces), [{ surface: "eval", calls: 5, failed: 2, tools: 1 }]);
  pass("team one's skills are sdlc-spec's two runs and zz-platform's one, with their calls, refusals, durations over the timed " +
       "run and output; plugin narrows them, zz-access and an unknown plugin answering none and a plugin given twice 400; " +
       "sdlc-spec's calls by door are team one's core calls, team two's its eval calls");

  step = "a person in no team";
  for (const path of ["/plugins", "/skills", "/skills/sdlc-spec"]) {
    const a = await ask(NOBODY, path);
    if (a.status !== 400) fail(step, `${path} answered ${a.status}: ${a.text.slice(0, 300)}`);
  }
  if ((await ask(null, "/plugins")).status !== 401) fail(step, "no session was not refused 401");
  pass("a person in no team is refused 400 on /plugins, /skills and /skills/:name, and no session 401");

  step = "no write, and no evaluation started";
  const runsBefore = (await db.query<{ n: number }>("select count(*)::int as n from zz.eval_run")).rows[0].n;
  for (const path of ["/plugins", "/plugins/sdlc", "/plugins/sdlc/eval", "/plugins/sdlc/skills/sdlc-spec", "/skills", "/skills/sdlc-spec"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const w = await ask(SUPERADMIN, path, method);
      if (w.status !== 404) fail(step, `${method} ${path} answered ${w.status}: ${w.text.slice(0, 300)}`);
    }
  }
  const runsAfter = (await db.query<{ n: number }>("select count(*)::int as n from zz.eval_run")).rows[0].n;
  if (runsAfter !== runsBefore) fail(step, `${runsAfter - runsBefore} evaluation runs appeared`);
  pass("no write method is answered under /api/console/plugins or /skills, and reading started no evaluation");

  step = "the key sets match the console's fake answers";
  const who = { activeTeam: "atlas", superadmin: false, email: "ava.lindqvist@example.com" };
  const [fs, fakePlugins] = fakes.plugins(who) as [number, { plugins: Row[] }];
  const [ss, fakeSkills] = fakes.skills(who, new URLSearchParams()) as [number, Obj];
  const [ds, fakeDetail] = fakes.skillDetail(who, "sdlc-spec") as [number, Obj];
  if (fs !== 200 || ss !== 200 || ds !== 200) fail(step, `the fake answered ${fs}, ${ss}, ${ds}`);
  const diffs = [
    ...shapeDiffs({ ...member.body, plugins: [] }, { ...fakePlugins, plugins: [] }, "", []),
    ...rows.flatMap((r) => {
      const f = fakePlugins.plugins.find((x) => x.plugin === r.plugin);
      return f ? shapeDiffs(r, f, `plugins[${r.plugin}]`, []) : [`the fake has no ${r.plugin}`];
    }),
    ...shapeDiffs(skills.body, fakeSkills, "skills", []),
    ...shapeDiffs(detail.body, fakeDetail, "skills/:name", []),
  ];
  if (!sdlc.score || !sdlc.release || !(fakePlugins.plugins.find((x) => x.plugin === "sdlc")?.score)) fail(step, "sdlc's score or release is missing, so its keys were not compared");
  if (diffs.length) fail(step, diffs.join("; "));
  pass("every plugin row, its score, release, team use and first skill, a /skills row and a skill's calls by door have the fake's keys");

  step = "another team's calls change nothing";
  const reads = ["/plugins", "/skills", "/skills?plugin=sdlc", "/skills/sdlc-spec"];
  const before = await Promise.all(reads.map((p) => ask(MEMBER, p)));
  await db.query("delete from zz.event e using zz.team t where t.id = e.team_id and t.slug = $1", [TWO]);
  await db.query("delete from zz.skill_run r using zz.team t where t.id = r.team_id and t.slug = $1", [TWO]);
  const after = await Promise.all(reads.map((p) => ask(MEMBER, p)));
  for (const [i, p] of reads.entries()) same(step, p, after[i].body, before[i].body);
  pass("with team two's calls and runs deleted, every answer team one reads is as before");
}

type Fn = (...args: unknown[]) => [number, unknown];

async function run(db: pg.Client, url: string): Promise<void> {
  // DELIBERATE: set before the gateway's modules load, which read each once.
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  process.env.ZZ_SKILLS_DIR = join(root, "skills");
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const { PLATFORM_VERSION } = (await load("client-package.js")) as { PLATFORM_VERSION: string };
  await seed(db, PLATFORM_VERSION);
  const cookie = new Map<string, string>();
  for (const email of [MEMBER, OTHER, SUPERADMIN, NOBODY]) cookie.set(email, await signIn(db, email));

  const express = (await import("express")).default;
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { identityMiddleware } = (await load("identity.js")) as { identityMiddleware: () => RequestHandler };
  type Mount = (app: Express) => void;
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate before every console route.
  app.use(identityMiddleware());
  ((await load("console/catalog.js")) as { mountCatalog: Mount }).mountCatalog(app);
  ((await load("console/skills.js")) as { mountSkills: Mount }).mountSkills(app);
  ((await load("console/plugin-eval.js")) as { mountPluginEval: Mount }).mountPluginEval(app);
  ((await load("console/platform-evaluation.js")) as { mountPlatformEvaluation: Mount }).mountPlatformEvaluation(app);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/console`;
  const ask = async (email: string | null, path: string, method = "GET"): Promise<Answer> => {
    const res = await fetch(`${base}${path}`, {
      method, headers: email ? { cookie: `zz_console=${cookie.get(email)}` } : {}, signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: Obj = {};
    try { const v: unknown = JSON.parse(text); if (isObj(v)) body = v; } catch { /* not JSON: body stays empty */ }
    return { status: res.status, body, text };
  };

  try {
    let fakes: { plugins: Fn; skills: Fn; skillDetail: Fn };
    try {
      fakes = (await import(pathToFileURL(FAKE).href)) as typeof fakes;
    } catch (err) {
      return fail("the console's fake", `could not read ${FAKE}: ${(err as Error).message}`);
    }
    await cases(ask, db, PLATFORM_VERSION, fakes);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await dbModule.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
    delete process.env.ZZ_CATALOG_DIR;
    delete process.env.ZZ_SKILLS_DIR;
  }
}

async function main(): Promise<number> {
  let dbUrl = "";
  try {
    await withThrowawayDb((db) => run(db, dbUrl), async (u) => { dbUrl = u; });
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error(`${NAME}: Docker is not available — the check could not run, which is not a pass`);
      return 2;
    }
    console.error(err instanceof CaseFailure ? err.message : `${NAME}: ${String((err as Error)?.stack ?? err)}`);
    return 1;
  }
  console.log(DONE);
  return 0;
}

process.exitCode = await main();
