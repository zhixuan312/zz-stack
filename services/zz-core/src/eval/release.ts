/**
 * `release_prepare` (Task I-22, FR-45 to FR-48, AC-45.1 to AC-48.1): the one boundary a proved
 * candidate crosses before a real owned system is ever touched (FR-46). It resolves this
 * candidate's required owners LIVE off `subject.ts`'s own `zz.plugin.release_owners` column —
 * never off the `touched_owners`/`release_eligible` flag `candidate_prove` recorded at proof
 * time, which is why the plan's own FR-47 says `release_prepare` "records the resolved list so a
 * future path-level resolver can replace this implementation without changing the gate
 * contract" — records the promotion package as a `zz.release_attempt` row (`prepared`), and
 * writes `<initiative>/improvement.md` (`improvement-doc.ts`) — the authority-bearing gate FR-48
 * names. Nothing here applies a patch, runs a repository gate or creates a release: that is
 * `release_apply`/`release_verify`, a later stage this plan does not implement (its own task
 * boundary: "final deliverable content is not in this plan").
 *
 * `initiative` was not in the plan's own signature. Added here for the same reason
 * `protocol_affirm` added it (`protocol.ts`'s own module note): there is no other way to locate a
 * team-scoped document from a bare `candidate_id`, and `improvement.md` — unlike `findings.md` —
 * this tool writes unconditionally rather than only when a caller happens to name one.
 *
 * `releaseDecision` (`release-rules.ts`) is deliberately NOT called from here — see that file's
 * own module note. This tool's gate is only the first branch of that same refusal order
 * (`no_release_owners`) plus a `not_eligible` refusal for a candidate that never reached
 * `proof_passed`; the rest of the order (`approval_required`, `digest_mismatch`,
 * `stale_baseline`) belongs to `release_apply`, once an approved document and a live current
 * subject both exist to check the rest of it against.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { writeImprovementDoc, type ProofEvaluationRow } from "./improvement-doc.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { db } from "../platform-db.js";

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
  readonly plugin: string; readonly declared_version: string; readonly origin: string;
  readonly release_owners: string[];
}

/** The base subject's own plugin — origin/release_owners live on `zz.plugin`, the SAME columns
 *  `subject.ts`'s `subjectResponse` reads, never a second, ad hoc resolution of ownership. */
async function loadSubject(p: pg.Pool, subjectVersionId: string): Promise<SubjectRow | null> {
  const row = (await p.query<SubjectRow>(`
    select pl.name as plugin, sv.declared_version, pl.origin, pl.release_owners
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

interface PrepareResult {
  readonly release_attempt_id: string; readonly required_owners: string[];
  readonly document: string | null; readonly document_refused?: string;
}

export function registerReleaseTools(server: McpServer): void {
  server.registerTool(
    "release_prepare",
    {
      description:
        "WHEN a candidate has reached proof_passed and is ready to cross the promotion boundary " +
        "(FR-46, nothing before this touches the real repository): resolves required owners " +
        "LIVE from the base subject's own release_owners (never the release_eligible flag " +
        "candidate_prove recorded at proof time), records the promotion package as a " +
        "zz.release_attempt row (prepared), and writes <initiative>/improvement.md — the " +
        "authority-bearing gate FR-48 names, naming the exact candidate/patch digest, proof " +
        "evidence, score change, guardrails, affected owners and the planned release/rollback. " +
        "RETURNS { release_attempt_id, required_owners, document }; the attempt id and owners " +
        "are always returned even when the document write is refused (an unopened initiative, a " +
        "closed one, a document already approved), which then answers document: null plus " +
        "document_refused naming why — retry with the SAME idempotency_key to write the " +
        "document against the already-recorded attempt, never with a fresh one, which would " +
        "record a second attempt. Applies no patch, runs no " +
        "repository gate, creates no release — that is release_apply/release_verify, a later " +
        "stage this tool never reaches. REFUSES a candidate that has not itself reached " +
        "proof_passed (not_eligible); a base subject with no recorded release_owners — a " +
        "third-party or not-yet-owned subject, which stays proposal-only (no_release_owners); " +
        "an unknown candidate_id; and a deployment with no platform database. A mutator: writes " +
        "through the FR-59 idempotency ledger.",
      inputSchema: {
        candidate_id: z.string(),
        initiative: z.string().describe("The initiative improvement.md is written into."),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ candidate_id, initiative, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();

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
          "may still receive an owner-facing proposal — see Task I-25's proposal path.");
      }

      const proof = await loadLatestProof(p, candidate_id);
      if (!proof) {
        return text(`ERROR: candidate ${candidate_id} has no recorded proof evaluation to prepare a release from`);
      }

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<{ id: string }> = await withIdempotency(
        principal, "release_prepare", idempotency_key, { candidate_id, initiative },
        async (client): Promise<MutatorOutcome<{ id: string }>> => {
          const row = (await client.query<{ id: string }>(`
            insert into zz.release_attempt
              (candidate_id, base_subject_version_id, approved_patch_digest, required_owners,
               approval_refs, status, created_at)
            values ($1::uuid, $2::uuid, $3, $4::jsonb, '[]'::jsonb, $5, now())
            returning id::text as id`,
            [candidate_id, candidate.base_subject_version_id, candidate.patch_digest,
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
        ? { release_attempt_id: releaseAttemptId, required_owners: requiredOwners,
            document: null, document_refused: written } satisfies PrepareResult
        : { release_attempt_id: releaseAttemptId, required_owners: requiredOwners,
            document: written.path } satisfies PrepareResult);
    },
  );
}
