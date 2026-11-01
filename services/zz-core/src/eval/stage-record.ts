/**
 * The one write a `produces: "record"` stage of zz-plugin-eval makes into its initiative: the ids
 * it minted, under its own stage name (a `zz.initiative_record` row, initiative-record.ts).
 * IDENTIFY, OBSERVE, DISCOVER and EVALUATE produce no document, so this record is what hands a
 * stage opened in a new conversation the subject, snapshot or eval run an earlier one minted, and
 * what tells `initiative_status` which of them has run.
 *
 * A stage that produces a document can owe acts after its approval that no document records.
 * DEFINE/QUALIFY is that stage: protocol.md approved is not yet the protocol bound
 * (`protocol_affirm`) nor its evaluators qualified (`evaluator_qualify`), and EVALUATE refuses
 * until both. Its record names what it owes under `owes`, each act records its own key when it
 * lands, and `owedActs` (initiative-status.ts) is what routes to the first one missing.
 *
 * Optional on every caller: a tool called with no `initiative` records nothing and answers as
 * before. A name that is not an opened initiative is not a refusal of the tool's own work, which
 * already happened — the reply carries `record_refused` instead.
 *
 * COUPLED: each caller passes the stage name catalog/zz/zz-plugin-eval/flow.json declares for it.
 */
import type pg from "pg";

import { parseCaller } from "@zz/contracts";
import { requestHeaders } from "@zz/mcp-http";

import {
  initiativeIdFor, lockInitiativeFacts, recordsFor, withInitiativeFactsLock, writeStageRecord,
} from "../initiative-record.js";
import { safeName } from "../paths.js";
import { db, teamFor } from "../platform-db.js";

/** COUPLED: catalog/zz/zz-plugin-eval/flow.json's stage that produces protocol.md. */
const DEFINE_STAGE = "zz-plugin-define-qualify";
/** The keys DEFINE/QUALIFY's record owes after protocol.md is approved, in the order they are set: protocol_affirm
 *  sets the bound document's path, and evaluator_qualify the measures it qualified once the last owed one has a state.
 *  Named for what they hold, never for the tool that sets them, so no record key spells a tool. */
const DEFINE_OWES = ["affirmed_path", "qualified_measures"] as const;

async function located(initiative: string):
  Promise<{ p: pg.Pool; team: string; initiativeId: string } | { record_refused: string }> {
  const bad = safeName(initiative, "initiative");
  if (bad) return { record_refused: bad };
  const p = db();
  if (!p) return { record_refused: "no platform database — a stage record is a row, and there is nowhere to write one" };
  const team = await teamFor(parseCaller(requestHeaders()).email);
  if (!team) return { record_refused: "this caller resolves to no team, so the record has no initiative to be filed under" };
  const initiativeId = await initiativeIdFor(p, team, initiative);
  if (!initiativeId) {
    return { record_refused: `no initiative named "${initiative}" — call initiative_open first` };
  }
  return { p, team, initiativeId };
}

/** `work` on one connection in one transaction holding the initiative's facts lock across
 *  processes, under its in-process half (`withInitiativeFactsLock`): a stage's record is written
 *  whole or not at all. A replaced record is a delete and then an insert per key — written
 *  outside a transaction, a reader between them saw half a record, and a failure between them
 *  lost the record, so `owedActs` routed past the acts it owed. zz-core has no shared transaction
 *  helper; this is the shape `writeBranchFacts` (protocol.ts) writes. */
async function inRecordTransaction(
  p: pg.Pool, initiative: string, work: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  await withInitiativeFactsLock(initiative, async () => {
    const client = await p.connect();
    try {
      await client.query("BEGIN");
      await lockInitiativeFacts(client, initiative);
      await work(client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}

export async function recordStage(
  initiative: string | undefined, stage: string, ids: Record<string, string>, replace = false,
): Promise<{ record_refused?: string }> {
  if (!initiative) return {};
  const at = await located(initiative);
  if ("record_refused" in at) return at;
  // Read-merge-write: two stages recording into one initiative at once must not lose either.
  await inRecordTransaction(at.p, initiative, (client) => writeStageRecord(client, at.initiativeId, stage, ids, replace));
  return {};
}

/** protocol_read said create or revise: DEFINE/QUALIFY will owe the bind and the qualification
 *  once protocol.md is approved. The record is REPLACED: a revise means a new version, and the
 *  previous version's bind and qualifications discharge nothing for it — merged, they routed
 *  initiative_status straight past v3's affirm and qualification to EVALUATE. */
export async function recordDefineOwes(initiative: string | undefined): Promise<{ record_refused?: string }> {
  return recordStage(initiative, DEFINE_STAGE, { owes: DEFINE_OWES.join(",") }, true);
}

/** protocol_affirm bound `path` to this version. `qualifyOwed` is every model-backed measure key
 *  the version names — none owed discharges the qualification here and now. The record is
 *  REPLACED, so an earlier version's qualifications never count for this one, and it keeps the
 *  digest the bound document quoted: initiative_status reads protocol.md for it, and a document
 *  revised to quote a newer version owes the bind and the qualification again. A `replayed` call
 *  writes only what `affirmReplay` allows. */
export async function recordAffirmed(
  initiative: string, protocolVersionId: string, path: string, qualifyOwed: readonly string[],
  contentDigest: string, replayed: boolean,
): Promise<{ record_refused?: string }> {
  const ids = {
    owes: DEFINE_OWES.join(","), protocol_version_id: protocolVersionId, affirmed_path: path,
    affirmed_digest: contentDigest, qualify_owed: qualifyOwed.join(","),
    ...(qualifyOwed.length ? {} : { qualified_measures: "none owed" }),
  };
  if (!replayed) return recordStage(initiative, DEFINE_STAGE, ids, true);
  const at = await located(initiative);
  if ("record_refused" in at) return at;
  let refused: string | undefined;
  await inRecordTransaction(at.p, initiative, async (client) => {
    const replay = affirmReplay((await recordsFor(client, at.team, initiative))[DEFINE_STAGE] ?? {}, protocolVersionId);
    if (replay.write) await writeStageRecord(client, at.initiativeId, DEFINE_STAGE, ids, true);
    refused = replay.refused;
  });
  return refused ? { record_refused: refused } : {};
}

/** Whether a replayed protocol_affirm rewrites DEFINE/QUALIFY's record: only one that names no
 *  version yet. A record naming this version is kept — replaced, it would drop every qualification
 *  recorded since — and one naming another is a later bind that a late replay of an older version
 *  must not strand: kept, and said. Pure, so a check can drive it without a request. */
export function affirmReplay(
  held: Readonly<Record<string, string>>, protocolVersionId: string,
): { write: boolean; refused?: string } {
  if (!held.protocol_version_id) return { write: true };
  if (held.protocol_version_id === protocolVersionId) return { write: false };
  return { write: false, refused: `this initiative's DEFINE/QUALIFY record names protocol version ` +
    `${held.protocol_version_id}, and a replayed protocol_affirm of ${protocolVersionId} does not rewrite it` };
}

/** evaluator_qualify established `state` for one measure of this version. The qualification is
 *  discharged once every owed measure has a state — `unqualified` included: the state is the
 *  finding, and EVALUATE reads it. A measure of a version this initiative did not affirm is
 *  recorded nowhere. */
export async function recordQualified(
  initiative: string | undefined, protocolVersionId: string, measureKey: string, state: string,
): Promise<{ record_refused?: string }> {
  if (!initiative) return {};
  const at = await located(initiative);
  if ("record_refused" in at) return at;
  await inRecordTransaction(at.p, initiative, async (client) => {
    const records = await recordsFor(client, at.team, initiative);
    const update = qualifiedUpdate(records[DEFINE_STAGE] ?? {}, protocolVersionId, measureKey, state);
    if (update) await writeStageRecord(client, at.initiativeId, DEFINE_STAGE, update);
  });
  return {};
}

/** The keys `recordQualified` merges into DEFINE/QUALIFY's record — null for a version other
 *  than the one this initiative affirmed. Pure, so a check can drive it without a request. */
export function qualifiedUpdate(
  held: Readonly<Record<string, string>>, protocolVersionId: string, measureKey: string, state: string,
): Record<string, string> | null {
  if (held.protocol_version_id && held.protocol_version_id !== protocolVersionId) return null;
  const merged: Record<string, string> = { ...held, [`qualified.${measureKey}`]: state };
  const owed = (held.qualify_owed ?? "").split(",").filter(Boolean);
  const done = owed.length > 0 && owed.every((k) => merged[`qualified.${k}`]);
  return { [`qualified.${measureKey}`]: state, ...(done ? { qualified_measures: owed.join(",") } : {}) };
}
