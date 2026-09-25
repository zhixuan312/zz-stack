/**
 * The durable half of the control loop: where a run's evidence lives between processes.
 *
 * The kernel is rehydrated, never persisted. `createHost()` holds runs in a `Map` and numbers
 * them from a counter that restarts with the process; it performs no I/O, which is why it can
 * live in `@zz/contracts`. An initiative spans days and several deployments, so this file holds
 * the facts and replays them: load the run and its evidence in recorded order, build a host,
 * register the module, `runStart`, replay each entry, then ask the question.
 *
 * DELIBERATE: the platform's run id is the durable one and the kernel's is scratch. Making the
 * kernel accept an injected id would put persistence into the contract.
 *
 * DELIBERATE: a waiver is never recorded as evidence. The engine's `evaluate` reads
 * `step.completion` against `run.evidence` and knows nothing about waivers; recording a waiver
 * as an entry of the missing kind would make the verdict green and put an entry in the log
 * saying an audit exists when no audit happened. So the kernel reports the
 * requirement unmet and this file reports, beside that, that somebody signed for the gap and on
 * what ground. A reader can always tell a step that was done from a step that was excused.
 */
import { createHost, type ActionGrant, type ControlVerdict, type EvidenceEntry,
         type Host, type ReviewedModule } from "@zz/contracts";

import { db as db_ } from "../platform-db.js";

/** A run as the platform holds it: the durable identity, and what the run was judged against
 *  at the time rather than what the allowlist says today. */
interface StoredRun {
  readonly id: string;
  readonly team_slug: string;
  readonly initiative: string;
  readonly module_id: string;
  readonly module_digest: string;
  readonly subject: string;
  readonly profile: readonly string[];
}

/** One requirement a person accepted the absence of, and the ground they gave. `ground` is
 *  never empty: a waiver without one is an exemption rather than a signature. */
interface StoredWaiver {
  readonly step_id: string;
  readonly kind: string;
  readonly ground: string;
  readonly recorded_by: string | null;
}

/** What a caller gets back: the engine's own verdict, unchanged, plus what was excused.
 *
 *  `satisfied` is the engine's answer and stays the engine's answer. `dischargedBy` names the
 *  waivers covering something in `unmet`, and `clear` is the two read together — may this
 *  proceed, given both what was proved and what was signed for. Three fields rather than one,
 *  because collapsing them makes "we excused it" indistinguishable from "it was done". */
interface StandingVerdict {
  readonly satisfied: boolean;
  readonly unmet: readonly string[];
  readonly dischargedBy: readonly StoredWaiver[];
  readonly clear: boolean;
}

/** Open a run for an initiative, or return the one already open.
 *
 *  Idempotent by constraint, not by a read-then-write that two requests can interleave. The
 *  unique key is (team, initiative), because an initiative is one run of the flow governing it
 *  and two runs would mean two answers to "may this close". */
export async function openRun(r: {
  team: string; initiative: string; module: ReviewedModule; digest: string;
  subject: string; profile: readonly string[]; by: string | null;
}): Promise<string | null> {
  const db = db_();
  if (!db) return null;
  const { rows } = await db.query(
    `insert into zz.control_run
       (team_slug, initiative, module_id, module_digest, subject, profile, started_by)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7)
     on conflict (team_slug, initiative) do update set team_slug = excluded.team_slug
     returning id`,
    [r.team, r.initiative, r.module.id, r.digest, r.subject,
     JSON.stringify(r.profile), r.by],
  );
  return rows[0]?.id ?? null;
}

/** The run governing one initiative, or null where none was ever opened. */
export async function runFor(team: string, initiative: string): Promise<StoredRun | null> {
  const db = db_();
  if (!db) return null;
  const { rows } = await db.query(
    `select id, team_slug, initiative, module_id, module_digest, subject, profile
       from zz.control_run where team_slug = $1 and initiative = $2`,
    [team, initiative],
  );
  const row = rows[0];
  if (!row) return null;
  return { ...row, profile: Array.isArray(row.profile) ? row.profile : [] } as StoredRun;
}

/** Append one piece of evidence. Append-only: nothing here edits or deletes a recorded fact,
 *  because a run's history is the thing being judged. */
export async function recordEvidence(
  runId: string, stepId: string, entry: EvidenceEntry, by: string | null,
): Promise<void> {
  const db = db_();
  if (!db) return;
  await db.query(
    // `recorded_at` is written rather than defaulted: the column carries `default now()`, so
    // leaving it out would still populate it, and a reader of this statement could not tell
    // whether the platform or the database decides the value.
    `insert into zz.control_evidence
       (run_id, entry_id, step_id, kind, about, note, supersedes, recorded_at, recorded_by)
     values ($1,$2,$3,$4,$5,$6,$7, now(), $8)`,
    [runId, entry.id, stepId, entry.kind, entry.about, entry.note ?? "",
     // Null rather than the empty string, because `met()` asks whether an id is in the set of
     // withdrawn ids and an empty string is an id nothing has.
     entry.supersedes || null, by],
  );
}

async function waiversFor(runId: string): Promise<StoredWaiver[]> {
  const db = db_();
  if (!db) return [];
  const { rows } = await db.query(
    `select step_id, kind, ground, recorded_by from zz.control_waiver
      where run_id = $1 order by seq`, [runId]);
  return rows as StoredWaiver[];
}

/**
 * Build a host that has been told everything this run was told, in the order it was told.
 *
 * Order is `seq`, not `recorded_at`: two entries written inside one transaction share a
 * timestamp, and a replay that reordered them would be judging a run that never happened.
 *
 * `evidenceRecord` refuses a kind the step does not accept, which is right for a new recording
 * and wrong for a replay, because the module's body can move between the day an entry was
 * written and the day it is replayed. So a rejected entry is collected and returned rather than
 * swallowed: the caller is told the run can no longer be reconstructed against the module it
 * now has, instead of receiving a verdict about a shorter history.
 */
function rehydrate(
  run: StoredRun, module: ReviewedModule, evidence: readonly (EvidenceEntry & { step_id: string })[],
): { host: Host; kernelRunId: string; unreplayable: string[] } {
  const host = createHost();
  host.register(module);
  const kernelRunId = host.runStart(module.id, { subject: run.subject, profile: [...run.profile] });
  const unreplayable: string[] = [];
  for (const e of evidence) {
    try {
      host.evidenceRecord(kernelRunId, e.step_id, { id: e.id, kind: e.kind, about: e.about, note: e.note });
    } catch (err) {
      unreplayable.push(`${e.step_id}/${e.kind}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { host, kernelRunId, unreplayable };
}

async function evidenceFor(runId: string): Promise<(EvidenceEntry & { step_id: string })[]> {
  const db = db_();
  if (!db) return [];
  const { rows } = await db.query(
    `select entry_id as id, step_id, kind, about, note, supersedes from zz.control_evidence
      where run_id = $1 order by seq`, [runId]);
  // `supersedes` rides back with the rest: a rehydration that dropped it would rebuild a run
  // whose withdrawals never happened, every verdict computed from the full history instead of
  // from what still stands.
  return rows.map((r: Record<string, string | null>) =>
    ({ id: String(r.id), stepId: String(r.step_id), step_id: String(r.step_id),
       kind: String(r.kind), about: String(r.about), note: String(r.note ?? ""),
       supersedes: r.supersedes ?? undefined }));
}

/** Read a verdict together with the waivers that cover it, and the steps a document's own
 *  branch applicability has already ruled out (FR-58, Task I-27) — the one reading of "clear",
 *  owed wherever a refusal is turned into an answer.
 *
 *  `ruledOutSteps` is never folded into `dischargedBy`: a waiver is somebody's signature on a
 *  ground they gave, and a step the branch ruled `not_applicable` was never signed for by
 *  anybody — the branch decided it before a person was ever asked. Kept apart so a reader of
 *  `dischargedBy` sees only what was actually excused, not what the platform itself answered.
 *
 *  `unmetSentence` (host.ts) always opens with the step id it is about — `"${stepId} needs …"`,
 *  and the predecessor-chain sentence `evaluate` prepends opens with the PREDECESSOR's id for
 *  the same reason — so a prefix match is exact and covers both the step's own unmet rule and
 *  every later step whose only outstanding reason is that ruled-out step. */
function withWaivers(
  verdict: ControlVerdict, waivers: readonly StoredWaiver[], ruledOutSteps: readonly string[] = [],
): StandingVerdict {
  // A waiver covers an unmet sentence by naming its kind. The engine's `unmet` is prose for a
  // person deciding what to record next, so this matches on the kind appearing in it rather
  // than parsing a shape the engine does not promise. A waiver that matches nothing is carried
  // nowhere, so a stale waiver cannot make a real gap look signed for.
  const covering = waivers.filter((w) => verdict.unmet.some((u) => u.includes(w.kind)));
  const afterWaivers = verdict.unmet.filter((u) => !waivers.some((w) => u.includes(w.kind)));
  const stillOpen = afterWaivers.filter((u) => !ruledOutSteps.some((id) => u.startsWith(`${id} `)));
  return {
    satisfied: verdict.satisfied,
    unmet: verdict.unmet,
    dischargedBy: covering,
    clear: verdict.satisfied || stillOpen.length === 0,
  };
}

/**
 * Claim an action for an initiative's run: the grant, read together with what was excused.
 *
 * A refusal is a result, not a fault: being told what is still missing is the normal path
 * through a control loop.
 *
 * Null means no run is open, which is not a refusal and must not be collapsed into one. A
 * caller deciding what to do about an un-enrolled initiative is answering a different question
 * from one deciding what to record next.
 *
 * `ruledOutSteps` (FR-58, Task I-27): step ids whose own document a caller has already found
 * `not_applicable` on this initiative's own branch (`documentApplies`, packages/contracts/src/
 * flow-when.js) — never computed here, because this file holds no facts and no manifest, only
 * the run. The caller (initiative-close.ts) reads a step's document from `FlowDoc.stage`, the
 * same convention `stageIndex` in the console's `shared.ts` already draws on, and passes the
 * ones every one of whose documents came back `not_applicable`. A step this run's evidence
 * genuinely satisfies is unaffected either way — `withWaivers` only discharges what is still
 * `unmet`. */
export async function claimFor(
  team: string, initiative: string, module: ReviewedModule, stepId: string, action: string,
  ruledOutSteps: readonly string[] = [],
): Promise<{ grant: ActionGrant; standing: StandingVerdict } | null> {
  const run = await runFor(team, initiative);
  if (!run) return null;
  const { host, kernelRunId } = rehydrate(run, module, await evidenceFor(run.id));
  const grant = host.actionClaim(kernelRunId, stepId, action);
  const standing = withWaivers(
    host.controlEvaluate(kernelRunId, stepId), await waiversFor(run.id), ruledOutSteps);
  return { grant, standing };
}
