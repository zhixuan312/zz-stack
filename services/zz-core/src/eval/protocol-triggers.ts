/**
 * protocol_read's own derivation (FR-4, FR-5): whether the newest protocol version a
 * plugin has is still the one to score against, computed from live state alone. `protocol_read`
 * takes only a `subject_version_id` — never a document, never a protocol body — so every trigger
 * below reads rows the platform already holds rather than anything a caller supplies this call.
 *
 * Four triggers, and any one of them turns `protocol_action` from `reuse` into `revise`:
 *   - `purpose_changed`   the plugin's own catalog manifest states a purpose that no longer
 *                         matches the protocol version's recorded `purpose`.
 *   - `new_recurring_failure`  DISCOVER has written a `zz.eval_failure_mode_sighting`
 *                         for this plugin's failure modes that no protocol version has folded in
 *                         yet. Folding one in is exactly what writes the `eval_protocol_failure_mode`
 *                         row (`protocol-record.ts`), so this reads as "unfolded lineage exists"
 *                         by construction — a sighting carries no mutable `status`.
 *   - `evaluator_drift`   a measure under the latest version defers to an evaluator version that
 *                         is no longer that evaluator's newest — `evaluators.ts` minted a later
 *                         one since this protocol version was recorded.
 *   - `new_evidence_surface`  a tool this plugin's own skills name today, and its door serves
 *                         (`ownTools`, as OBSERVE narrows it), is absent from the latest version's
 *                         `observable_surfaces` — the plugin's reachable surface grew since the
 *                         protocol was written.
 *
 * No protocol at all is not a trigger — it is `protocol_action = "create"`, decided by
 * `protocol.ts` before any of these run.
 */
import type pg from "pg";

import { doorSurface } from "./observe.js";
import { entryOf, servesOwnDoor, toolsNamedBy } from "./plugin-eval.js";
import { ownTools } from "./plugin-profile.js";

type Trigger = "purpose_changed" | "new_recurring_failure" | "evaluator_drift" | "new_evidence_surface";

/** The columns a trigger needs off the latest `zz.eval_protocol_version` row — never the whole
 *  row, so a column this file has no reason to touch is not threaded through it. */
interface LatestProtocolVersion {
  id: string;
  version: number;
  purpose: string;
  observable_surfaces: string[];
  /** Whether `protocol_affirm` bound an approved `protocol.md` to this version — the whole of
   *  what `approved_doc_id` says, read by `protocol_read`'s own answer. */
  affirmed: boolean;
  content_digest: string;
  /** Whether any version of this plugin's protocol was ever affirmed: an unaffirmed newest one
   *  is still the `create` its lineage began with when none was. */
  any_affirmed: boolean;
}

/** The newest version of this plugin's protocol lineage, or null when it has none. The plugin is
 *  the version's own `plugin_id`. */
export async function latestProtocolVersion(p: pg.Pool, pluginId: string): Promise<LatestProtocolVersion | null> {
  const row = (await p.query<LatestProtocolVersion>(`
    select epv.id::text as id, epv.version, epv.purpose, epv.observable_surfaces,
           epv.approved_doc_id is not null as affirmed, epv.content_digest,
           exists (select 1 from zz.eval_protocol_version a
                    where a.plugin_id = $1::uuid and a.approved_doc_id is not null) as any_affirmed
      from zz.eval_protocol_version epv
     where epv.plugin_id = $1::uuid
     order by epv.version desc limit 1`, [pluginId])).rows[0];
  return row ?? null;
}

/** Any failure-mode sighting of this plugin's that no protocol version has folded in yet —
 *  unfolded lineage, by construction: `protocol_record` writes the `eval_protocol_failure_mode`
 *  row that folds one in, and nothing else does. */
async function newRecurringFailure(p: pg.Pool, pluginId: string): Promise<boolean> {
  const row = (await p.query<{ n: string }>(`
    select count(*)::text as n
      from zz.eval_failure_mode_sighting s
      join zz.eval_failure_mode fm on fm.id = s.failure_mode_id
     where fm.plugin_id = $1::uuid
       and not exists (select 1 from zz.eval_protocol_failure_mode pfm
                         join zz.eval_protocol_version pv on pv.id = pfm.protocol_version_id
                        where pfm.failure_mode_id = fm.id and pv.plugin_id = $1::uuid)`,
    [pluginId])).rows[0];
  return Number(row?.n ?? 0) > 0;
}

/** A measure under this protocol version whose evaluator has since been superseded — a later
 *  version of the same `stable_key` now exists (`evaluators.ts`'s `registerEvaluator` mints one
 *  whenever a caller registers a changed definition), and this version still points at the old
 *  one. The identity is the version's own `stable_key`. */
async function evaluatorDrift(p: pg.Pool, protocolVersionId: string): Promise<boolean> {
  const row = (await p.query<{ n: string }>(`
    select count(*)::text as n
      from zz.eval_measure m
      join zz.eval_evaluator_version v on v.id = m.evaluator_version_id
     where m.protocol_version_id = $1::uuid
       and v.version < (
         select max(v2.version) from zz.eval_evaluator_version v2 where v2.stable_key = v.stable_key
       )`, [protocolVersionId])).rows[0];
  return Number(row?.n ?? 0) > 0;
}

/** Every trigger that fires for `plugin`'s latest protocol version, in the fixed order the
 *  contract lists them — empty means the version is still compatible, `protocol_action = reuse` —
 *  and the tools behind `new_evidence_surface`: which the version's surfaces lack, so the next
 *  version can add them rather than record the same surfaces again. */
export async function triggersFor(
  p: pg.Pool, pluginId: string, plugin: string, version: string, latest: LatestProtocolVersion,
): Promise<{ fired: Trigger[]; missingSurfaces: string[] }> {
  const fired: Trigger[] = [];
  const entry = entryOf(plugin);
  const entryPurpose = entry?.manifest.purpose;
  if (entryPurpose && entryPurpose !== latest.purpose) fired.push("purpose_changed");
  if (await newRecurringFailure(p, pluginId)) fired.push("new_recurring_failure");
  if (await evaluatorDrift(p, latest.id)) fired.push("evaluator_drift");
  const surfaces = new Set(latest.observable_surfaces ?? []);
  const surface = await doorSurface(p, plugin, version, servesOwnDoor(plugin, entry));
  const missingSurfaces = ownTools(toolsNamedBy(plugin, entry), surface.tools).filter((n) => !surfaces.has(n));
  if (missingSurfaces.length) fired.push("new_evidence_surface");
  return { fired, missingSurfaces };
}
