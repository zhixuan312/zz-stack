#!/usr/bin/env node
/**
 * checks/console-plugin-eval-shape.ts — one plugin's evaluation, read through the gateway's own
 * identity gate and route on a real database, holds the console's fake answer to its shape in every
 * state the route answers (bug 58cbc684: the fake carried a run status, a guardrails list and an
 * `evolvable` flag the gateway never sends, so the console drew "Run undefined" on a real run).
 *
 *   node checks/console-plugin-eval-shape.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), seeds the
 * evaluation below, and serves the gateway's own built
 * identity middleware and `GET /api/console/plugins/:plugin/eval` from this process, signed in with
 * a real console session cookie. What it establishes:
 *
 *   - a scored plugin answers its newest SCORED run, not a newer one never scored, with the run's
 *     score, interval, coverage, guardrail status, scorer, protocol and dates as the seed writes
 *     them; its guardrail is a measure flagged inside its dimension, with the value its assessment
 *     holds; its evaluator's qualification, its release owner and its candidate with the refused
 *     release beside it;
 *   - a plugin with a version and no scored run answers `run: null`; one registered and never
 *     profiled answers `subjectVersion: null`; a name nothing registered answers its name and
 *     `found: false` and nothing else;
 *   - the owning team's member reads the scored plugin, and is refused 403 on a name nothing
 *     registered;
 *   - each answer agrees in shape with the console's fake one for the same state, read from the
 *     sibling checkout: where both hold an object their key sets are equal, where both hold an array
 *     their first elements are compared the same way, and a null on either side is compared with
 *     nothing. Every list the comparison descends into is non-empty on both sides, so no part of the
 *     run's shape is passed by being absent.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Express, RequestHandler } from "express";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { MEMBER, SUPERADMIN, seedEvaluation } from "../scripts/schema/evaluation-seed.ts";
import { signIn } from "../scripts/schema/status-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";
import { shapeDiffs } from "../scripts/schema/shape-diffs.ts";

/*
 * One plugin's evaluation in each state the plugin evaluation read answers, seeded into a throwaway
 * database on top of `seedEvaluation` (evaluation-seed.ts) and never in place of it. The rows are this
 * check's own fixture, written directly, so they live here and not under the write trees the evaluation
 * rules scan: a scored run's coverage set after it was scored, and assessments written without zz-core's
 * subject resolver, are what those rules refuse of a writer.
 *
 * What it adds:
 *
 *   - `alpha`'s newest scored run (`a2`, at 1.1.0; `a3` against the same version is newer and never
 *     scored) gains everything the seed leaves out of a scored run: its measure coverage, one
 *     `eval_run_dimension` row, a guardrail measure with a value and a model-backed measure the run
 *     excluded, both assessed, the model-backed measure's evaluator and its qualification, a release
 *     owner, and one improvement run whose candidate was built and whose release was refused;
 *   - `epsilon`, registered and never profiled: no plugin version at all.
 *
 * `delta` (a version and a run never scored) and a name nothing registered come from the base seed
 * as they are.
 */

/** The plugin in each state, by the name the route is asked for. */
const PLUGINS = { scored: "alpha", neverScored: "delta", neverProfiled: "epsilon", unregistered: "no-such-plugin" } as const;

/** What the seeded scored run answers, written out by hand. */
const EXPECTED_RUN = {
  scoreStatus: "established", overallScore: 7.1, scoreInterval: { lower: 6.7, upper: 7.5 }, measureCoverage: 0.5,
  guardrailStatus: "pass", scorerVersion: "0.91.0", protocol: { key: "alpha-protokey", version: 1 },
  createdAt: "2026-09-26T12:00:00Z", scoredAt: "2026-09-26T13:00:00Z",
  /** By key, as the route orders them. */
  measures: [
    { key: "alpha-guardrail", guardrail: true, value: 0.03, excluded: false, excludedReason: null },
    { key: "alpha-judged", guardrail: false, value: null, excluded: true, excludedReason: "no qualified answer" },
    { key: "alpha-measurekey", guardrail: false, value: null, excluded: true, excludedReason: null },
  ],
} as const;

/** Seeds `seedEvaluation`'s rows and the additions above. The database must hold no other evaluation. */
async function seedPluginEval(db: pg.ClientBase | pg.Pool): Promise<void> {
  await seedEvaluation(db);
  const one = async (sql: string, args: unknown[]): Promise<string> => (await db.query<{ id: string }>(sql, args)).rows[0].id;

  const member = await one("select id::text as id from zz.principal where email = $1", [MEMBER]);
  const alpha = (await db.query<{ plugin: string; team: string; protocol: string; dimension: string; version: string; run: string }>(`
    select p.id::text as plugin, p.owner_team_id::text as team, pv.id::text as protocol, d.id::text as dimension,
           v.id::text as version, er.id::text as run
      from zz.plugin p
      join zz.eval_protocol_version pv on pv.plugin_id = p.id
      join zz.eval_dimension d on d.protocol_version_id = pv.id
      join zz.plugin_version v on v.plugin_id = p.id and v.version = '1.1.0'
      join zz.eval_observation_snapshot os on os.plugin_version_id = v.id and os.evidence_digest = 'evidence-a2'
      join zz.eval_run er on er.observation_snapshot_id = os.id
     where p.name = $1`, [PLUGINS.scored])).rows[0];

  await db.query("update zz.eval_run set measure_coverage = $2, establishment_blocked_by = '{}' where id = $1",
                 [alpha.run, EXPECTED_RUN.measureCoverage]);
  await db.query(
    `insert into zz.eval_run_dimension (eval_run_id, protocol_version_id, dimension_id, score, coverage)
     values ($1, $2, $3, 0.71, 0.5)`, [alpha.run, alpha.protocol, alpha.dimension]);

  const guardrail = await one(
    `insert into zz.eval_measure (dimension_id, key, evaluator_type, weight, required, definition, protocol_version_id,
                                  fact_key, guardrail_threshold)
     values ($1, 'alpha-guardrail', 'deterministic', 0, true, '{}', $2, 'seeded_fact', 0.1) returning id`,
    [alpha.dimension, alpha.protocol]);
  const evaluator = await one(
    `insert into zz.eval_evaluator_version (version, question, answer_schema, content_digest, stable_key)
     values (1, 'seeded', '{}', 'digest-alpha-judge', 'alpha-judge') returning id`, []);
  const judged = await one(
    `insert into zz.eval_measure (dimension_id, key, evaluator_type, weight, required, definition, protocol_version_id,
                                  evaluator_version_id)
     values ($1, 'alpha-judged', 'bounded_semantic', 0, false, '{}', $2, $3) returning id`,
    [alpha.dimension, alpha.protocol, evaluator]);
  await db.query(
    `insert into zz.eval_evaluator_qualification (state, evidence, qualified_at, measure_id, qualified_by)
     values ('mechanically_qualified', '{}', '2026-09-25T00:00:00Z', $1, $2)`, [judged, member]);
  await db.query(
    `insert into zz.eval_assessment (eval_run_id, measure_id, created_at, subject_kind, value, excluded_reason)
     values ($1, $2, '2026-09-26T12:30:00Z', 'run_level', 0.03, null),
            ($1, $3, '2026-09-26T12:30:00Z', 'run_level', null, 'no qualified answer')`,
    [alpha.run, guardrail, judged]);

  await db.query("insert into zz.plugin_release_owner (plugin_id, team_id) values ($1, $2)", [alpha.plugin, alpha.team]);
  const improvement = await one(
    "insert into zz.improvement_run (eval_run_id, created_at) values ($1, '2026-09-27T00:00:00Z') returning id", [alpha.run]);
  const candidate = await one(
    `insert into zz.candidate (improvement_run_id, base_plugin_version_id, hypothesis, expected_effect, patch_digest,
                               complexity_delta, touched_components, status, created_at, build_result, patch, proposed_by)
     values ($1, $2, 'seeded hypothesis', '{}', 'patch-digest', 1, '["skills/alpha"]', 'valid',
             '2026-09-27T01:00:00Z', '{"ok": true}', 'seeded patch', $3) returning id`,
    [improvement, alpha.version, member]);
  await db.query(
    `insert into zz.release_attempt (candidate_id, status, created_at, reason, plugin_id)
     values ($1, 'refused', '2026-09-28T00:00:00Z', 'seeded refusal', $2)`, [candidate, alpha.plugin]);

  await db.query("insert into zz.plugin (name, origin, owner_team_id) values ($1, 'third_party', $2)",
                 [PLUGINS.neverProfiled, alpha.team]);
}

const NAME = "console-plugin-eval-shape";
const DONE = "console-plugin-eval-shape: a plugin's evaluation is answered scored, never scored, never profiled and " +
  "not registered, and the console's fake answers each in the gateway's shape: ok";
/** COUPLED: the fake answer in the console's checkout, `../zz-stack-dashboard` here and in CI. */
const FAKE = join(root, "..", "zz-stack-dashboard", "scripts", "fake-gateway", "platform.ts");
/** The fake's plugin in each state, as `pluginEval` in that file answers it. */
const FAKE_PLUGINS = { scored: "sdlc", neverScored: "zz-core", neverProfiled: "zz-access", unregistered: "no-such-plugin" } as const;

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

interface Answer { status: number; body: Obj; text: string }

/** The value at a dotted path, `[0]` reading an array's first element. */
const at = (v: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((x, k) => (k.endsWith("[0]") ? (isObj(x) ? (x[k.slice(0, -3)] as unknown[] | undefined)?.[0] : undefined) : isObj(x) ? x[k] : undefined), v);

/** The lists the scored answer's shape is held through; each must hold an element on both sides. */
const HELD_LISTS = ["run.dimensions", "run.dimensions[0].measures", "evaluatorTrust", "findings.defects", "candidates", "releaseOwners"];

const same = (step: string, what: string, got: unknown, want: unknown): void => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(step, `${what} reads ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
};

/** The scored plugin's answer, held to the seed's values. */
function scoredCases(a: Answer): void {
  const step = "the scored plugin";
  if (a.status !== 200 || a.body.found !== true) fail(step, `answered ${a.status}: ${a.text.slice(0, 400)}`);
  const run = a.body.run as Obj;
  if (!isObj(run)) fail(step, `run reads ${JSON.stringify(a.body.run)}`);
  const { measures, ...fields } = EXPECTED_RUN;
  for (const [k, v] of Object.entries(fields)) same(step, `run.${k}`, run[k], v);
  same(step, "run.establishmentBlockedBy", run.establishmentBlockedBy, []);
  same(step, "the measures", ((at(a.body, "run.dimensions[0]") as Obj)?.measures as Obj[] ?? []).map((m) => ({
    key: m.key, guardrail: m.guardrail, value: m.value, excluded: m.excluded, excludedReason: m.excludedReason,
  })), measures);
  same(step, "evaluatorTrust", a.body.evaluatorTrust,
       [{ stableKey: "alpha-judge", state: "mechanically_qualified", qualifiedAt: "2026-09-25T00:00:00Z" }]);
  const owners = a.body.releaseOwners as string[];
  if (!Array.isArray(owners) || owners.length !== 1 || owners[0] !== a.body.ownerTeam) {
    fail(step, `releaseOwners reads ${JSON.stringify(owners)} beside owner team ${JSON.stringify(a.body.ownerTeam)}`);
  }
  const candidates = a.body.candidates as Obj[];
  if (!Array.isArray(candidates) || candidates.length !== 1 || (candidates[0].release as Obj)?.status !== "refused"
      || (candidates[0].build as Obj)?.ok !== true) {
    fail(step, `candidates read ${JSON.stringify(candidates)}`);
  }
  pass("a scored plugin answers its newest scored run, not the newer one never scored, with its score, interval, " +
       "coverage, guardrail status, scorer, protocol and dates; its guardrail a measure flagged in its dimension with " +
       "its assessed value; its evaluator's qualification, its release owner and its candidate with the refused release");
}

async function run(db: pg.Client, url: string): Promise<void> {
  await seedPluginEval(db);
  const cookie = new Map<string, string>();
  for (const email of [MEMBER, SUPERADMIN]) cookie.set(email, await signIn(db, email));

  // `withThrowawayDb` ended the gateway's pool after migrating; a fresh one on the same container.
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const express = (await import("express")).default;
  const dbModule = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { identityMiddleware } = (await load("services/gateway/dist/identity.js")) as { identityMiddleware: () => RequestHandler };
  const { mountPluginEval } = (await load("services/gateway/dist/console/plugin-eval.js")) as
    { mountPluginEval: (app: Express) => void };
  const app = express();
  // COUPLED: services/gateway/src/server.ts — the identity gate before every console route.
  app.use(identityMiddleware());
  mountPluginEval(app);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/console/plugins`;
  const as = async (email: string, plugin: string): Promise<Answer> => {
    const res = await fetch(`${base}/${plugin}/eval`, {
      headers: { cookie: `zz_console=${cookie.get(email)}` }, signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: Obj = {};
    try { const v: unknown = JSON.parse(text); if (isObj(v)) body = v; } catch { /* not JSON: body stays empty */ }
    return { status: res.status, body, text };
  };

  try {
    const answers = {
      scored: await as(SUPERADMIN, PLUGINS.scored),
      neverScored: await as(SUPERADMIN, PLUGINS.neverScored),
      neverProfiled: await as(SUPERADMIN, PLUGINS.neverProfiled),
      unregistered: await as(SUPERADMIN, PLUGINS.unregistered),
    };
    scoredCases(answers.scored);

    let step = "the states before a score";
    const ns = answers.neverScored, np = answers.neverProfiled, nr = answers.unregistered;
    if (ns.status !== 200 || ns.body.run !== null || !isObj(ns.body.subjectVersion)) {
      fail(step, `a plugin with a version and no scored run answered ${ns.status}: ${ns.text.slice(0, 400)}`);
    }
    if (np.status !== 200 || np.body.subjectVersion !== null || np.body.run !== null || np.body.ownershipMode !== "evaluation_only") {
      fail(step, `a plugin registered and never profiled answered ${np.status}: ${np.text.slice(0, 400)}`);
    }
    if (nr.status !== 200) fail(step, `a name nothing registered answered ${nr.status}: ${nr.text.slice(0, 400)}`);
    same(step, "a name nothing registered", nr.body, { plugin: PLUGINS.unregistered, found: false });
    pass("a plugin with a version and no scored run answers run null, one never profiled subjectVersion null, and a " +
         "name nothing registered its name and found false and nothing else");

    step = "the owning team";
    const member = await as(MEMBER, PLUGINS.scored);
    if (member.status !== 200 || JSON.stringify(member.body) !== JSON.stringify(answers.scored.body)) {
      fail(step, `the owning team's member read ${member.status}: ${member.text.slice(0, 300)}`);
    }
    const refused = await as(MEMBER, PLUGINS.unregistered);
    if (refused.status !== 403) fail(step, `the member asking for a name nothing registered answered ${refused.status}`);
    pass("the owning team's member reads the scored plugin as the superadmin does, and is refused 403 on a name nothing registered");

    step = "the shape the console's fake answers";
    let fake: (plugin: string) => unknown;
    try {
      fake = ((await import(pathToFileURL(FAKE).href)) as { pluginEval: (plugin: string) => unknown }).pluginEval;
    } catch (err) {
      fail(step, `could not read the console's fake answer at ${FAKE}: ${(err as Error).message}`);
    }
    if (typeof fake !== "function") fail(step, `${FAKE} exports no pluginEval function`);
    const fakes = Object.fromEntries(Object.entries(FAKE_PLUGINS).map(([k, p]) => [k, fake(p)])) as Record<keyof typeof answers, unknown>;
    const empty = HELD_LISTS.flatMap((path) => [
      ...((at(answers.scored.body, path) as unknown[] | undefined)?.length ? [] : [`the gateway's ${path}`]),
      ...((at(fakes.scored, path) as unknown[] | undefined)?.length ? [] : [`the fake's ${path}`]),
    ]);
    if (empty.length) fail(step, `${empty.join(", ")} holds nothing, so its shape would pass unread`);
    const diffs = (Object.keys(answers) as (keyof typeof answers)[]).flatMap((state) =>
      shapeDiffs(answers[state].body, fakes[state], "", []).map((d) => `${state} (${FAKE_PLUGINS[state]}): ${d}`));
    if (diffs.length) fail(step, diffs.join("; "));
    pass("each state's answer agrees in shape with the console's fake one, key set by key set, through every list of the scored run");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await dbModule.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
    delete process.env.ZZ_CATALOG_DIR;
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
