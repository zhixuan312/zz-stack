#!/usr/bin/env node
/**
 * checks/eval-door-team.ts — an evaluation is its team's: another team's caller holding one of its ids
 * reads nothing of it and changes nothing in it.
 *
 *   node checks/eval-door-team.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), seeds one team's
 * evaluation run (`scripts/schema/eval-door-seed.ts`) with a finding, an improvement run and a
 * candidate, and makes a person who is admin of another team. As that person, every tool that takes
 * the id of a run or of what hangs off one is called with the seeded team's ids, well-formed so that
 * no input schema refuses first: `evaluation_assess`, `evaluation_score`, `finding_record`,
 * `finding_decide`, `improvement_start` (opening a run, and with `skip`), `candidate_record`,
 * `candidate_validate` and `candidate_read`. What it establishes:
 *
 *   - each refuses with `ERROR:` and none of the
 *     seeded team's text;
 *   - afterwards the run holds the same assessments, findings, decisions, improvement runs and
 *     candidates it held before, and the run is still unscored;
 *   - the seeded team's own caller reads its candidate, so the refusal is about the team;
 *   - a run of a plugin whose release owners are another team is not promotable for the run's own
 *     team, and is once that team is an owner too.
 *
 * The only database this touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { root } from "../scripts/deployment.ts";
import { ask, evalDoor, finding, one, seed, type Seed } from "../scripts/schema/eval-door-seed.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "eval-door-team";
const DONE = "eval-door-team: another team's caller holding an evaluation's ids reads nothing of it and changes nothing in it: ok";

const OUTSIDER = "outsider@example.test";
/** In the seeded team's rows, so an answer that carries it carried their text. */
const SECRET = "SEEDED-TEAM-ONLY";

/** What the seeded run holds, as one comparable string. */
async function holdings(c: Core, s: Seed): Promise<string> {
  return JSON.stringify(await one(c, `
    select (select count(*)::int from zz.eval_assessment where eval_run_id = $1) as assessments,
           (select count(*)::int from zz.eval_finding where eval_run_id = $1) as findings,
           (select count(*)::int from zz.eval_finding where eval_run_id = $1 and decision <> 'deferred') as decided,
           (select count(*)::int from zz.improvement_run where eval_run_id = $1) as improvements,
           (select count(*)::int from zz.candidate c join zz.improvement_run i on i.id = c.improvement_run_id
             where i.eval_run_id = $1) as candidates,
           (select score_status from zz.eval_run where id = $1) as scored`, [s.run]));
}

async function outsiderChangesNothing(c: Core, s: Seed): Promise<void> {
  const step = "another team's caller is refused every evaluation id it does not own";
  const found = await finding(c, s, `${SECRET} defect`);
  const improvement = (await one<{ id: string }>(c,
    "insert into zz.improvement_run (eval_run_id, created_at) values ($1, now()) returning id::text as id", [s.run])).id;
  const candidate = (await one<{ id: string }>(c,
    `insert into zz.candidate (improvement_run_id, base_plugin_version_id, hypothesis, expected_effect, patch_digest,
                               complexity_delta, touched_components, status, created_at, patch, proposed_by)
     values ($1, $2, 'check', '{}', 'digest-candidate', 0, '[]', 'recorded', now(), $3, $4)
     returning id::text as id`, [improvement, s.versionId, `diff --git a/${SECRET} b/${SECRET}`, s.me])).id;
  await c.sql.query(
    `with p as (insert into zz.principal (email, display_name) values ($1, 'Outsider') returning id),
          t as (insert into zz.team (slug, name, created_by) select 'elsewhere', 'Elsewhere', id from p returning id)
     insert into zz.membership (team_id, principal_id, role, added_by) select t.id, p.id, 'admin', p.id from t, p`, [OUTSIDER]);

  const before = await holdings(c, s);
  const door = evalDoor(c, OUTSIDER);
  const calls: [string, Record<string, unknown>][] = [
    ["evaluation_assess", { eval_run_id: s.run, subject_refs: [], idempotency_key: "out-assess" }],
    ["evaluation_score", { eval_run_id: s.run, idempotency_key: "out-score" }],
    ["finding_record", { eval_run_id: s.run, idempotency_key: "out-record",
      finding: { kind: "defect", pattern: "planted by another team", owner_kind: "plugin" } }],
    ["finding_decide", { idempotency_key: "out-decide",
      decisions: [{ finding_id: found, decision: "rejected", note: "closed by another team" }] }],
    ["improvement_start", { eval_run_id: s.run, finding_ids: [found], idempotency_key: "out-start" }],
    ["improvement_start", { eval_run_id: s.run, skip: true, idempotency_key: "out-skip" }],
    ["candidate_record", { improvement_run_id: improvement, base_subject_version_id: s.versionId,
      hypothesis: "planted", expected_effect: {}, patchset: { diff: "diff --git a/x b/x" }, idempotency_key: "out-candidate" }],
    ["candidate_validate", { candidate_id: candidate, idempotency_key: "out-validate" }],
    ["candidate_read", { candidate_id: candidate }],
  ];
  const wrong: string[] = [];
  for (const [tool, args] of calls) {
    const reply = await ask(door, tool, args);
    if (!/^ERROR:/.test(reply) || reply.includes(SECRET)) wrong.push(`${tool} answered ${reply.slice(0, 200)}`);
  }
  const after = await holdings(c, s);
  if (after !== before) wrong.push(`the seeded run held ${before} and now holds ${after}`);
  if (wrong.length) c.fail(step, wrong.join("; "));

  const mine = await ask(evalDoor(c, c.email), "candidate_read", { candidate_id: candidate });
  if (!mine.includes(`diff --git a/${SECRET}`)) c.fail(step, `the candidate's own team was answered ${mine.slice(0, 200)}`);
  c.pass(step);
}

/** A plugin another team owns is a proposal for this one: its improvement can neither be prepared
 *  nor applied as a release by a team outside its release owners, so improvement_start,
 *  proposal_prepare, improvement_stop and findings.md all read the run's own team against the
 *  owners (`promotable`) rather than whether the plugin has an owner at all (runtime pass 2, F7 — an
 *  outsider was routed to release, refused there, and refused a proposal). */
async function anotherTeamsPluginIsAProposal(c: Core, s: Seed): Promise<void> {
  const step = "an evaluation of a plugin another team owns";
  const { pool } = await c.inProcess();
  const { loadSubjectForEvalRun } = await import(
    pathToFileURL(join(root, "services/zz-core/dist/eval/proposal-doc.js")).href);
  const owners = (team: string) => c.sql.query(
    `insert into zz.plugin_release_owner (plugin_id, team_id) select $1, id from zz.team where slug = $2`,
    [s.pluginId, team]);
  await c.sql.query("delete from zz.plugin_release_owner where plugin_id = $1", [s.pluginId]);
  await owners("elsewhere");
  const outside = await loadSubjectForEvalRun(pool, s.run) as { promotable: boolean; run_team: string };
  if (outside.promotable !== false || outside.run_team !== c.team) {
    c.fail(step, `owned by elsewhere, ${c.team}'s run read as ${JSON.stringify(outside)}`);
  }
  await owners(c.team);
  const inside = await loadSubjectForEvalRun(pool, s.run) as { promotable: boolean };
  if (inside.promotable !== true) c.fail(step, `with ${c.team} an owner too, the run read as ${JSON.stringify(inside)}`);
  c.pass(step);
}

process.exitCode = await withThrowawayCore(NAME, DONE, async (c) => {
  const s = await seed(c);
  await outsiderChangesNothing(c, s);
  await anotherTeamsPluginIsAProposal(c, s);
});
