/**
 * The one write a `produces: "record"` stage of zz-plugin-eval makes into its initiative: the ids
 * it minted, under its own stage name (`_records.json`, initiative-record.ts). IDENTIFY, OBSERVE,
 * DISCOVER and EVALUATE produce no document, so without this a stage opened in a new
 * conversation had no tool that could hand it the subject, snapshot or eval run an earlier one
 * minted — and `initiative_status` could not tell which of them had run.
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
import { existsSync } from "node:fs";
import { join } from "node:path";

import { recordsFor, withInitiativeFactsLock, writeStageRecord } from "../initiative-record.js";
import { safeName, userRoot } from "../paths.js";

/** COUPLED: catalog/zz/zz-plugin-eval/flow.json's stage that produces protocol.md. */
const DEFINE_STAGE = "zz-plugin-define-qualify";
/** The acts DEFINE/QUALIFY owes after protocol.md is approved, in the order they run. */
const DEFINE_OWES = ["protocol_affirm", "evaluator_qualify"] as const;

async function located(initiative: string): Promise<{ root: string } | { record_refused: string }> {
  const bad = safeName(initiative, "initiative");
  if (bad) return { record_refused: bad };
  const root = await userRoot();
  if (!existsSync(join(root, initiative))) {
    return { record_refused: `no initiative named "${initiative}" in your team's store — call initiative_open first` };
  }
  return { root };
}

export async function recordStage(
  initiative: string | undefined, stage: string, ids: Record<string, string>,
): Promise<{ record_refused?: string }> {
  if (!initiative) return {};
  const at = await located(initiative);
  if ("record_refused" in at) return at;
  // Read-merge-write: two stages recording into one initiative at once must not lose either.
  await withInitiativeFactsLock(initiative, async () => writeStageRecord(at.root, initiative, stage, ids));
  return {};
}

/** protocol_read said create or revise: DEFINE/QUALIFY will owe the bind and the qualification
 *  once protocol.md is approved. */
export async function recordDefineOwes(initiative: string | undefined): Promise<{ record_refused?: string }> {
  return recordStage(initiative, DEFINE_STAGE, { owes: DEFINE_OWES.join(",") });
}

/** protocol_affirm bound `path` to this version. `qualifyOwed` is every model-backed measure key
 *  the version names — none owed discharges the qualification here and now. */
export async function recordAffirmed(
  initiative: string, protocolVersionId: string, path: string, qualifyOwed: readonly string[],
): Promise<{ record_refused?: string }> {
  return recordStage(initiative, DEFINE_STAGE, {
    owes: DEFINE_OWES.join(","), protocol_version_id: protocolVersionId, protocol_affirm: path,
    qualify_owed: qualifyOwed.join(","),
    ...(qualifyOwed.length ? {} : { evaluator_qualify: "none owed" }),
  });
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
  await withInitiativeFactsLock(initiative, async () => {
    const update = qualifiedUpdate(recordsFor(at.root, initiative)[DEFINE_STAGE] ?? {}, protocolVersionId, measureKey, state);
    if (update) writeStageRecord(at.root, initiative, DEFINE_STAGE, update);
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
  return { [`qualified.${measureKey}`]: state, ...(done ? { evaluator_qualify: owed.join(",") } : {}) };
}
