/**
 * protocol_read's own derivation (FR-4, FR-5, Task I-10): whether the newest protocol version a
 * plugin has is still the one to score against, computed from live state alone. `protocol_read`
 * takes only a `subject_version_id` — never a document, never a protocol body — so every trigger
 * below reads rows the platform already holds rather than anything a caller supplies this call.
 *
 * Four triggers, and any one of them turns `protocol_action` from `reuse` into `revise`:
 *   - `purpose_changed`   the plugin's own catalog manifest states a purpose that no longer
 *                         matches the protocol version's recorded `purpose`.
 *   - `new_recurring_failure`  DISCOVER (Task I-9) has written a `zz.eval_failure_mode_candidate`
 *                         row for this plugin that is still `status = 'candidate'` — nothing has
 *                         folded it into a protocol's `failure_taxonomy` yet. Folding one in is
 *                         exactly what flips its status away from `candidate` (`protocol-record.ts`),
 *                         so this reads as "unfolded lineage exists" by construction.
 *   - `evaluator_drift`   a measure under the latest version defers to an evaluator version that
 *                         is no longer that evaluator's newest — `evaluators.ts` minted a later
 *                         one since this protocol version was recorded.
 *   - `new_evidence_surface`  a tool this plugin's own skills name today is absent from the
 *                         latest version's `observable_surfaces` — the plugin's reachable surface
 *                         grew since the protocol was written.
 *
 * No protocol at all is not a trigger — it is `protocol_action = "create"`, decided by
 * `protocol.ts` before any of these run.
 */
import type pg from "pg";

import { entryOf, toolsNamedBy } from "./plugin-eval.js";

type Trigger = "purpose_changed" | "new_recurring_failure" | "evaluator_drift" | "new_evidence_surface";

/** The columns a trigger needs off the latest `zz.eval_protocol_version` row — never the whole
 *  row, so a column this file has no reason to touch is not threaded through it. */
interface LatestProtocolVersion {
  id: string;
  version: number;
  purpose: string;
  observable_surfaces: string[];
  /** Null until `protocol_affirm` binds an approved protocol.md — protocol_read's own answer. */
  approved_document_path: string | null;
  content_digest: string;
  /** Whether any version of this plugin's protocol was ever affirmed: an unaffirmed newest one
   *  is still the `create` its lineage began with when none was. */
  any_affirmed: boolean;
}

export async function latestProtocolVersion(p: pg.Pool, pluginId: string): Promise<LatestProtocolVersion | null> {
  const row = (await p.query<LatestProtocolVersion>(`
    select epv.id::text as id, epv.version, epv.purpose, epv.observable_surfaces,
           epv.approved_document_path, epv.content_digest,
           exists (select 1 from zz.eval_protocol_version a join zz.eval_protocol ap on ap.id = a.protocol_id
                    where ap.plugin_id = $1::uuid and a.approved_document_path is not null) as any_affirmed
      from zz.eval_protocol_version epv
      join zz.eval_protocol ep on ep.id = epv.protocol_id
     where ep.plugin_id = $1::uuid
     order by epv.version desc limit 1`, [pluginId])).rows[0];
  return row ?? null;
}

/** Any DISCOVER candidate on this plugin still waiting to be folded in. Status flips away from
 *  `candidate` only when `protocol_record` accepts or merges it (see this file's header), so a
 *  row found here by construction names lineage no protocol version has read yet. */
async function newRecurringFailure(p: pg.Pool, pluginId: string): Promise<boolean> {
  const row = (await p.query<{ n: string }>(`
    select count(*)::text as n
      from zz.eval_failure_mode_candidate c
      join zz.eval_observation_snapshot os on os.id = c.observation_snapshot_id
      join zz.eval_subject_version sv on sv.id = os.subject_version_id
     where sv.plugin_id = $1::uuid and c.status = 'candidate'`, [pluginId])).rows[0];
  return Number(row?.n ?? 0) > 0;
}

/** A measure under this protocol version whose evaluator has since been superseded — a later
 *  version of the same `stable_key` now exists (`evaluators.ts`'s `registerEvaluator` mints one
 *  whenever a caller registers a changed definition), and this version still points at the old
 *  one. */
async function evaluatorDrift(p: pg.Pool, protocolVersionId: string): Promise<boolean> {
  const row = (await p.query<{ n: string }>(`
    select count(*)::text as n
      from zz.eval_measure m
      join zz.eval_dimension d on d.id = m.dimension_id
      join zz.eval_evaluator_version v on v.id = m.evaluator_version_id
     where d.protocol_version_id = $1::uuid
       and v.version < (
         select max(v2.version) from zz.eval_evaluator_version v2 where v2.evaluator_id = v.evaluator_id
       )`, [protocolVersionId])).rows[0];
  return Number(row?.n ?? 0) > 0;
}

/** Every trigger that fires for `plugin`'s latest protocol version, in the fixed order the
 *  contract lists them. Empty means the version is still compatible — `protocol_action = reuse`. */
export async function triggersFor(
  p: pg.Pool, pluginId: string, plugin: string, latest: LatestProtocolVersion,
): Promise<Trigger[]> {
  const fired: Trigger[] = [];
  const entryPurpose = entryOf(plugin)?.manifest.purpose;
  if (entryPurpose && entryPurpose !== latest.purpose) fired.push("purpose_changed");
  if (await newRecurringFailure(p, pluginId)) fired.push("new_recurring_failure");
  if (await evaluatorDrift(p, latest.id)) fired.push("evaluator_drift");
  const named = toolsNamedBy(plugin);
  const surfaces = new Set(latest.observable_surfaces ?? []);
  if (named.some((n) => !surfaces.has(n))) fired.push("new_evidence_surface");
  return fired;
}
