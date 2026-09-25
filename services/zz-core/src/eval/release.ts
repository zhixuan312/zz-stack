/**
 * `release_prepare` (Task I-22, FR-45 to FR-48, AC-45.1 to AC-48.1): the one boundary a proved
 * candidate crosses before a real owned system is ever touched (FR-46). It resolves this
 * candidate's required owners LIVE off `subject.ts`'s own `zz.plugin.release_owners` column —
 * never off the `touched_owners`/`release_eligible` flag `candidate_prove` recorded at proof
 * time, which is why the plan's own FR-47 says `release_prepare` "records the resolved list so a
 * future path-level resolver can replace this implementation without changing the gate
 * contract" — records the promotion package as a `zz.release_attempt` row (`prepared`), and
 * writes `<initiative>/improvement.md` (`improvement-doc.ts`) — the authority-bearing gate FR-48
 * names. `release_prepare` itself applies no patch, runs no repository gate and creates no
 * release: `release_apply`, `release_record` and `release_verify`, registered below, are the
 * stages that do, once improvement.md is approved.
 *
 * `initiative` was not in the plan's own signature. Added here for the same reason
 * `protocol_affirm` added it (`protocol.ts`'s own module note): there is no other way to locate a
 * team-scoped document from a bare `candidate_id`, and `improvement.md` — unlike `findings.md` —
 * this tool writes unconditionally rather than only when a caller happens to name one.
 *
 * `releaseDecision` (`release-rules.ts`) is deliberately NOT called from here — see that file's
 * own module note. This tool's gate is only the first branch of that same refusal order
 * (`no_release_owners`) plus a `not_eligible` refusal for a candidate that never reached
 * `proof_passed` and a `not_owner` refusal for a caller in none of the owner teams; the rest of the order (`approval_required`, `digest_mismatch`,
 * `stale_baseline`) belongs to `release_apply`, once an approved document and a live current
 * subject both exist to check the rest of it against.
 *
 * `release_apply` and `release_record` (Task I-23, FR-49, AC-49.1) are this same file's other two
 * tools, registered below. Their own decision/CAS/replay logic lives in `release-apply.ts` and
 * `release-record.ts`, and who may call them in `../release-owners.ts` — the same split `release_prepare` above already keeps against `release-rules.ts` and
 * `improvement-doc.ts` — so this file stays only registration and description. zz-core has no
 * checkout of the plugin's repository, so applying the patch, hashing it, committing, running the
 * gate and running the repository's release procedure are NOT done here: `release_apply` decides
 * and locks; `packages/tools/src/release/apply.ts`, a CLI run by the IMPROVE agent (which has a
 * shell), does the git and process work and reports back through `release_record`. The same
 * server-decides/CLI-executes split replay and candidate-build already use.
 *
 * `proposal_prepare` (Task I-25, FR-51, FR-53, AC-51.1) is this file's fifth and last tool: the
 * path `release_prepare`'s own `no_release_owners` refusal above points callers toward — "It may
 * still receive an owner-facing proposal — see proposal_prepare." Registered here, beside
 * `release_prepare`, rather than in a module of its own, per this task's own Output line
 * ("proposal path in `release.ts`"). Its OWN refusal is the mirror image of `release_prepare`'s
 * `no_release_owners` branch: `release_prepare` refuses a subject with NO owners; `proposal_prepare`
 * refuses a subject WITH owners — "ERROR: promotable — use release_prepare, not proposal_prepare"
 * — because an ungated `proposal.md` written for an owned subject would sit in the store looking
 * like an approval document with no gate behind it, which FR-53's own "gated only when
 * release_mode = promotable" exists to prevent. The document write itself — findings, tested
 * patch where a source existed, validation/proof evidence, and the explicit "no repository write,
 * ever" guarantee — is `proposal-doc.ts`'s own job; this function only resolves the subject,
 * enforces the ownership mirror-guard, and threads the FR-59 idempotency ledger through a call
 * that writes no new database row of its own (`zz.improvement_run`'s own existing row is the
 * ledger's anchor — a plain re-select inside the transaction, never an insert — because
 * `proposal.md` is always regenerated fresh from CURRENT candidate/finding state on every call,
 * the same "no cached response body" contract `findings.md`'s own write already keeps).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { writeImprovementDoc, type ProofEvaluationRow } from "./improvement-doc.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { improvementRunOf, proofPassedCandidateOf } from "./initiative-run.js";
import { loadSubjectForEvalRun, writeProposalDoc } from "./proposal-doc.js";
import { describeApplyOutcomeForReplay, planApply, type ApplyResult } from "./release-apply.js";
import { prepareWithBranchFact } from "./release-prepare.js";
import { describeRecordOutcomeForReplay, recordRelease, type RecordResult } from "./release-record.js";
import { verifyRelease, type VerifyOutcome } from "./release-verify.js";
import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { db, teamFor } from "../platform-db.js";
import { memberTeams } from "../release-owners.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no release can be prepared");

interface CandidateRow {
  readonly id: string; readonly status: string; readonly base_subject_version_id: string;
  readonly patch_digest: string; readonly hypothesis: string; readonly complexity_delta: number;
}

async function loadCandidate(p: pg.Pool, candidateId: string): Promise<CandidateRow | null> {
  const row = (await p.query<CandidateRow>(`
    select id::text as id, status, base_subject_version_id::text as base_subject_version_id,
           patch_digest, hypothesis, complexity_delta
      from zz.candidate where id = $1::uuid`, [candidateId])).rows[0];
  return row ?? null;
}

interface SubjectRow {
  readonly plugin_id: string; readonly plugin: string; readonly declared_version: string;
  readonly origin: string; readonly release_owners: string[];
}

/** The base subject's own plugin — origin/release_owners live on `zz.plugin`, the SAME columns
 *  `subject.ts`'s `subjectResponse` reads, never a second, ad hoc resolution of ownership. */
async function loadSubject(p: pg.Pool, subjectVersionId: string): Promise<SubjectRow | null> {
  const row = (await p.query<SubjectRow>(`
    select pl.id::text as plugin_id, pl.name as plugin, sv.declared_version, pl.origin, pl.release_owners
      from zz.eval_subject_version sv join zz.plugin pl on pl.id = sv.plugin_id
     where sv.id = $1::uuid`, [subjectVersionId])).rows[0];
  return row ?? null;
}

async function loadLatestProof(p: pg.Pool, candidateId: string): Promise<ProofEvaluationRow | null> {
  const row = (await p.query<ProofEvaluationRow>(`
    select aggregate_score, dimension_scores, guardrails, statistics
      from zz.candidate_evaluation
     where candidate_id = $1::uuid and split = 'proof'
     order by created_at desc limit 1`, [candidateId])).rows[0];
  return row ?? null;
}

/** `candidate_id` and `patch_digest` are returned because `release_apply` (and `zz-tool
 *  release-apply --candidate`) take them, and this call resolved the candidate from the initiative:
 *  this response is where PROMOTE/VERIFY first learns either. */
interface PrepareResult {
  readonly candidate_id: string; readonly release_attempt_id: string; readonly patch_digest: string;
  readonly required_owners: string[];
  readonly document: string | null; readonly document_refused?: string;
  readonly facts: Record<string, string>;
}

export function registerReleaseTools(server: McpServer): void {
  server.registerTool(
    "release_prepare",
    {
      description:
        "WHEN a candidate has reached proof_passed and is ready to cross the promotion boundary " +
        "(FR-46, nothing before this touches the real repository): resolves the candidate from " +
        "the initiative alone — the one candidate of its improvement runs (the eval_run its " +
        "findings.md records) that reached proof_passed — then resolves required owners " +
        "LIVE from the base subject's own release_owners (never the release_eligible flag " +
        "candidate_prove recorded at proof time), records the promotion package as a " +
        "zz.release_attempt row (prepared), and writes <initiative>/improvement.md — the " +
        "authority-bearing gate FR-48 names, naming the exact candidate/patch digest, proof " +
        "evidence, score change, guardrails, affected owners and the planned release/rollback. " +
        "RETURNS { candidate_id, release_attempt_id, patch_digest, required_owners, document } — " +
        "candidate_id and patch_digest are what release_apply takes (patch_digest as " +
        "approved_patch_digest); the candidate, attempt id and owners " +
        "are always returned even when the document write is refused (an unopened initiative, a " +
        "closed one, a document already approved), which then answers document: null plus " +
        "document_refused naming why — retry with the SAME idempotency_key to write the " +
        "document against the already-recorded attempt, never with a fresh one, which would " +
        "record a second attempt. Applies no patch, runs no " +
        "repository gate, creates no release — that is release_apply/release_verify, a later " +
        "stage this tool never reaches. REFUSES an initiative with no findings.md eval_run " +
        "(no_eval_run), none of whose candidates reached proof_passed (not_eligible), or more " +
        "than one of whose did (ambiguous_candidate, listing them); a caller who is not a member of one of the base subject's " +
        "owner teams (not_owner); a base subject with no recorded release_owners — a " +
        "third-party or not-yet-owned subject, which stays proposal-only (no_release_owners); " +
        "a deployment with no platform database; and (FR-58, hard " +
        "refusal, before any write) this initiative's release_mode already set to something " +
        "other than promotable. RETURNS `facts`, this initiative's release_mode now recorded " +
        "as promotable. A mutator: writes through the FR-59 idempotency ledger.",
      inputSchema: {
        initiative: z.string().describe(
          "The initiative improvement.md is written into; its proof_passed candidate is the one prepared."),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ initiative, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();

      const resolved = await proofPassedCandidateOf(p, initiative);
      if (typeof resolved !== "string") return text(resolved.error);
      const candidate_id = resolved;
      const candidate = await loadCandidate(p, candidate_id);
      if (!candidate) return text(`ERROR: no candidate ${candidate_id}`);
      if (candidate.status !== "proof_passed") {
        return text(
          `ERROR: not_eligible — candidate ${candidate_id} is ${candidate.status}, not ` +
          "proof_passed; only a candidate whose sealed proof has passed may prepare a release");
      }

      const subject = await loadSubject(p, candidate.base_subject_version_id);
      if (!subject) {
        return text(
          `ERROR: candidate ${candidate_id} names base_subject_version_id ` +
          `${candidate.base_subject_version_id}, which this call cannot read back`);
      }
      const requiredOwners = subject.release_owners ?? [];
      if (requiredOwners.length === 0) {
        return text(
          `ERROR: no_release_owners — ${subject.plugin} ${subject.declared_version} ` +
          `(origin: ${subject.origin}) records no release_owners, so it cannot be promoted. It ` +
          "may still receive an owner-facing proposal — call proposal_prepare instead, naming " +
          "this initiative.");
      }

      // Only an owner may prepare: every prepared attempt is one `release_apply` could bind to,
      // and a stranger's fresh attempt would rewrite improvement.md to cite a row the owners
      // never read. Membership, never the caller's active team (release-owners.ts).
      const principal = parseCaller(requestHeaders()).email;
      const callerTeams = await memberTeams(p, principal);
      if (!requiredOwners.some((owner) => callerTeams.includes(owner))) {
        return text(
          `ERROR: not_owner — ${principal || "this caller"} is not a member of an owner team of ` +
          `${subject.plugin} (${requiredOwners.join(", ")}); only an owner may prepare its release`);
      }

      const proof = await loadLatestProof(p, candidate_id);
      if (!proof) {
        return text(`ERROR: candidate ${candidate_id} has no recorded proof evaluation to prepare a release from`);
      }

      // FR-58: release_prepare IS the promotable branch — a release_mode already set to
      // something else (proposal_only, from proposal_prepare or an improvement_start skip
      // against the same initiative) refuses the whole call as a hard error, and the
      // release_attempt row rolls back with it: an attempt recorded on the branch the initiative
      // already left is a real cross-tool inconsistency, not the informational drift
      // protocol_read's own resume case allows. One transaction, one connection
      // (release-prepare.ts).
      const { outcome, facts } = await prepareWithBranchFact<{ id: string }>(
        principal, "release_prepare", idempotency_key, { candidate_id, initiative },
        { root: await userRoot(), team: await teamFor(principal), initiative }, "promotable",
        async (client): Promise<MutatorOutcome<{ id: string }>> => {
          const row = (await client.query<{ id: string }>(`
            insert into zz.release_attempt
              (candidate_id, base_subject_version_id, plugin_id, approved_patch_digest,
               required_owners, approval_refs, status, created_at)
            values ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, '[]'::jsonb, $6, now())
            returning id::text as id`,
            [candidate_id, candidate.base_subject_version_id, subject.plugin_id, candidate.patch_digest,
             JSON.stringify(requiredOwners), "prepared"])).rows[0];
          if (!row) throw new Error("insert into zz.release_attempt produced no row");
          return { result: { id: row.id }, result_table: "zz.release_attempt", result_id: row.id };
        },
      );
      const releaseAttemptId = outcome.replayed ? outcome.result_id : outcome.result.id;

      // Written unconditionally, on every successful call (fresh or replayed) — unlike
      // findings.md, improvement.md is this tool's own reason to exist rather than an optional
      // extra a caller opts into, so there is no branch that records the attempt and skips it.
      //
      // A refused write does NOT roll back the zz.release_attempt row above — withIdempotency
      // already committed it, the same order finding_record's own DB-write-then-doc-write
      // already accepts. So this answers the same shape finding_record does for its own
      // optional findings.md write (`findings_md: { refused: doc }`): the attempt id and
      // resolved owners are ALWAYS returned, `document` is null and `document_refused` names
      // why, so a caller can retry writing the document (release_prepare with a FRESH
      // idempotency_key would otherwise insert a second `prepared` row, since the live
      // uniqueness index only covers `applying`/`released`) rather than losing track of the
      // attempt it already recorded.
      const written = await writeImprovementDoc(initiative, {
        candidate_id, release_attempt_id: releaseAttemptId,
        plugin: subject.plugin, declared_version: subject.declared_version,
        base_subject_version_id: candidate.base_subject_version_id,
        patch_digest: candidate.patch_digest, hypothesis: candidate.hypothesis,
        complexity_delta: candidate.complexity_delta, required_owners: requiredOwners, proof,
      });

      logActivity(await userRoot(), null, {
        user: principal, action: "release_prepare", candidate_id,
        release_attempt_id: releaseAttemptId, replayed: outcome.replayed,
        document_refused: typeof written === "string",
      });
      return json(typeof written === "string"
        ? { candidate_id, release_attempt_id: releaseAttemptId, patch_digest: candidate.patch_digest, required_owners: requiredOwners,
            document: null, document_refused: written, facts } satisfies PrepareResult
        : { candidate_id, release_attempt_id: releaseAttemptId, patch_digest: candidate.patch_digest, required_owners: requiredOwners,
            document: written.path, facts } satisfies PrepareResult);
    },
  );

  server.registerTool(
    "release_apply",
    {
      description:
        "WHEN improvement.md has been approved for a candidate release_prepare already recorded " +
        "a promotion package for (FR-49, the compare-and-swap): takes an advisory lock on the " +
        "candidate's own plugin, evaluates releaseDecision against the plugin's CURRENTLY " +
        "released version — the newest, by semver, registered in zz.plugin_version, leaving out " +
        "any version a rollback retracted — and, only on apply, moves the prepared " +
        "release_attempt improvement.md cites (the newest prepared one only while it cites none) " +
        "to applying, guarded by a " +
        "compare-and-swap on that exact row and by partial unique indexes allowing one live " +
        "attempt per candidate and one applying attempt per plugin. An approval counts only when " +
        "improvement.md is approved, cites THIS release_attempt_id in its body, quotes the " +
        "digest, and its approved_by is a MEMBER of an owner team; the caller must be an " +
        "owner-team member too. RETURNS { status: applying|refused, reason, release_attempt_id, " +
        "patch: {diff, patch_digest} | null, plan: {plugin, declared_version, " +
        "base_subject_version_id, branch, base_ref} | null } — base_ref is the commit the base " +
        "subject was released from, or null when nothing recorded one; patch/plan are null on a " +
        "refusal. Nothing here applies a patch, runs a gate or creates a release: zz-core has no " +
        "checkout of the plugin's repository, so packages/tools/src/release/apply.ts — a CLI the " +
        "IMPROVE agent runs next, with patch.diff, plan.branch and plan.base_ref — does that, and " +
        "reports back through release_record. REFUSES not_owner (the caller is in no owner " +
        "team), release_in_progress (another attempt of this plugin is applying; a stale one is " +
        "named with the zz-tool release-apply --reconcile command that records what really " +
        "happened to it), no_release_owners/not_eligible (recomputed live, though " +
        "release_prepare already checked both at prepare time), approval_required (no approved " +
        "improvement.md citing this attempt and quoting this exact digest, signed by an " +
        "owner-team member — NOT terminal, the attempt stays prepared " +
        "and a later call may still find it approved), digest_mismatch (approved_patch_digest " +
        "does not match the candidate's own recorded patch_digest), stale_baseline (the plugin's " +
        "currently released subject has moved since this candidate's own base — rebase, " +
        "re-validate, re-prove and re-approve before trying again), an unknown candidate_id, a " +
        "candidate with no prepared release_attempt, an improvement.md citing an attempt that is " +
        "not this candidate's prepared one, a plugin with no registered version, a current " +
        "version that is not newer than the base but was never captured (call plugin_locate for " +
        "it first), and a deployment with no " +
        "platform database. A mutator: writes through the FR-59 idempotency ledger.",
      inputSchema: {
        candidate_id: z.string(),
        approved_patch_digest: z.string(),
        initiative: z.string().describe("The initiative improvement.md was written into, so its approval can be read back."),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ candidate_id, approved_patch_digest, initiative, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<ApplyResult> = await withIdempotency(
        principal, "release_apply", idempotency_key, { candidate_id, approved_patch_digest, initiative },
        (client) => planApply(client, candidate_id, approved_patch_digest, initiative, principal),
      );
      const result = outcome.replayed
        ? await describeApplyOutcomeForReplay(p, outcome.result_id)
        : outcome.result;

      logActivity(await userRoot(), null, {
        user: principal, action: "release_apply", candidate_id,
        release_attempt_id: result.release_attempt_id, status: result.status,
        reason: result.reason, replayed: outcome.replayed,
      });
      return json(result);
    },
  );

  server.registerTool(
    "release_record",
    {
      description:
        "WHEN packages/tools/src/release/apply.ts has finished applying a candidate's patch — " +
        "successfully, through the gate and the repository's own release procedure, or not — or " +
        "packages/tools/src/release/rollback.ts has finished running the repository's own " +
        "rollback procedure over a release_verify verdict of rolled_back: records the outcome " +
        "the earlier call was left waiting for. Only the principal whose release_apply moved the " +
        "attempt to applying, or a member of one of its owner teams, may record it. On status: " +
        "released, requires release_ref (the full 40-hex commit sha the release tag names) and " +
        "released_subject_version_id (the new subject version the CLI resolved by calling " +
        "plugin_locate with the exact version the release published, which must be newer, by " +
        "semver, than the base), moves the release_attempt to released and the candidate to " +
        "released. On status: failed, requires failure_tail (the failing command's own output " +
        "tail) and moves the release_attempt to failed — the CLI has already removed its worktree " +
        "and branch; this only records that it happened. On status: rolled_back, requires reason " +
        "(why release_verify decided to roll back) and a recorded release_verify verdict of " +
        "rolled_back, and moves an ALREADY-released attempt to rolled_back, and its candidate to " +
        "rolled_back, retracting its version from what plugin_locate and release_apply read as " +
        "current, so the prior subject is current again (FR-50). " +
        "RETURNS { status, release_attempt_id, released_subject_version_id, release_ref }. " +
        "REFUSES not_owner — a caller who neither applied the attempt nor is in an owner team — " +
        "not_applying — an unknown release_attempt_id, or one that is not currently applying, for " +
        "a released/failed call (already released/refused/failed, or release_apply was never " +
        "called for it) — not_released for a rolled_back call against an attempt that never " +
        "reached released — not_rolled_back for a rolled_back call with no release_verify verdict " +
        "of rolled_back — prior_not_current for a rolled_back call after which the prior subject " +
        "would still not be current — not_newer for a released call whose subject is not newer than the base " +
        "(retryable: the attempt stays applying) — a released call whose release_ref is not a " +
        "40-hex commit sha (retryable too) — a released call naming a " +
        "released_subject_version_id of another plugin, a released call missing release_ref or " +
        "released_subject_version_id, a failed call missing failure_tail, a rolled_back call " +
        "missing reason, and a deployment with no platform database. A mutator: writes through " +
        "the FR-59 idempotency ledger.",
      inputSchema: {
        release_attempt_id: z.string(),
        status: z.enum(["released", "failed", "rolled_back"]),
        release_ref: z.string().optional(),
        released_subject_version_id: z.string().optional(),
        failure_tail: z.string().optional(),
        reason: z.string().optional().describe(
          "Required for status: rolled_back — why release_verify decided to roll back. On status: released, " +
          "optional: the operator's override --reconcile recorded (a tag accepted without the candidate's commit)."),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ release_attempt_id, status, release_ref, released_subject_version_id, failure_tail, reason, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<RecordResult> = await withIdempotency(
        principal, "release_record", idempotency_key,
        { release_attempt_id, status, release_ref, released_subject_version_id, failure_tail, reason },
        (client) => recordRelease(client, {
          release_attempt_id, status,
          release_ref: release_ref ?? null,
          released_subject_version_id: released_subject_version_id ?? null,
          failure_tail: failure_tail ?? null,
          reason: reason ?? null,
        }, principal),
      );
      const result = outcome.replayed
        ? await describeRecordOutcomeForReplay(p, outcome.result_id)
        : outcome.result;

      logActivity(await userRoot(), null, {
        user: principal, action: "release_record", release_attempt_id: result.release_attempt_id,
        status: result.status, replayed: outcome.replayed,
      });
      return json(result);
    },
  );

  server.registerTool(
    "release_verify",
    {
      description:
        "WHEN an attempt release_record already moved to released is ready for its automatic, " +
        "no-gate post-release check (FR-50, AC-50.1): replays the candidate's own proof-equivalent " +
        "held cases (the SAME split: proof rows candidate_prove already sealed, reused here well " +
        "after promotion, under a fresh verifier_token this call mints for the same candidate_id) " +
        "against the released subject and its prior version, computes the paired per-case deltas " +
        "of released against prior, and applies rollbackDecision. RETURNS { verdict: " +
        "established|rolled_back|not_established|null, reason, evidence: { deltas_summary, " +
        "guardrails } | null, rollback_plan: { plugin, declared_version, " +
        "prior_subject_version_id, branch } | null, runs_required?, verifier_token?, " +
        "token_already_issued?, status } — verdict stays null and runs_required: { case_set_id, " +
        "baseline, candidate } counts the replays each side still needs (baseline = the prior " +
        "subject, candidate = the released one; prior_subject_version_id and " +
        "released_subject_version_id name both beside it) while evidence is incomplete, exactly like " +
        "candidate_prove: run each with replay_start(context: verifier, verifier_token, split: " +
        "proof, case_set_id, subject_version_id of that side) and NO case_id — the server draws " +
        "the case; verifier_token carries the plaintext once, on the call that mints " +
        "it, and null on every later call (token_already_issued: true instead). On rolled_back, " +
        "this call records the verdict and rollback_plan but applies NOTHING itself and does not " +
        "move release_attempt.status — packages/tools/src/release/rollback.ts (or a zz-tool " +
        "release-rollback CLI) runs the repository's own rollback command (npm run rollback, " +
        "stubbed in verification) against rollback_plan and reports back through release_record " +
        "(status: rolled_back), which is what actually restores the prior subject and marks the " +
        "candidate. REFUSES not_owner — a caller who neither applied this attempt nor is a member " +
        "of one of its owner teams; not_released — an unknown release_attempt_id, or one release_record " +
        "never moved to released; an attempt with no released_subject_version_id recorded; a " +
        "candidate whose case set was never bound at evaluation_start; a protocol with no " +
        "bounded_semantic/generative_critic measure (every replay would score overall: null); " +
        "and a deployment with no platform database. Below the protocol's own minimum held-case " +
        "count, missing replay evidence that never arrives, or an interval that never resolves, " +
        "all by the protocol's own liveness bound, answer not_established with a named reason " +
        "(insufficient_proof_cases / replays_unavailable / verification_unresolved) — never a " +
        "rollback and never an indefinite wait (FR-50's own \"no rollback without evidence\"). " +
        "A required guardrail the runs collected so far already failed rolls back at once — while " +
        "the interval is still unresolved, while replays are still missing, and before the " +
        "liveness bound. " +
        "A mutator: writes through the FR-59 idempotency " +
        "ledger once evidence resolves; a pending runs_required read makes no ledger write. " +
        "`initiative` records release_mode: not_applicable (FR-58) on a rolled_back verdict — " +
        "usually a no-op, since release_prepare already set promotable. Lost the verifier_token? " +
        "rotate_token: true revokes it and returns a new one for the same attempt while runs are " +
        "still required; runs already registered stay counted.",
      inputSchema: {
        release_attempt_id: z.string(),
        idempotency_key: z.string().min(1),
        initiative: z.string().optional().describe(
          "Record release_mode: not_applicable as this initiative's durable branch fact on a " +
          "rolled_back verdict. Omit to read only."),
        rotate_token: z.boolean().optional().describe(
          "Revoke the verifier_token already issued for this attempt and return a new one — for a " +
          "conversation that no longer holds it. Only while runs are still required."),
      },
    },
    async ({ release_attempt_id, idempotency_key, initiative, rotate_token }) => {
      const p = db();
      if (!p) return noDb();

      const principal = parseCaller(requestHeaders()).email;
      const result: VerifyOutcome | { error: string } =
        await verifyRelease(p, release_attempt_id, idempotency_key, principal, initiative, rotate_token ?? false);
      if ("error" in result) return text(result.error);

      logActivity(await userRoot(), null, {
        user: principal, action: "release_verify", release_attempt_id,
        verdict: result.verdict, status: result.status,
      });
      return json(result);
    },
  );

  server.registerTool(
    "proposal_prepare",
    {
      description:
        "WHEN an improvement_run's own base subject records no release_owners (FR-51, " +
        "AC-51.1) and its findings/candidates are ready to be written up for whoever actually " +
        "owns that plugin: resolves the improvement_run from the initiative alone — the newest run " +
        "of the eval_run its findings.md records (a fresh improvement_start after a " +
        "not_established proof supersedes the earlier one) — and writes <initiative>/proposal.md (proposal-doc.ts), ungated (FR-53's " +
        "own \"a proposal_only branch writes ungated proposal.md\"), always regenerated FRESH " +
        "from the improvement_run's CURRENT findings and candidates on every call — never a " +
        "cached body from an earlier call, the same contract findings.md's own write already " +
        "keeps. It includes every candidate that reached validation or later (hypothesis, patch " +
        "digest, the diff itself as inert fenced markdown, validation/proof evidence) when the " +
        "base subject's own source_locator names a readable local_dir/git/package origin; when " +
        "it does not (an \"unrecorded\" or missing locator — the only shape a subject with no " +
        "source ever carries once plugin_register has validated everything it captures), the " +
        "document holds behavioural proposals only, drawn from findings alone, and says so " +
        "rather than rendering an empty Candidates section. RETURNS { document, " +
        "candidates_included } — document is null with document_refused naming why on an " +
        "unopened/closed initiative or an already-approved document, exactly like " +
        "release_prepare's own document_refused branch; candidates_included is always [] " +
        "on a document_refused answer, and either [] or the included candidate ids otherwise. " +
        "Applies NO patch and touches NO real repository, on this or any subject — its only two " +
        "side effects are a database read and a document write into this platform's own " +
        "governed store (see proposal-doc.ts's own module note, \"EXPLICIT GUARD\"). REFUSES " +
        "promotable — a base subject that DOES record release_owners: \"use release_prepare, " +
        "not proposal_prepare, for an owned subject\" — an initiative with no findings.md eval_run " +
        "(no_eval_run) or no improvement run on it (no_improvement_run), " +
        "one whose own eval_run names a subject this call cannot read back, and (FR-58, hard " +
        "refusal, before any write) this initiative's release_mode already set to something " +
        "other than proposal_only. RETURNS `facts`, this initiative's release_mode now recorded " +
        "as proposal_only. A mutator: " +
        "writes through the FR-59 idempotency ledger — the ledger's own anchor is the " +
        "improvement_run's ALREADY-existing row (a plain re-select, never an insert), because " +
        "this tool records no new database row of its own.",
      inputSchema: {
        initiative: z.string().describe(
          "The initiative proposal.md is written into; its newest improvement run is the one reported."),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ initiative, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();

      const resolved = await improvementRunOf(p, initiative);
      if (typeof resolved !== "string") return text(resolved.error);
      const improvement_run_id = resolved;

      const run = (await p.query<{ id: string; eval_run_id: string }>(
        "select id::text as id, eval_run_id::text as eval_run_id from zz.improvement_run where id = $1::uuid",
        [improvement_run_id])).rows[0];
      if (!run) return text(`ERROR: no improvement_run ${improvement_run_id}`);

      const subject = await loadSubjectForEvalRun(p, run.eval_run_id);
      if (!subject) {
        return text(
          `ERROR: improvement_run ${improvement_run_id}'s own eval_run ${run.eval_run_id} names ` +
          "a subject this call cannot read back");
      }
      // The mirror image of release_prepare's own no_release_owners refusal above: THAT tool
      // refuses a subject with NO owners; this one refuses a subject WITH owners. An ungated
      // proposal.md written for an owned subject would sit in the store looking like an
      // approval-free stand-in for improvement.md, which FR-53's own "gated only when
      // release_mode = promotable" exists to prevent.
      if (subject.release_owners.length > 0) {
        return text(
          `ERROR: promotable — ${subject.plugin} ${subject.declared_version} records ` +
          `release_owners (${subject.release_owners.join(", ")}); use release_prepare, not ` +
          "proposal_prepare, for an owned subject");
      }

      // FR-58, the mirror of release_prepare's own check: a hard refusal, in the same
      // transaction as the ledger row, so an initiative whose release_mode is already promotable
      // never gets an ungated proposal.md sitting beside a promotable attempt.
      const principal = parseCaller(requestHeaders()).email;
      const { outcome, facts } = await prepareWithBranchFact<{ id: string }>(
        principal, "proposal_prepare", idempotency_key, { improvement_run_id, initiative },
        { root: await userRoot(), team: await teamFor(principal), initiative }, "proposal_only",
        async (client): Promise<MutatorOutcome<{ id: string }>> => {
          // No new row — zz.improvement_run's own already-existing row is this ledger's anchor.
          // proposal.md is regenerated fresh from current state below on every call (see this
          // tool's own description), so nothing about ITS content is ever replayed from here.
          const row = (await client.query<{ id: string }>(
            "select id::text as id from zz.improvement_run where id = $1::uuid",
            [improvement_run_id])).rows[0];
          if (!row) throw new Error("zz.improvement_run row vanished between the check above and this transaction");
          return { result: { id: row.id }, result_table: "zz.improvement_run", result_id: row.id };
        },
      );
      const written = await writeProposalDoc(p, initiative, improvement_run_id);

      logActivity(await userRoot(), null, {
        user: principal, action: "proposal_prepare", improvement_run_id,
        document_refused: typeof written === "string", replayed: outcome.replayed,
      });
      return json(typeof written === "string"
        ? { document: null, document_refused: written, candidates_included: [], facts }
        : { document: written.path, candidates_included: written.candidates_included, facts });
    },
  );
}
