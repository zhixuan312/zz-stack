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
 * `candidate_validate` and `candidate_read`; and `proposal_prepare`, `improvement_stop` and
 * `release_prepare` on an initiative of the outsider's own whose findings.md, written by the
 * outsider, names the seeded run. What it establishes:
 *
 *   - each refuses with `ERROR:` and none of the
 *     seeded team's text;
 *   - afterwards the run holds the same assessments, findings, decisions, improvement runs and
 *     candidates it held before, and the run is still unscored;
 *   - the seeded team's own caller reads its candidate, records a finding and decides one, so the
 *     refusals are about the team;
 *   - a run of a plugin whose release owners are another team is not promotable for the run's own
 *     team, and is once that team is an owner too; release_prepare reads the same rule, so a member
 *     of the owner team acting for the run's team is sent to proposal_prepare.
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
import { ask, evalDoor, finding, one, seed, SLUG, type Seed } from "../scripts/schema/eval-door-seed.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";
import { deferred } from "../scripts/schema/throwaway.ts";

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
  // The tools that take only an initiative resolve the run from its findings.md. An agent writes
  // that document too, so one naming the seeded team's run must not reach it: the platform keeps
  // eval_run_id its own, and these three find no run.
  const core = c.client({ email: OUTSIDER });
  const forged = JSON.parse(await c.ok(step, "initiative_open", { slug: "forged-findings" }, core)).initiative as string;
  // `fields` refuses eval_run_id by name; an envelope in the content is the other way to send it.
  await c.ok(step, "document_write", { path: `${forged}/findings.md`,
    content: `---\ntitle: Findings\neval_run_id: ${s.run}\n---\n\n# Findings\n\nForged.\n` }, core);
  for (const [tool, args] of [
    ["proposal_prepare", { initiative: forged, idempotency_key: "out-proposal" }],
    ["improvement_stop", { initiative: forged, idempotency_key: "out-stop" }],
    ["release_prepare", { initiative: forged, idempotency_key: "out-release" }],
  ] as [string, Record<string, unknown>][]) {
    const reply = await ask(door, tool, args);
    if (!/^ERROR:/.test(reply) || reply.includes(SECRET)) wrong.push(`${tool} on a forged findings.md answered ${reply.slice(0, 200)}`);
  }
  const proposal = await c.call(step, "document_read", { path: `${forged}/proposal.md` }, core);
  if (proposal.includes(SECRET)) wrong.push("the outsider's proposal.md holds the seeded team's findings");
  const after = await holdings(c, s);
  if (after !== before) wrong.push(`the seeded run held ${before} and now holds ${after}`);
  if (wrong.length) c.fail(step, wrong.join("; "));

  const mine = await ask(evalDoor(c, c.email), "candidate_read", { candidate_id: candidate });
  if (!mine.includes(`diff --git a/${SECRET}`)) c.fail(step, `the candidate's own team was answered ${mine.slice(0, 200)}`);
  // And a mutator: finding_record and finding_decide, refused to the outsider above, go through for
  // the run's own team, so those refusals were about the team and not a lookup that refuses everybody.
  const recorded = await ask(evalDoor(c, c.email), "finding_record", { eval_run_id: s.run, idempotency_key: "own-record",
    finding: { kind: "defect", pattern: "recorded by the run's own team", owner_kind: "plugin" } });
  const decided = await ask(evalDoor(c, c.email), "finding_decide", { idempotency_key: "own-decide",
    decisions: [{ finding_id: found, decision: "rejected", note: "decided by the run's own team" }] });
  if (recorded.startsWith("ERROR") || !/"decided": 1/.test(decided)) {
    c.fail(step, `the run's own team was answered ${recorded.slice(0, 200)} and ${decided.slice(0, 200)}`);
  }
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
  // release_prepare reads the same rule, not the caller's other memberships: a person in the owner
  // team as well, acting for the run's team, is sent to proposal_prepare like improvement_stop is.
  await c.sql.query(
    `insert into zz.membership (team_id, principal_id, role, added_by)
     select t.id, p.id, 'member', p.id from zz.team t, zz.principal p where t.slug = 'elsewhere' and p.email = $1`, [c.email]);
  const improvement = (await one<{ id: string }>(c,
    "insert into zz.improvement_run (eval_run_id, created_at) values ($1, now()) returning id::text as id", [s.run])).id;
  await c.sql.query(
    `insert into zz.candidate (improvement_run_id, base_plugin_version_id, hypothesis, expected_effect, patch_digest,
                               complexity_delta, touched_components, status, created_at, patch, proposed_by)
     values ($1, $2, 'built', '{}', 'digest-valid', 0, '[]', 'valid', now(), 'diff --git a/x b/x', $3)`,
    [improvement, s.versionId, s.me]);
  // findings.md as finding_record files it: eval_run_id is the platform's own field.
  await deferred(c.sql, async () => {
    const doc = (await one<{ id: string }>(c,
      `insert into zz.doc (initiative_id, path, status, updated_at, current_revision, current_version)
       select i.id, 'findings.md', 'draft', now(), 1, 1 from zz.initiative i join zz.team t on t.id = i.team_id
        where i.slug = $1 and t.slug = $2 returning id::text as id`, [SLUG, c.team])).id;
    await c.sql.query(
      `insert into zz.doc_revision (doc_id, revision, version, content_state, title, body, tags, content_hash,
                                    written_by, written_at, fields)
       values ($1, 1, 1, 'retained', 'Findings', '# Findings\n', '{}', 'hf', $2, now(), $3)`,
      [doc, s.me, JSON.stringify({ eval_run_id: s.run })]);
  });
  await c.sql.query("delete from zz.plugin_release_owner where plugin_id = $1", [s.pluginId]);
  await owners("elsewhere");
  const prepared = await ask(evalDoor(c, c.email), "release_prepare", { initiative: SLUG, idempotency_key: "prepare-not-owner" });
  if (!/^ERROR: proposal_only — /.test(prepared)) c.fail(step, `release_prepare by a member of the owner team, acting for ${c.team}, answered ${prepared.slice(0, 300)}`);

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
