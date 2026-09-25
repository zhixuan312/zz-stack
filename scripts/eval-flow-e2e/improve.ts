/**
 * Stages 7–8 of zz-plugin-eval — IMPROVE and PROMOTE/VERIFY — each in a conversation of its own,
 * with the shell steps their skills name run for real: every replay through `npm run replay`,
 * the release through `zz-tool release-apply`, the rollback through `zz-tool release-rollback`.
 *
 * The same rule as walk.ts: every id comes from the operator, from a call this stage made, or
 * from the initiative (`initiative_status`, `findings.md`, `improvement.md`).
 */
import { Conversation, obj, str, type Reply } from "./doors.ts";
import { launch, standIn } from "./replay.ts";
import { candidatePatch, releaseClone, releaseCommands, runCli, tagCommit, WORDINGS } from "./release.ts";
import type { Stack } from "./stack.ts";
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

/** Runs the replays a `runs_required` asks for. A validation entry names its case and gets ONE
 *  `replay_start` with `repeats` set to its `count`, exactly as IMPROVE's skill words it — the
 *  next `candidate_validate` asks again for whatever is still short. A proof-shaped entry (no
 *  case: the skill says run them one at a time) gets one run per count. */
async function runRequired(c: Conversation, stack: Stack, bin: string, entries: Reply[], split: string,
  context: string, verifierToken?: string, repo: string = stack.seed): Promise<number> {
  let n = 0;
  for (const e of entries) {
    const count = Number(e.count ?? 1);
    for (let i = 0; i < (e.case_id ? 1 : count); i += 1) {
      const args: Record<string, unknown> = { case_set_id: e.case_set_id, split, repeats: count, context, idempotency_key: c.key("start") };
      if (e.case_id) args.case_id = e.case_id;
      if (e.candidate_id) args.candidate_id = e.candidate_id; else args.subject_version_id = e.subject_version_id;
      if (verifierToken) args.verifier_token = verifierToken;
      const started = await c.call("eval", "replay_start", args);
      const run = { replay_run_id: str(started, "replay_run_id", "replay_start"), token: str(started, "token", "replay_start") };
      const launched = await launch(stack, bin, run, verifierToken, repo);
      if (launched.status !== "completed") throw new Error(`replay ${run.replay_run_id} ${launched.status}: ${launched.out.slice(-1500)}`);
      n += 1;
    }
  }
  return n;
}

/** A proof-shaped `runs_required` — COUNTS per side, never case ids — expanded to entries. */
function proofEntries(req: Reply, baseline: string, candidate: { candidate_id?: string; subject_version_id?: string }): Reply[] {
  return [
    { case_set_id: req.case_set_id, subject_version_id: baseline, count: Number(req.baseline ?? 0) },
    { case_set_id: req.case_set_id, ...candidate, count: Number(req.candidate ?? 0) },
  ].filter((e) => e.count > 0);
}

export async function improve(w: Walk, stack: Stack): Promise<{ candidate: string; replays: number; proof: string }> {
  const { c } = await enter(w, "zz-plugin-improve", { action: "resolve_branch" });
  const findings = await field(c, `${w.initiative}/findings.md`, "eval_run_id");
  const evalRun = findings.value;
  // Each finding's id sits beside it in findings.md; the defect is the one under ## Defects.
  const defects = findings.body.slice(findings.body.indexOf("## Defects"), findings.body.indexOf("## Unknowns"));
  const defectIds = [...new Set(defects.match(UUID) ?? [])];
  if (defectIds.length !== 1) throw new Error(`findings.md ## Defects names ${defectIds.length} finding ids: ${defects.slice(0, 400)}`);
  const started = await c.call("eval", "improvement_start",
    { eval_run_id: evalRun, finding_ids: defectIds, initiative: w.initiative, idempotency_key: c.key("improve") },
    { note: (r) => `improvement_run ${String(r.improvement_run_id)} case_set ${String(r.case_set_id)} mode ${JSON.stringify((r.facts as Reply | undefined)?.improvement_mode ?? null)}` });
  const run = str(started, "improvement_run_id", "improvement_start");
  const base = str(started, "base_subject_version_id", "improvement_start");
  const bin = standIn(stack);
  let replays = 0;
  /** Record one candidate and validate it to a verdict: build it where build_required says, run
   *  the replays runs_required names, and ask again. */
  const propose = async (k: number): Promise<string> => {
    const rec = await c.call("eval", "candidate_record", {
      improvement_run_id: run, base_subject_version_id: base, parents: [],
      hypothesis: `zz-platform saying "${WORDINGS[k]}" raises refusal_recovery_path`,
      expected_effect: { measure: "refusal_recovery_path", direction: "up" },
      patchset: { diff: candidatePatch(stack, k) }, idempotency_key: c.key("candidate"),
    }, { note: (r) => `candidate ${String(r.candidate_id)} patch ${String(r.patch_digest).slice(0, 12)} generation ${String(r.generation)}` });
    const candidate = str(rec, "candidate_id", "candidate_record");
    for (let round = 0; ; round += 1) {
      const v = await c.call("eval", "candidate_validate", { candidate_id: candidate, idempotency_key: c.key("validate") },
        { note: (r) => `status ${String(r.status)} verdict ${String(r.verdict)} runs_required ${Array.isArray(r.runs_required) ? r.runs_required.length : 0}` });
      if (v.verdict) { if (v.verdict !== "improves") throw new Error(`validation verdict ${String(v.verdict)}`); return candidate; }
      if (v.status === "awaiting_build") {
        // The platform never builds a candidate: the command build_required prints does, here.
        const built = await runCli(stack, "candidate-build", ["--candidate", candidate, "--repo", stack.seed]);
        c.note("npm run candidate-build", `exit ${built.code}: ${built.out.trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? ""}`);
        if (built.code !== 0) throw new Error(`npm run candidate-build exited ${built.code}:\n${built.out.slice(-3000)}`);
        continue;
      }
      const req = Array.isArray(v.runs_required) ? v.runs_required as Reply[] : [];
      if (!req.length || round > 12) throw new Error(`candidate_validate neither decided nor asked for runs: ${JSON.stringify(v).slice(0, 600)}`);
      replays += await runRequired(c, stack, bin, req, "validation", "search");
    }
  };
  const proposed = [await propose(0)];
  // `next` decides whether to propose more, never a sense of "enough": the search selects only
  // at the protocol's own liveness bound.
  let selected = "";
  for (let i = 0; !selected; i += 1) {
    const s = await c.call("eval", "candidate_search", { improvement_run_id: run, idempotency_key: c.key("search"), initiative: w.initiative },
      { note: (r) => `status ${String(r.status)} selected ${String(r.selected_id)} budget ${String(r.edit_budget)} next ${String(r.next).slice(0, 90)}` });
    if (typeof s.selected_id === "string" && s.selected_id) { selected = s.selected_id; break; }
    if (s.status === "closed") throw new Error(`the search closed with nothing selected: ${JSON.stringify(s).slice(0, 600)}`);
    if (Number(s.edit_budget ?? 0) < 1 || i >= WORDINGS.length - 1) throw new Error(`the search asks for no candidate and selected none: ${JSON.stringify(s).slice(0, 600)}`);
    proposed.push(await propose(proposed.length));
  }
  if (!proposed.includes(selected)) throw new Error(`candidate_search selected ${selected}, which this search never recorded`);
  const candidate = selected;
  // The first call mints the verifier token; a later one reads back what the proof runs showed,
  // or asks for more (with the same token, which this conversation holds).
  let token = "";
  let proved: Reply = {};
  for (let round = 0; round < 6; round += 1) {
    proved = await c.call("eval", "candidate_prove", { candidate_id: candidate, idempotency_key: c.key("prove"), initiative: w.initiative },
      { note: (r) => `status ${String(r.status)} proof ${String(r.proof_status)} release_eligible ${String(r.release_eligible)} runs_required ${JSON.stringify(r.runs_required ?? null)}` });
    if (proved.proof_status) break;
    if (typeof proved.verifier_token === "string" && proved.verifier_token) token = proved.verifier_token;
    if (!token) throw new Error(`candidate_prove asked for runs and never handed this conversation a verifier_token: ${JSON.stringify(proved).slice(0, 400)}`);
    replays += await runRequired(c, stack, bin, proofEntries(obj(proved, "runs_required", "candidate_prove"), base, { candidate_id: candidate }),
      "proof", "verifier", token);
  }
  if (proved.proof_status !== "proof_passed" || proved.release_eligible !== true) {
    throw new Error(`candidate_prove: ${JSON.stringify(proved).slice(0, 600)}`);
  }
  // IMPROVE ends by handing the proved candidate to promotion.
  await c.call("eval", "release_prepare", { initiative: w.initiative, idempotency_key: c.key("prepare") },
    { note: (r) => `release_attempt ${String(r.release_attempt_id)} owners ${JSON.stringify(r.required_owners)} document ${String(r.document)}` });
  return { candidate, replays, proof: String(proved.proof_status) };
}

export async function promoteVerify(w: Walk, stack: Stack): Promise<{ released: string; verdict: string; replays: number }> {
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
  const bin = standIn(stack);
  let replays = 0;
  let verdict = "";
  // Minted by the first call only; every later one answers token_already_issued with null, so
  // the conversation that holds it keeps it for the escalation rounds.
  let verifierToken = "";
  let conv = c;
  for (let round = 0; round < 6 && !verdict; round += 1) {
    const v = await conv.call("eval", "release_verify", { release_attempt_id: attemptId, idempotency_key: conv.key("verify"), initiative: w.initiative },
      { note: (r) => `verdict ${String(r.verdict)} reason ${String(r.reason)} runs_required ${JSON.stringify(r.runs_required ?? null)}` });
    if (typeof v.verdict === "string" && v.verdict) { verdict = v.verdict; break; }
    const req = obj(v, "runs_required", "release_verify");
    if (typeof v.verifier_token === "string" && v.verifier_token) verifierToken = v.verifier_token;
    if (!verifierToken) throw new Error(`release_verify asked for runs and no call has handed this conversation a verifier_token: ${JSON.stringify(v).slice(0, 400)}`);
    const sides = [
      { case_set_id: req.case_set_id, subject_version_id: str(v, "prior_subject_version_id", "release_verify"), count: Number(req.baseline ?? 0) },
      { case_set_id: req.case_set_id, subject_version_id: str(v, "released_subject_version_id", "release_verify"), count: Number(req.candidate ?? 0) },
    ].filter((e) => e.count > 0);
    if (round === 0) {
      // The conversation holding the first token ends before running anything: one released-side
      // run failing a guardrail already rolls back, so a run here would leave nothing to resume.
      // A fresh conversation finds the attempt in improvement.md, rotates the token, and finds the
      // dropped one refused.
      const dropped = verifierToken;
      conv = new Conversation(w.url, w.pat, "zz-plugin-promote-verify (resumed)");
      const resumedAttempt = (await field(conv, path, "release_attempt_id")).value.replace(/`/g, "");
      const r = await conv.call("eval", "release_verify", { release_attempt_id: resumedAttempt, idempotency_key: conv.key("verify"),
        initiative: w.initiative, rotate_token: true },
      { note: (x) => `rotate_token: new token ${x.verifier_token ? "issued" : "NOT issued"}, runs_required ${JSON.stringify(x.runs_required ?? null)}` });
      verifierToken = str(r, "verifier_token", "release_verify(rotate_token)");
      const old = await conv.call("eval", "replay_start", { case_set_id: sides[0].case_set_id, subject_version_id: sides[0].subject_version_id,
        split: "proof", repeats: 1, context: "verifier", verifier_token: dropped, idempotency_key: conv.key("stale") },
      { refusal: /verifier_token/ });
      if (!String(old.text ?? "").startsWith("ERROR")) throw new Error(`the dropped verifier_token still started a run: ${JSON.stringify(old).slice(0, 300)}`);
      continue;
    }
    replays += await runRequired(conv, stack, bin, sides, "proof", "verifier", verifierToken, clone);
  }
  if (verdict !== "rolled_back") throw new Error(`release_verify answered ${verdict || "nothing"}; the stub regresses the released subject so the rollback runs`);
  const rolled = await runCli(stack, "release-rollback", ["--release-attempt", attemptId, "--repo", clone,
    "--rollback-cmd", cmds.rollback, "--gateway", stack.url]);
  conv.note("zz-tool release-rollback", `exit ${rolled.code}: ${rolled.out.trim().split("\n").slice(-2).join(" | ").slice(0, 200)}`);
  if (rolled.code !== 0) throw new Error(`zz-tool release-rollback exited ${rolled.code}:\n${rolled.out.slice(-3000)}`);
  const closed = await conv.call("core", "initiative_close", { initiative: w.initiative, disposition: "finished",
    no_signoff_reason: "the release was rolled back on its own verification; the evaluation itself is finished" },
    { note: (r) => String(r.text ?? JSON.stringify(r)).slice(0, 160) });
  const after = await conv.call("core", "initiative_status", { initiative: w.initiative },
    { note: (r) => `next_move ${JSON.stringify(r.next_move)}` });
  const next = obj(after, "next_move", "initiative_status");
  if (next.action !== "closed") throw new Error(`after the close initiative_status says ${JSON.stringify(next)}: ${JSON.stringify(closed).slice(0, 300)}`);
  return { released: cmds.version, verdict, replays };
}
