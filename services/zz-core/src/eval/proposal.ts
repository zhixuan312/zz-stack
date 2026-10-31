/**
 * `proposal_prepare` (FR-51, FR-53, AC-51.1) is the path `release_prepare`'s own
 * `no_release_owners` refusal points callers toward — "It may still receive an owner-facing
 * proposal — see proposal_prepare." Registered after the release tools. Its OWN
 * refusal is the mirror image of `release_prepare`'s `no_release_owners` branch: `release_prepare`
 * refuses a subject with NO owners; `proposal_prepare` refuses a subject WITH owners — "ERROR:
 * promotable — use release_prepare, not proposal_prepare" — because an ungated `proposal.md`
 * written for an owned subject would sit in the store looking like an approval document with no
 * gate behind it, which FR-53's own "gated only when release_mode = promotable" exists to prevent.
 * The document write itself — findings, built patch where a source existed, and the explicit "no
 * repository write, ever" guarantee — is `proposal-doc.ts`'s own job; this function only resolves
 * the subject, enforces the ownership mirror-guard, and threads the FR-59 idempotency ledger
 * through a call that writes no new database row of its own (`zz.improvement_run`'s own existing
 * row is the ledger's anchor — a plain re-select inside the transaction, never an insert — because
 * `proposal.md` is always regenerated fresh from CURRENT candidate/finding state on every call, the
 * same "no cached response body" contract `findings.md`'s own write already keeps).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { WRITES, requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { type MutatorOutcome } from "./idempotency.js";
import { improvementRunOf } from "./initiative-run.js";
import { loadSubjectForEvalRun, writeProposalDoc } from "./proposal-doc.js";
import { initiativePlace, prepareWithBranchFact } from "./release-prepare.js";
import { platformEvent } from "../indexing.js";
import { db } from "../platform-db.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));

export function registerProposalTool(server: McpServer): void {
  server.registerTool(
    "proposal_prepare",
    {
      annotations: WRITES,
      description:
        "WHEN this evaluation's team is not among the base subject's release_owners (a " +
        "third-party plugin, or one another team owns) and its " +
        "findings/candidates are ready to be written up for whoever actually " +
        "owns that plugin: resolves the improvement_run from the initiative alone — the newest run " +
        "of the eval_run its findings.md records (a fresh improvement_start supersedes an earlier " +
        "one) — and writes <initiative>/proposal.md, ungated, always regenerated FRESH " +
        "from the improvement_run's CURRENT findings and candidates on every call — never a " +
        "cached body from an earlier call, the same contract findings.md's own write already " +
        "keeps. It includes every valid (built and checked) candidate (hypothesis, patch " +
        "digest, the diff itself as inert fenced markdown, its build result) when the " +
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
        "governed store. REFUSES " +
        "promotable — a base subject whose release_owners include this evaluation's team: \"use " +
        "release_prepare, not proposal_prepare, for a subject this team owns\" — an initiative " +
        "with no findings.md eval_run " +
        "(no_eval_run) or no improvement run on it (no_improvement_run), " +
        "one whose own eval_run names a subject this call cannot read back, and (a hard " +
        "refusal, before any write) this initiative's release_mode already set to something " +
        "other than proposal_only. RETURNS `facts`, this initiative's release_mode now recorded " +
        "as proposal_only. A mutator: " +
        "writes through the idempotency ledger — the ledger's own anchor is the " +
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
      if (!p) return text("ERROR: this deployment has no platform database, so no proposal can be prepared");

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
      // The mirror image of release_prepare's own no_release_owners refusal (release.ts): THAT tool
      // refuses a subject with NO owners; this one refuses a subject WITH owners. An ungated
      // proposal.md written for an owned subject would sit in the store looking like an
      // approval-free stand-in for improvement.md, which FR-53's own "gated only when
      // release_mode = promotable" exists to prevent.
      if (subject.promotable) {
        return text(
          `ERROR: promotable — ${subject.plugin} ${subject.declared_version} records ` +
          `release_owners (${subject.release_owners.join(", ")}), and ${subject.run_team} is one of ` +
          "them; use release_prepare, not proposal_prepare, for a subject this team owns");
      }

      // FR-58, the mirror of release_prepare's own check: a hard refusal, in the same
      // transaction as the ledger row, so an initiative whose release_mode is already promotable
      // never gets an ungated proposal.md sitting beside a promotable attempt.
      const principal = parseCaller(requestHeaders()).email;
      const placeForProposal = await initiativePlace(principal, initiative);
      if (typeof placeForProposal === "string") return text(placeForProposal);
      const { outcome, facts } = await prepareWithBranchFact<{ id: string }>(
        principal, "proposal_prepare", idempotency_key, { improvement_run_id, initiative },
        placeForProposal, "proposal_only",
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

      platformEvent({
        actor: principal, kind: "proposal_prepare", initiative, improvement_run_id,
        document_refused: typeof written === "string", replayed: outcome.replayed,
      });
      return json(typeof written === "string"
        ? { document: null, document_refused: written, candidates_included: [], facts }
        : { document: written.path, candidates_included: written.candidates_included, facts });
    },
  );
}
