/**
 * Stages 7–8 of zz-plugin-eval — IMPROVE and PROMOTE/VERIFY — each in a conversation of its own,
 * with the shell steps their skills name run for real: the candidate's build through
 * `npm run candidate-build`, the release through `zz-tool release-apply`, the rollback through
 * `zz-tool release-rollback`. No replay: the released version is judged on the real use the walk
 * seeds after deploying it.
 *
 * The same rule as walk.ts: every id comes from the operator, from a call this stage made, or
 * from the initiative (`initiative_status`, `findings.md`, `improvement.md`).
 */
import { Conversation, str, type Reply } from "./doors.ts";
import { candidatePatch, releaseClone, releaseCommands, runCli, tagCommit, WORDING } from "./release.ts";
import { seedUsage } from "./seed.ts";
import { deployRelease, restartGateway, type Stack } from "./stack.ts";
import { enter, type Walk } from "./walk.ts";

/** A frontmatter field of a document read back through `document_read`. */
async function field(c: Conversation, path: string, name: string): Promise<{ value: string; body: string }> {
  const r = await c.call("core", "document_read", { path });
  const body = String(r.text ?? r.content ?? JSON.stringify(r));
  const m = new RegExp(`^${name}:\\s*"?([^"\\n]+)"?\\s*$`, "m").exec(body);
  if (!m) throw new Error(`${path} carries no ${name}: ${body.slice(0, 400)}`);
  return { value: m[1].trim(), body };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export async function improve(w: Walk, stack: Stack): Promise<{ candidate: string; build: string }> {
  const { c } = await enter(w, "zz-plugin-improve", { action: "resolve_branch" });
  const findings = await field(c, `${w.initiative}/findings.md`, "eval_run_id");
  const evalRun = findings.value;
  // Each finding's id sits beside it in findings.md; the defect is the one under ## Defects.
  const defects = findings.body.slice(findings.body.indexOf("## Defects"), findings.body.indexOf("## Unknowns"));
  const defectIds = [...new Set(defects.match(UUID) ?? [])];
  if (defectIds.length !== 1) throw new Error(`findings.md ## Defects names ${defectIds.length} finding ids: ${defects.slice(0, 400)}`);
  const started = await c.call("eval", "improvement_start",
    { eval_run_id: evalRun, finding_ids: defectIds, initiative: w.initiative, idempotency_key: c.key("improve") },
    { note: (r) => `improvement_run ${String(r.improvement_run_id)} mode ${JSON.stringify((r.facts as Reply | undefined)?.improvement_mode ?? null)}` });
  const run = str(started, "improvement_run_id", "improvement_start");
  const base = str(started, "base_subject_version_id", "improvement_start");

  const rec = await c.call("eval", "candidate_record", {
    improvement_run_id: run, base_subject_version_id: base,
    hypothesis: `zz-platform saying "${WORDING}" raises refusal_recovery_path`,
    expected_effect: { measure: "refusal_recovery_path", direction: "up" },
    patchset: { diff: candidatePatch(stack) }, idempotency_key: c.key("candidate"),
  }, { note: (r) => `candidate ${String(r.candidate_id)} patch ${String(r.patch_digest).slice(0, 12)}` });
  const candidate = str(rec, "candidate_id", "candidate_record");

  // The platform never builds a candidate: candidate_validate asks, the command it prints builds
  // and gates it here, and the next call consumes what that command recorded.
  let validated: Reply = {};
  for (let round = 0; round < 3; round += 1) {
    validated = await c.call("eval", "candidate_validate", { candidate_id: candidate, idempotency_key: c.key("validate") },
      { note: (r) => `status ${String(r.status)} releasable ${String(r.releasable)}` });
    if (validated.status === "valid") break;
    if (validated.status !== "awaiting_build") throw new Error(`candidate_validate answered neither a build nor valid: ${JSON.stringify(validated).slice(0, 600)}`);
    const built = await runCli(stack, "candidate-build", ["--candidate", candidate, "--repo", stack.seed]);
    c.note("npm run candidate-build", `exit ${built.code}: ${built.out.trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? ""}`);
    if (built.code !== 0) throw new Error(`npm run candidate-build exited ${built.code}:\n${built.out.slice(-3000)}`);
  }
  if (validated.status !== "valid" || validated.releasable !== true) {
    throw new Error(`the candidate never became releasable: ${JSON.stringify(validated).slice(0, 600)}`);
  }
  // IMPROVE ends by handing the releasable candidate to promotion.
  await c.call("eval", "release_prepare", { initiative: w.initiative, idempotency_key: c.key("prepare") },
    { note: (r) => `release_attempt ${String(r.release_attempt_id)} owners ${JSON.stringify(r.required_owners)} document ${String(r.document)}` });
  return { candidate, build: JSON.stringify(validated.build ?? null).slice(0, 80) };
}

/** release_verify, from a conversation that knows nothing but the initiative. */
async function verify(w: Walk, label: string): Promise<{ c: Conversation; v: Reply; attempt: string }> {
  const c = new Conversation(w.url, w.pat, `zz-plugin-promote-verify (${label})`);
  const attempt = (await field(c, `${w.initiative}/improvement.md`, "release_attempt_id")).value.replace(/`/g, "");
  const v = await c.call("eval", "release_verify", { release_attempt_id: attempt, idempotency_key: c.key("verify") },
    { note: (r) => `verdict ${String(r.verdict)} reason ${String(r.reason)} runs_needed ${String(r.runs_needed ?? "—")}` });
  return { c, v, attempt };
}

export async function promoteVerify(w: Walk, stack: Stack, tag: string): Promise<{ released: string; verdict: string; reason: string; runs: number }> {
  const { c } = await enter(w, "zz-plugin-promote-verify", { action: "await_approval", document: "improvement.md" });
  const path = `${w.initiative}/improvement.md`;
  // The attempt and the candidate are the document's own frontmatter; the digest is quoted in
  // its ## Patch section — the three things release_apply and the CLI take.
  const doc = await field(c, path, "candidate_id");
  const candidateId = doc.value.replace(/`/g, "");
  const attemptId = (await field(c, path, "release_attempt_id")).value.replace(/`/g, "");
  const digest = /Patch digest: `([0-9a-f]{64})`/.exec(doc.body)?.[1];
  if (!digest || !attemptId || !candidateId) {
    throw new Error(`improvement.md does not carry the candidate, attempt and digest a fresh PROMOTE needs: ${doc.body.slice(0, 800)}`);
  }
  await c.call("core", "document_present", { path });
  await c.call("core", "document_approve", { path });
  const cmds = releaseCommands(stack);
  const clone = releaseClone(stack);
  const baseTag = `v${stack.version}`;
  const applied = await runCli(stack, "release-apply", ["--candidate", candidateId, "--repo", clone, "--initiative", w.initiative,
    "--digest", digest, "--release-cmd", cmds.release, "--release-version", cmds.version, "--release-tag", `v${cmds.version}`,
    "--base-ref", tagCommit(stack, baseTag), "--base-tag", baseTag, "--gateway", stack.url]);
  c.note("zz-tool release-apply", `exit ${applied.code}: ${applied.out.trim().split("\n").slice(-2).join(" | ").slice(0, 200)}`);
  if (applied.code !== 0) throw new Error(`zz-tool release-apply exited ${applied.code}:\n${applied.out.slice(-3000)}`);

  // Released, not yet used: release_verify waits for real use rather than deciding on none.
  const waiting = await c.call("eval", "release_verify", { release_attempt_id: attemptId, idempotency_key: c.key("verify") },
    { note: (r) => `verdict ${String(r.verdict)} reason ${String(r.reason)} runs_needed ${String(r.runs_needed ?? "—")}` });
  if (waiting.verdict !== null || waiting.reason !== "awaiting_post_release_runs") {
    throw new Error(`release_verify decided before the released version was used at all: ${JSON.stringify(waiting).slice(0, 600)}`);
  }

  // The operator deploys the release, and people use it — days, in real life; minutes here.
  await deployRelease(stack, cmds.version);
  const after = await seedUsage(stack.url, stack.pat, tag, "after");
  await restartGateway(stack);   // reconcileRuns turns the event log into runs at boot
  c.note("deploy + real use", `zz-core ${cmds.version} deployed, ${after.length} initiatives of use seeded`);

  // A later conversation: enough real runs now, and nobody has evaluated them.
  const asked = await verify(w, "after use");
  if (asked.v.reason !== "awaiting_evaluation") {
    throw new Error(`release_verify did not ask for an evaluation of the released version's real use: ${JSON.stringify(asked.v).slice(0, 600)}`);
  }
  const req = asked.v.evaluation_required as Reply | undefined;
  if (!req) throw new Error(`release_verify asked for an evaluation and named none: ${JSON.stringify(asked.v).slice(0, 400)}`);
  const subject = str(req, "subject_version_id", "release_verify.evaluation_required");
  const protocol = str(req, "protocol_version_id", "release_verify.evaluation_required");
  // Exactly the four EVALUATE calls the skill names, with the arguments release_verify handed
  // back and no `initiative` on any of them.
  const e = asked.c;
  const profiled = await e.call("eval", "plugin_profile", {
    subject_version_id: subject, evidence_window: req.evidence_window, idempotency_key: e.key("profile"),
  }, { note: (r) => `snapshot ${String(r.observation_snapshot_id)} runs ${String(r.total_run_count)} usable ${String(r.usable_run_count)}` });
  const started = await e.call("eval", "evaluation_start", {
    subject_version_id: subject, protocol_version_id: protocol,
    observation_snapshot_id: str(profiled, "observation_snapshot_id", "plugin_profile"), idempotency_key: e.key("start"),
  }, { note: (r) => `eval_run ${String(r.eval_run_id)}` });
  const evalRun = str(started, "eval_run_id", "evaluation_start");
  const listed = await e.call("core", "document_list", {});
  const refs = (String(listed.text ?? JSON.stringify(listed)).match(/\d{4}-\d{2}-\d{2}-[a-z0-9-]+-after-\d+\/spec\.md/g) ?? []).slice(0, 6);
  if (refs.length < 5) throw new Error(`document_list named ${refs.length} post-release spec.md documents to judge`);
  await e.call("eval", "evaluation_assess", { eval_run_id: evalRun, subject_refs: refs, idempotency_key: e.key("assess") },
    { note: (r) => `${String(r.assessment_count)} assessments over ${refs.length} refs` });
  await e.call("eval", "evaluation_score", { eval_run_id: evalRun, idempotency_key: e.key("score") },
    { note: (r) => `overall ${String(r.overall_score)} status ${String(r.score_status)} guardrails ${String(r.guardrail_status)} blocked by ${JSON.stringify(r.establishment_blocked_by)}` });

  const decided = await verify(w, "decide");
  const verdict = String(decided.v.verdict ?? "");
  const evidence = (decided.v.evidence ?? {}) as Reply;
  if (verdict !== "rolled_back") {
    throw new Error(`release_verify answered ${verdict || "nothing"}; the stub regresses the released version so the rollback runs: ${JSON.stringify(decided.v).slice(0, 600)}`);
  }
  const rolled = await runCli(stack, "release-rollback", ["--release-attempt", decided.attempt, "--repo", clone,
    "--rollback-cmd", cmds.rollback, "--gateway", stack.url]);
  decided.c.note("zz-tool release-rollback", `exit ${rolled.code}: ${rolled.out.trim().split("\n").slice(-2).join(" | ").slice(0, 200)}`);
  if (rolled.code !== 0) throw new Error(`zz-tool release-rollback exited ${rolled.code}:\n${rolled.out.slice(-3000)}`);
  const closed = await decided.c.call("core", "initiative_close", { initiative: w.initiative, disposition: "finished",
    no_signoff_reason: "the release was rolled back on its own verification; the evaluation itself is finished" },
    { note: (r) => String(r.text ?? JSON.stringify(r)).slice(0, 160) });
  const status = await decided.c.call("core", "initiative_status", { initiative: w.initiative },
    { note: (r) => `next_move ${JSON.stringify(r.next_move)}` });
  const next = status.next_move as Reply | undefined;
  if (next?.action !== "closed") throw new Error(`after the close initiative_status says ${JSON.stringify(next)}: ${JSON.stringify(closed).slice(0, 300)}`);
  return { released: cmds.version, verdict, reason: String(decided.v.reason), runs: Number(evidence.post_release_runs ?? 0) };
}
