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
 * shape, not how a document's approval reaches this door): `protocol.md` is a governed document
 * like any other — `<initiative>/protocol.md` under the caller's own team, read from
 * `zz.doc`/`zz.doc_revision` the way `subject-ref.ts` reads a judged document, so the bytes this
 * binds are the ones the current revision holds. (It was read off disk while the store was files,
 * and the contrast that paragraph drew — a row lagging a fire-and-forget index — is gone with the
 * index: the row IS the record now.) Binding an
 * `initiative` was not in the plan's own signature — added here because there is no other way to
 * locate a team-scoped document from a bare `protocol_version_id`, stated in this file's own
 * tool description. "At the same digest" (the contract's own words) is checked by requiring the
 * document's body to quote the `content_digest` `protocol_record` returned, verbatim — the one
 * fact that ties a page of prose to the exact immutable row it was written to describe.
 *
 * The affirmation names the document, not its path: `approved_doc_id` is a row of `zz.doc` (the
 * phase-3 shape `eval_protocol_version` takes), and the three affirmation fields fill together,
 * once — a version's payload and its affirmation are both written once and there is no path that
 * moves either again (FR-6's `recorded -> affirmed`). The document row itself is required rather
 * than assumed: a protocol.md that no row carries is
 * refused with that cause named, never written as a claim with nothing behind it.
 *
 * `writeBranchFacts` (Task I-27, FR-52, FR-58) is this file's third export: the one writer of
 * an initiative's durable branch facts (`protocol_action`, `improvement_mode`, `release_mode`)
 * every flow's `when` reads (`documentApplies`, packages/contracts/src/flow-when.js). Placed
 * here per the plan's own Output line — `protocol_read` is its first caller — and imported by
 * `candidates.ts` (`improvement_start`) and `release-prepare.ts` (`release_prepare`/`proposal_prepare`),
 * which is why it takes no `subject_version_id`-shaped context of its own: every caller already
 * knows its initiative and what it decided.
 *
 * The store write follows `writeRoundAssessments` (semantic.ts): `initiative-record.ts` owns
 * the rows' name and mechanical write (`factsFor`/`writeFacts`); this function owns the
 * one rule that write must obey — a fact already set refuses a different value, forever — and
 * mirrors every set fact into `zz.initiative_fact` (001) so the console, which
 * reads the rows alone, can compute the same `documentApplies` answer. The mirror is written in
 * the same call as the fact, never left to a later pass: a stale console stepper is a wrong
 * answer about whether an initiative may close.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EvaluationProtocol, parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { latestProtocolVersion, triggersFor } from "./protocol-triggers.js";
import { affirmProtocolVersion, recordProtocolVersion } from "./protocol-record.js";
import { recordAffirmed, recordDefineOwes } from "./stage-record.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { factsFor, initiativeIdFor, lockInitiativeFacts, withInitiativeFactsLock, writeFacts } from "../initiative-record.js";
import { platformEvent } from "../indexing.js";
import { safeName } from "../paths.js";
import { db, teamFor } from "../platform-db.js";
import { Refusal } from "../refusal.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no protocol can be recorded or read");

/** `subject_version_id` → the plugin it names, or null for one nothing minted. A subject version
 *  IS a `plugin_version` row (FR-24), so the release's own row carries the plugin it belongs to;
 *  `plugin_locate`/`plugin_register` (subject.ts) are the only writers of that table, so a miss
 *  here means the caller has not IDENTIFY'd the subject yet — the same ordering DISCOVER's
 *  `resolveSnapshot` enforces one stage later. */
async function pluginOf(p: pg.Pool, subjectVersionId: string): Promise<{ pluginId: string; plugin: string } | null> {
  const row = (await p.query<{ plugin_id: string; plugin: string }>(`
    select pv.plugin_id::text as plugin_id, pl.name as plugin
      from zz.plugin_version pv join zz.plugin pl on pl.id = pv.plugin_id
     where pv.id = $1::uuid`, [subjectVersionId])).rows[0];
  return row ? { pluginId: row.plugin_id, plugin: row.plugin } : null;
}

/** The three durable branch facts (FR-58) — every caller passes only the ones it decided.
 *  DELIBERATE: not exported — `writeBranchFacts` below is the one signature that names it, and
 *  every caller passes a plain object literal it structurally matches. */
interface BranchFacts {
  protocol_action?: string;
  improvement_mode?: string;
  release_mode?: string;
}

/** Where a branch-fact write lands and what it writes through: the team that owns the
 *  initiative, and the one client inside an open transaction that takes the cross-process lock
 *  and writes the rows. There is no store root any more — the facts ARE `zz.initiative_fact`
 *  rows, and a file was only ever the other half of the same record.
 *
 *  DELIBERATE: resolved by the caller BEFORE its transaction — `teamFor` queries the pool on a
 *  cache miss, and a second connection taken while this one is held is how the four-connection
 *  pool starves. */
interface FactsTransaction {
  readonly client: Pick<pg.PoolClient, "query">;
  readonly team: string;
}

/** The read, the refuse-on-change decision and the write, under both halves of the facts lock:
 *  the caller holds `withInitiativeFactsLock`, and this takes the transaction lock on
 *  `tx.client`. Two callers deciding different values would otherwise both pass on the same
 *  empty read, and the second write would silently replace a fact the first had recorded.
 *
 *  COUPLED: the write IS the row. `zz.initiative_fact` is keyed on the initiative's own id, so
 *  a slug written into a slug column is a fact nothing can join; the id is resolved here, from
 *  the same team and slug every other reader of this initiative uses. */
async function decideBranchFacts(
  tx: FactsTransaction, initiative: string, updates: BranchFacts,
): Promise<string | Record<string, string>> {
  const initiativeId = await initiativeIdFor(tx.client, tx.team, initiative);
  if (!initiativeId) {
    return `ERROR: no initiative named "${initiative}" — branch facts are recorded against an ` +
      "opened one; call initiative_open first.";
  }
  await lockInitiativeFacts(tx.client, initiative);
  const current = await factsFor(tx.client, tx.team, initiative);
  const entries = (Object.entries(updates) as [string, string | undefined][])
    .filter((e): e is [string, string] => e[1] !== undefined && e[1] !== "");
  for (const [fact, value] of entries) {
    const have = current[fact];
    if (have && have !== value) return `ERROR: ${fact} is already ${have} for this initiative`;
  }
  const fresh = entries.filter(([fact, value]) => current[fact] !== value);
  const next = { ...current };
  for (const [fact, value] of fresh) next[fact] = value;
  // Every fact this call holds, not only the fresh ones: a caller that already had a value here
  // gets the same merged object back, so "I set this" and "this was already true" are one answer
  // to a caller resuming after somebody else wrote it first.
  if (fresh.length) await writeFacts(tx.client, initiativeId, next);
  return next;
}

/**
 * Set one or more of an initiative's durable branch facts (FR-52, FR-58). Every caller passes
 * only what it decided; an already-set fact refuses a DIFFERENT value and is silently a no-op
 * for the SAME one — a caller resuming after another wrote it first sees no difference between
 * "I set this" and "this was already true".
 *
 * `within`: a caller already inside a transaction (release_prepare/proposal_prepare, which write
 * a ledger row and this fact together) passes its own client and team, and the lock and the
 * write go through that one connection. Without it, this opens one short transaction of its own
 * for the lock and the write, and holds nothing else while it does.
 *
 * RETURNS the merged facts object on success, or an `ERROR: …` string naming the fact and its
 * standing value — callers that treat a re-derived value as informational (protocol_read, where
 * a resumed read may legitimately recompute a different action once a protocol now exists)
 * fold that string into their own response instead of failing outright; callers for whom a
 * conflict means the wrong branch entirely (release_prepare, proposal_prepare, the
 * improvement_start skip) return it as the tool's own refusal.
 */
export async function writeBranchFacts(
  initiative: string, updates: BranchFacts, within?: FactsTransaction,
): Promise<string | Record<string, string>> {
  const badInitiative = safeName(initiative, "initiative");
  if (badInitiative) return badInitiative;
  if (within) return withInitiativeFactsLock(initiative, () => decideBranchFacts(within, initiative, updates));

  const team = await teamFor(parseCaller(requestHeaders()).email);
  const p = db();
  if (!p || !team) {
    return "ERROR: no platform database, or a caller this deployment cannot place — branch " +
      "facts are rows, and there is nowhere to record one.";
  }
  return withInitiativeFactsLock(initiative, async () => {
    const client = await p.connect();
    try {
      await client.query("BEGIN");
      const decided = await decideBranchFacts({ client, team }, initiative, updates);
      await client.query("COMMIT");
      return decided;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}

export function registerProtocolTools(server: McpServer): void {
  server.registerTool(
    "protocol_read",
    {
      description:
        "WHEN starting or resuming the define stage: reads whether this subject's plugin " +
        "already has a compatible EvaluationProtocol. RETURNS protocol_version_id (null if " +
        "none exists yet), protocol_action — create (no protocol at all), reuse (the newest " +
        "version is affirmed and still fits, nothing to do) or revise (a trigger fired, record a new version) " +
        "— and triggers: which of purpose_changed, new_recurring_failure, evaluator_drift, " +
        "new_evidence_surface fired, or none. A newest version protocol_affirm never bound is " +
        "never reuse: it answers create (no version was ever affirmed) or revise, plus " +
        "awaiting_affirmation: { version, content_digest } — with no trigger, get that version's " +
        "protocol.md approved and affirmed rather than recording another. Also RETURNS " +
        "open_candidates: every DISCOVER candidate of this plugin still at status candidate " +
        "({ id, description, prevalence, owner_kind, owner_ref — the plugin's name when owner_kind is plugin }) — the ids a failureTaxonomy entry's " +
        "candidateId/mergedCandidateIds fold in. Computed entirely from live state — no document, " +
        "no protocol_body — from the plugin plugin_locate/plugin_register already IDENTIFY'd. " +
        "Pass `initiative` to record protocol_action as that initiative's durable branch fact " +
        "(FR-58) — omit it and nothing is recorded, which the response says. A fact already set " +
        "to a DIFFERENT action is left standing (facts_recorded: false, facts_refused naming " +
        "why) rather than refusing the whole call: a resumed read may legitimately recompute " +
        "reuse once protocol_record has since run, and that is informational, not an error. " +
        "REFUSES a subject_version_id nothing minted, and a deployment with no platform " +
        "database. Otherwise read-only; never writes to zz.eval_protocol_version.",
      inputSchema: {
        subject_version_id: z.string(),
        initiative: z.string().optional().describe(
          "Record protocol_action as this initiative's durable branch fact. Omit to read only."),
      },
    },
    async ({ subject_version_id, initiative }) => {
      const p = db();
      if (!p) return noDb();
      const subject = await pluginOf(p, subject_version_id);
      if (!subject) return text("ERROR: unknown subject_version_id — call plugin_locate or plugin_register first");

      const latest = await latestProtocolVersion(p, subject.pluginId);
      let response: Record<string, unknown>;
      if (!latest) {
        response = { protocol_version_id: null, protocol_action: "create", triggers: ["none"],
          note: "No protocol exists for this plugin yet. Record one with protocol_record." };
      } else if (!latest.affirmed) {
        // FR-6: recorded is not agreed. A newest version protocol_affirm never bound is not
        // reusable — nothing may score against it — so the stage that recorded it is still open:
        // `create`/`revise` as the lineage began, which keeps protocol.md applying on this
        // initiative's branch. It is not a reason to record again unless a trigger fired.
        const triggers = await triggersFor(p, subject.pluginId, subject.plugin, latest);
        response = {
          protocol_version_id: latest.id, protocol_action: latest.any_affirmed ? "revise" : "create",
          triggers: triggers.length ? triggers : ["none"],
          awaiting_affirmation: { version: latest.version, content_digest: latest.content_digest },
          note: triggers.length
            ? `RECORD A NEW VERSION: ${triggers.join(", ")} fired against version ${latest.version}, ` +
              "which was never affirmed either. protocol_record never edits a version in place."
            : `AWAITING APPROVAL OF VERSION ${latest.version}, DO NOT RECORD. It was recorded, but no ` +
              `approved protocol.md is bound to it: write protocol.md quoting content_digest ` +
              `${latest.content_digest}, have it approved, then call protocol_affirm. Nothing ` +
              "qualifies or scores against it until then.",
        };
      } else {
        const triggers = await triggersFor(p, subject.pluginId, subject.plugin, latest);
        const protocol_action = triggers.length ? "revise" : "reuse";
        response = {
          protocol_version_id: latest.id, protocol_action, triggers: triggers.length ? triggers : ["none"],
          note: protocol_action === "reuse"
            ? "REUSE, DO NOT RECORD. This plugin's newest protocol version is affirmed and still compatible."
            : `RECORD A NEW VERSION: ${triggers.join(", ")} fired against version ${latest.version}. ` +
              "protocol_record never edits a version in place.",
        };
      }
      // What DISCOVER left for this stage to fold in or leave uncited, read here rather than
      // carried from DISCOVER's own reply: a DEFINE opened in a new conversation has no other
      // door to them, and re-running failure_discover would mint a duplicate set. A failure mode
      // is an identity now and a discovery of it is a sighting (Task I-24), so what is unfolded
      // is a sighting whose identity no protocol version of this plugin has folded in yet — the
      // relation `eval_protocol_failure_mode` is what folding writes, and `failure_mode_id` is
      // the id a `failureTaxonomy` entry actually folds in.
      response.open_candidates = (await p.query<{
        id: string; description: string; failure_mode_id: string; stable_key: string;
        prevalence_numerator: number; prevalence_denominator: number;
        owner_kind: string; owner_ref: string | null;
      }>(`
        select s.id::text as id, s.description, fm.id::text as failure_mode_id, fm.stable_key,
               s.prevalence_numerator, s.prevalence_denominator, s.owner_kind, s.owner_ref
          from zz.eval_failure_mode_sighting s
          join zz.eval_failure_mode fm on fm.id = s.failure_mode_id
         where fm.plugin_id = $1::uuid
           and not exists (select 1 from zz.eval_protocol_failure_mode pfm
                             join zz.eval_protocol_version pv on pv.id = pfm.protocol_version_id
                            where pfm.failure_mode_id = fm.id and pv.plugin_id = $1::uuid)
         order by s.created_at`, [subject.pluginId])).rows.map((c) => ({
          id: c.id, failure_mode_id: c.failure_mode_id, stable_key: c.stable_key,
          description: c.description,
          prevalence: { numerator: c.prevalence_numerator, denominator: c.prevalence_denominator },
          owner_kind: c.owner_kind, owner_ref: c.owner_ref,
        }));
      if (!initiative) return json({ ...response, facts_recorded: false });
      const written = await writeBranchFacts(initiative, { protocol_action: response.protocol_action as string });
      // create/revise: once protocol.md is approved this initiative owes the bind and the
      // qualification, which initiative_status routes to before EVALUATE (stage-record.ts).
      const owes = response.protocol_action === "reuse" ? {}
        : await recordDefineOwes(initiative);
      return json(typeof written === "string"
        ? { ...response, ...owes, facts_recorded: false, facts_refused: written }
        : { ...response, ...owes, facts_recorded: true, facts: written });
    },
  );

  server.registerTool(
    "protocol_record",
    {
      description:
        "WHEN a protocol needs to be created or revised, after protocol_read said so: validates " +
        "protocol_body against EvaluationProtocol and writes it as a new, immutable " +
        "zz.eval_protocol_version (with its dimensions and measures), under the plugin and the " +
        "protocol_key the body names — the header table that used to carry them is gone — and " +
        "folds DISCOVER lineage in: every failureTaxonomy entry naming a candidateId/" +
        "mergedCandidateIds writes one eval_protocol_failure_mode row, and a bare string entry " +
        "folds in the failure mode with that stable_key. " +
        "RETURNS { protocol_version_id, content_digest, unfolded_taxonomy_keys } — the last " +
        "naming any failureTaxonomy entry that named no failure mode of this plugin, so a name " +
        "nothing folded in is visible rather than silently dropped. REFUSES an invalid body with the zod " +
        "issues verbatim; a version number that is not this protocol's next one — there is no " +
        "edit, only a new version; a measure key repeated anywhere in the body (keys are unique " +
        "protocol-wide); a bounded_semantic/generative_critic measure with no usable " +
        "evaluator; and a failureTaxonomy entry naming no failure mode or sighting from this " +
        "plugin's " +
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
      // The version names who recorded it — `recorded_by` is a principal, and a row that named an
      // address no principal carries would be a claim with nothing behind it.
      const recorder = (await p.query<{ id: string }>(
        "select id::text as id from zz.principal where lower(email) = lower($1) limit 1",
        [principal])).rows[0];
      if (!recorder) return text(`ERROR: no zz.principal carries "${principal}", so this recording has nobody to name`);
      const outcome: IdempotencyOutcome<{ protocol_version_id: string; content_digest: string }> =
        await withIdempotency(
          principal, "protocol_record", idempotency_key, { subject_version_id, protocol_body },
          async (client): Promise<MutatorOutcome<{ protocol_version_id: string; content_digest: string }>> => {
            const result = await recordProtocolVersion(client, subject.pluginId, parsed.data, recorder.id);
            if (typeof result === "string") throw new Refusal(result);
            return { result, result_table: "zz.eval_protocol_version", result_id: result.protocol_version_id };
          },
        );

      let response: { protocol_version_id: string; content_digest: string };
      if (outcome.replayed) {
        // A replay answers the two ids and nothing else: the fold this call's own first pass
        // wrote is a relation row already, so there is nothing left to report about it.
        const row = (await p.query<{ content_digest: string }>(
          "select content_digest from zz.eval_protocol_version where id = $1::uuid", [outcome.result_id])).rows[0];
        response = { protocol_version_id: outcome.result_id, content_digest: row?.content_digest ?? "" };
      } else {
        response = outcome.result;
      }

      platformEvent({
        actor: principal, kind: "protocol_record", plugin: subject.plugin,
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
        "YOUR team's documents — pass the initiative the define stage wrote it into, " +
        "since a bare protocol_version_id names no path on its own — and RETURNS " +
        "{ approved_document_path, approved_by, qualify_owed } once bound — qualify_owed is every " +
        "model-backed measure key evaluator_qualify must now be called for, and is recorded on " +
        "the initiative so initiative_status routes to it before EVALUATE. Binding fills the three " +
        "affirmation fields (`approved_doc_id`, `affirmed_by`, `affirmed_at`) together, once: the " +
        "version is recorded again, never edited after that. REFUSES ERROR: protocol.md at " +
        "this version is not approved — when the document does not exist, is not " +
        "status: approved, or does not quote this version's content_digest anywhere in its " +
        "body: a document approved for a DIFFERENT version of this protocol is not approved " +
        "for this one. Until it binds, evaluator_qualify and " +
        "evaluation_start refuse this version by name. A mutator: writes through the FR-59 idempotency ledger.",
      inputSchema: {
        protocol_version_id: z.string(),
        initiative: z.string().describe("The initiative protocol.md was written into."),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ protocol_version_id, initiative, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();
      const row = (await p.query<{ content_digest: string; affirmed: boolean }>(
        "select content_digest, approved_doc_id is not null as affirmed from zz.eval_protocol_version where id = $1::uuid",
        [protocol_version_id])).rows[0];
      if (!row) return text(`ERROR: unknown protocol_version_id ${protocol_version_id}`);

      // `initiative` is one path segment, never a nested path — `safePath` alone only keeps the
      // result inside the store, and "a/b" passes that check while naming no real initiative.
      const badInitiative = safeName(initiative, "initiative");
      if (badInitiative) return text(badInitiative);
      const path = `${initiative}/protocol.md`;
      const NOT_APPROVED =
        "ERROR: protocol.md at this version is not approved. Write it, put it to a person, and " +
        "call document_approve the moment they agree — then quote this version's content_digest " +
        `(${row.content_digest}) somewhere in the document's body before calling this again.`;
      const principal = parseCaller(requestHeaders()).email;
      const team = await teamFor(principal);
      // The document is read from the rows a document IS — `zz.doc` and the revision it points
      // at — never from a file. The affirmation names the document, not its path: `approved_doc_id`
      // is a row in `zz.doc` and the migration derived it from exactly this pair, and the digest
      // the version quotes is a claim about these bytes. A file the store has not caught up with
      // is refused here rather than affirmed as a claim with nothing behind it.
      const docRow = (await p.query<{
        id: string; current_revision: number | null; status: string;
        approved_by: string | null; body: string;
      }>(`
        select d.id::text as id, d.current_revision, d.status, a.email as approved_by,
               coalesce(r.body, d.body) as body
          from zz.doc d
          join zz.initiative i on i.id = d.initiative_id
          join zz.team t on t.id = i.team_id
          left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
          left join zz.principal a on a.id = r.approved_by
         where i.slug = $1 and d.path = 'protocol.md'
           and ($2::text is null or t.slug = $2)
         order by d.updated_at desc limit 1`, [initiative, team])).rows[0];
      if (!docRow) {
        return text(`ERROR: no approved ${path} is recorded for ${team ?? "this caller"}'s team — ` +
          "the document's own row has not reached the platform's index yet. Call document_approve " +
          "and then this again.");
      }
      if (docRow.status !== "approved") return text(NOT_APPROVED);
      if (!docRow.body.includes(row.content_digest)) return text(NOT_APPROVED);
      // AC-6.7: the affirmation pins the revision it read, so a row whose exact revision cannot
      // be resolved is refused BY NAME. Writing a null would read back as "no revision known",
      // while the truth is "this call did not record one" — and the version's own key would hold
      // the unpinned row as though it named a revision.
      if (docRow.current_revision === null) {
        return text(
          `ERROR: ${path} is approved, and its exact revision cannot be resolved — the document's ` +
          "row carries no current revision, so this affirmation would pin nothing and read back " +
          "as a revision nobody recorded. Nothing was written.");
      }
      if (row.affirmed) {
        return text(`ERROR: protocol version ${protocol_version_id} is already affirmed — a ` +
          "protocol version's payload and its affirmation are written once, and there is no path " +
          "that moves either again. Record the next version instead.");
      }
      const who = (await p.query<{ id: string }>(
        "select id::text as id from zz.principal where lower(email) = lower($1) limit 1",
        [principal])).rows[0];
      if (!who) return text(`ERROR: no zz.principal carries "${principal}", so this affirmation has nobody to name`);

      const outcome: IdempotencyOutcome<null> = await withIdempotency(
        principal, "protocol_affirm", idempotency_key, { protocol_version_id, initiative },
        async (client): Promise<MutatorOutcome<null>> => {
          // Guarded, not unconditional: the affirmation fields fill once, together, and a
          // concurrent call that got there first leaves this one with no row to move.
          //
          // COUPLED: `affirmProtocolVersion` writes `approved_doc_revision` beside the document
          // id — the pin AC-6.7 asks for, and the other half of the version's composite key. It
          // lives with `recordProtocolVersion` so both writes that name a document are in one
          // file.
          const moved = await affirmProtocolVersion(client, {
            protocolVersionId: protocol_version_id, contentDigest: row.content_digest,
            docId: docRow.id, docRevision: docRow.current_revision, affirmedBy: who.id,
          });
          if (moved !== 1) {
            throw new Refusal(`ERROR: protocol version ${protocol_version_id} was affirmed by ` +
              "another call before this one reached it — nothing was written again.");
          }
          return { result: null, result_table: "zz.eval_protocol_version", result_id: protocol_version_id };
        },
      );
      platformEvent({
        actor: principal, kind: "protocol_affirm", initiative, protocol_version_id, path, replayed: outcome.replayed,
      });
      // What evaluator_qualify now owes: every model-backed measure this version names.
      const owed = (await p.query<{ key: string }>(`
        select distinct m.key from zz.eval_measure m
         where m.protocol_version_id = $1::uuid and m.evaluator_type in ('bounded_semantic', 'generative_critic')
         order by m.key`, [protocol_version_id])).rows.map((r) => r.key);
      const recorded = await recordAffirmed(initiative, protocol_version_id, path, owed, row.content_digest);
      return json({ approved_document_path: path, approved_by: docRow.approved_by ?? null,
                    qualify_owed: owed, ...recorded });
    },
  );
}
