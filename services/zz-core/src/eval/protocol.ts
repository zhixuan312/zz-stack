/**
 * The protocol lifecycle (FR-4, FR-5, FR-6, Task I-10): `protocol_read`, `protocol_record` and
 * `protocol_affirm` — the durable `EvaluationProtocol` a plugin version is scored against,
 * replacing the `ruler_*` tools this task removes from the door entirely. Historical
 * `zz.rubric*` rows are untouched and stay readable by `round_scores` (AC-7.1); nothing here
 * writes or reads that table.
 *
 * `protocol_read` takes only a `subject_version_id` and decides `protocol_action` — `create` (no
 * protocol exists yet), `reuse` (the newest version is still compatible) or `revise` (a trigger
 * fired) — entirely from live state; see `protocol-triggers.ts` for the four triggers. There is
 * no edit: `protocol_record` always inserts a new, immutable version (`protocol-record.ts`), and
 * `protocol_affirm` binds a person's approval of `protocol.md` to the exact version they read.
 *
 * `protocol_affirm`'s binding mechanism, decided by this task (the plan states only the tool's
 * shape, not how a document's approval reaches this door): `protocol.md` lives in the artifact
 * store the same way `rulers.md` did — `<initiative>/protocol.md` under the caller's own team,
 * read straight off disk the way `plugin-facts.ts`'s `bodyOf` reads a judged document, because
 * `document_approve` writes synchronously and the search index (`zz.doc`) is updated through a
 * fire-and-forget `indexDoc` call that can still be stale in the same turn. Binding an
 * `initiative` was not in the plan's own signature — added here because there is no other way to
 * locate a team-scoped document from a bare `protocol_version_id`, stated in this file's own
 * tool description. "At the same digest" (the contract's own words) is checked by requiring the
 * document's body to quote the `content_digest` `protocol_record` returned, verbatim — the one
 * fact that ties a page of prose to the exact immutable row it was written to describe.
 */
import { existsSync, readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { documentBody, EvaluationProtocol, parseEnvelope, parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { latestProtocolVersion, triggersFor } from "./protocol-triggers.js";
import { recordProtocolVersion } from "./protocol-record.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { logActivity } from "../persist.js";
import { safeName, safePath, userRoot } from "../paths.js";
import { db } from "../platform-db.js";
import { Refusal } from "../refusal.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no protocol can be recorded or read");

/** `subject_version_id` → the plugin it names, or null for one nothing minted. `plugin_locate`/
 *  `plugin_register` (subject.ts) are the only writers of this table, so a miss here means the
 *  caller has not IDENTIFY'd the subject yet — the same ordering DISCOVER's `resolveSnapshot`
 *  enforces one stage later. */
async function pluginOf(p: pg.Pool, subjectVersionId: string): Promise<{ pluginId: string; plugin: string } | null> {
  const row = (await p.query<{ plugin_id: string; plugin: string }>(`
    select sv.plugin_id::text as plugin_id, pl.name as plugin
      from zz.eval_subject_version sv join zz.plugin pl on pl.id = sv.plugin_id
     where sv.id = $1::uuid`, [subjectVersionId])).rows[0];
  return row ? { pluginId: row.plugin_id, plugin: row.plugin } : null;
}

export function registerProtocolTools(server: McpServer): void {
  server.registerTool(
    "protocol_read",
    {
      description:
        "WHEN starting or resuming the define stage: reads whether this subject's plugin " +
        "already has a compatible EvaluationProtocol. RETURNS protocol_version_id (null if " +
        "none exists yet), protocol_action — create (no protocol at all), reuse (the newest " +
        "version still fits, nothing to do) or revise (a trigger fired, record a new version) " +
        "— and triggers: which of purpose_changed, new_recurring_failure, evaluator_drift, " +
        "new_evidence_surface fired, or none. Computed entirely from live state — no document, " +
        "no protocol_body — from the plugin plugin_locate/plugin_register already IDENTIFY'd. " +
        "REFUSES a subject_version_id nothing minted, and a deployment with no platform " +
        "database. Read-only; never writes.",
      inputSchema: { subject_version_id: z.string() },
    },
    async ({ subject_version_id }) => {
      const p = db();
      if (!p) return noDb();
      const subject = await pluginOf(p, subject_version_id);
      if (!subject) return text("ERROR: unknown subject_version_id — call plugin_locate or plugin_register first");

      const latest = await latestProtocolVersion(p, subject.pluginId);
      if (!latest) {
        return json({ protocol_version_id: null, protocol_action: "create", triggers: ["none"],
          note: "No protocol exists for this plugin yet. Record one with protocol_record." });
      }
      const triggers = await triggersFor(p, subject.pluginId, subject.plugin, latest);
      const protocol_action = triggers.length ? "revise" : "reuse";
      return json({
        protocol_version_id: latest.id, protocol_action, triggers: triggers.length ? triggers : ["none"],
        note: protocol_action === "reuse"
          ? "REUSE, DO NOT RECORD. This plugin's newest protocol version is still compatible."
          : `RECORD A NEW VERSION: ${triggers.join(", ")} fired against version ${latest.version}. ` +
            "protocol_record never edits a version in place.",
      });
    },
  );

  server.registerTool(
    "protocol_record",
    {
      description:
        "WHEN a protocol needs to be created or revised, after protocol_read said so: validates " +
        "protocol_body against EvaluationProtocol and writes it as a new, immutable " +
        "zz.eval_protocol_version (with its dimensions and measures), folding in DISCOVER " +
        "lineage for any failureTaxonomy entry naming a candidateId/mergedCandidateIds. " +
        "RETURNS { protocol_version_id, content_digest }. REFUSES an invalid body with the zod " +
        "issues verbatim; a version number that is not this protocol's next one — there is no " +
        "edit, only a new version; a bounded_semantic/generative_critic measure with no usable " +
        "evaluator; and a failureTaxonomy candidateId naming no candidate from this plugin's " +
        "own evidence. A mutator: writes through the FR-59 idempotency ledger.",
      inputSchema: {
        subject_version_id: z.string(),
        protocol_body: z.record(z.string(), z.unknown()),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ subject_version_id, protocol_body, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();
      const parsed = EvaluationProtocol.safeParse(protocol_body);
      if (!parsed.success) return json({ issues: parsed.error.issues });

      const subject = await pluginOf(p, subject_version_id);
      if (!subject) return text("ERROR: unknown subject_version_id — call plugin_locate or plugin_register first");

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<{ protocol_version_id: string; content_digest: string }> =
        await withIdempotency(
          principal, "protocol_record", idempotency_key, { subject_version_id, protocol_body },
          async (client): Promise<MutatorOutcome<{ protocol_version_id: string; content_digest: string }>> => {
            const result = await recordProtocolVersion(client, subject.pluginId, parsed.data);
            if (typeof result === "string") throw new Refusal(result);
            return { result, result_table: "zz.eval_protocol_version", result_id: result.protocol_version_id };
          },
        );

      let response: { protocol_version_id: string; content_digest: string };
      if (outcome.replayed) {
        const row = (await p.query<{ content_digest: string }>(
          "select content_digest from zz.eval_protocol_version where id = $1::uuid", [outcome.result_id])).rows[0];
        response = { protocol_version_id: outcome.result_id, content_digest: row?.content_digest ?? "" };
      } else {
        response = outcome.result;
      }

      logActivity(await userRoot(), null, {
        user: principal, action: "protocol_record", plugin: subject.plugin,
        protocol_version_id: response.protocol_version_id, replayed: outcome.replayed,
      });
      return json(response);
    },
  );

  server.registerTool(
    "protocol_affirm",
    {
      description:
        "WHEN protocol.md has been approved and a person has agreed what this plugin's " +
        "protocol means — after that, never before. It reads <initiative>/protocol.md from " +
        "YOUR team's artifact store — pass the initiative the define stage wrote it into, " +
        "since a bare protocol_version_id names no path on its own — and RETURNS " +
        "{ approved_document_path, approved_by } once bound. REFUSES ERROR: protocol.md at " +
        "this version is not approved — when the document does not exist, is not " +
        "status: approved, or does not quote this version's content_digest anywhere in its " +
        "body: a document approved for a DIFFERENT version of this protocol is not approved " +
        "for this one. A mutator: writes through the FR-59 idempotency ledger.",
      inputSchema: {
        protocol_version_id: z.string(),
        initiative: z.string().describe("The initiative protocol.md was written into."),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ protocol_version_id, initiative, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();
      const row = (await p.query<{ content_digest: string }>(
        "select content_digest from zz.eval_protocol_version where id = $1::uuid", [protocol_version_id])).rows[0];
      if (!row) return text(`ERROR: unknown protocol_version_id ${protocol_version_id}`);

      // `initiative` is one path segment, never a nested path — `safePath` alone only keeps the
      // result inside the store, and "a/b" passes that check while naming no real initiative.
      const badInitiative = safeName(initiative, "initiative");
      if (badInitiative) return text(badInitiative);
      const path = `${initiative}/protocol.md`;
      const target = await safePath(path);
      const NOT_APPROVED =
        "ERROR: protocol.md at this version is not approved. Write it, put it to a person, and " +
        "call document_approve the moment they agree — then quote this version's content_digest " +
        `(${row.content_digest}) somewhere in the document's body before calling this again.`;
      if (!existsSync(target)) return text(NOT_APPROVED);
      const raw = readFileSync(target, "utf8");
      const env = parseEnvelope(raw);
      if (env.status !== "approved") return text(NOT_APPROVED);
      if (!documentBody(raw).includes(row.content_digest)) return text(NOT_APPROVED);

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<null> = await withIdempotency(
        principal, "protocol_affirm", idempotency_key, { protocol_version_id, initiative },
        async (client): Promise<MutatorOutcome<null>> => {
          await client.query(
            "update zz.eval_protocol_version set approved_document_path = $1 where id = $2::uuid",
            [path, protocol_version_id]);
          return { result: null, result_table: "zz.eval_protocol_version", result_id: protocol_version_id };
        },
      );
      logActivity(await userRoot(), null, {
        user: principal, action: "protocol_affirm", protocol_version_id, path, replayed: outcome.replayed,
      });
      return json({ approved_document_path: path, approved_by: env.approved_by ?? null });
    },
  );
}
