/**
 * The one write a `produces: "record"` stage of zz-plugin-eval makes into its initiative: the ids
 * it minted, under its own stage name (`_records.json`, initiative-record.ts). IDENTIFY, OBSERVE,
 * DISCOVER and EVALUATE produce no document, so without this a stage opened in a new
 * conversation had no tool that could hand it the subject, snapshot or eval run an earlier one
 * minted — and `initiative_status` could not tell which of them had run.
 *
 * Optional on every caller: a tool called with no `initiative` records nothing and answers as
 * before. A name that is not an opened initiative is not a refusal of the tool's own work, which
 * already happened — the reply carries `record_refused` instead.
 *
 * COUPLED: each caller passes the stage name catalog/zz/zz-plugin-eval/flow.json declares for it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { withInitiativeFactsLock, writeStageRecord } from "../initiative-record.js";
import { safeName, userRoot } from "../paths.js";

export async function recordStage(
  initiative: string | undefined, stage: string, ids: Record<string, string>,
): Promise<{ record_refused?: string }> {
  if (!initiative) return {};
  const bad = safeName(initiative, "initiative");
  if (bad) return { record_refused: bad };
  const root = await userRoot();
  if (!existsSync(join(root, initiative))) {
    return { record_refused: `no initiative named "${initiative}" in your team's store — call initiative_open first` };
  }
  // Read-merge-write: two stages recording into one initiative at once must not lose either.
  await withInitiativeFactsLock(initiative, async () => writeStageRecord(root, initiative, stage, ids));
  return {};
}
