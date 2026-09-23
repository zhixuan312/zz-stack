/**
 * The durable half of the control loop: where a run's evidence lives between processes.
 *
 * THE KERNEL IS REHYDRATED, NEVER PERSISTED. `createHost()` holds runs in a `Map` and numbers
 * them from a counter that restarts with the process. That is correct for what it is — it
 * performs no I/O, which is why it can live in `@zz/contracts` at all and why FR-23 ("the
 * generic kernel/host must not embed SDLC semantics") stays satisfiable. An initiative,
 * meanwhile, spans days and several deployments. So this file holds the facts and replays
 * them: load the run and its evidence in recorded order, build a host, register the module,
 * `runStart`, replay each entry, then ask the question. The host that answers is seconds old;
 * what it was told is as old as the initiative.
 *
 * The platform's run id is the durable one and the kernel's is scratch. Making the kernel
 * accept an injected id would put persistence into the contract, which is the seam this
 * design exists to keep.
 *
 * A WAIVER IS NOT EVIDENCE, AND THIS FILE REFUSES TO TURN ONE INTO EVIDENCE.
 *
 * The engine's `evaluate` reads `step.completion` against `run.evidence` and knows nothing
 * about waivers — `EntryWaiver` belongs to `admitEntry`, a different question in a different
 * module. The tempting shortcut is to record a waiver AS an evidence entry of the kind that
 * is missing, which would satisfy the rule and make the verdict green. It would also put an
 * entry in the log saying an audit exists when no audit happened, and a record that says a
 * stage ran when it did not is what FR-28 and FR-29 forbid.
 *
 * So the kernel keeps telling the truth — it reports the requirement unmet — and this file
 * reports, beside that truth, that somebody signed for the gap and on what ground. The verdict
 * a caller receives carries both: what is missing, and who accepted its absence. A reader can
 * always tell a step that was done from a step that was excused, which is the whole point.
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
 *  never empty: a waiver without one is an exemption, and an exemption is a hole somebody cut
 *  rather than a hole somebody signed for. */
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
 *  proceed, given both what was proved and what was signed for. Three fields rather than one
 *  because collapsing them is exactly how "we excused it" becomes indistinguishable from "it
 *  was done", and a reader six months later cannot recover the difference. */
interface StandingVerdict {
  readonly satisfied: boolean;
  readonly unmet: readonly string[];
  readonly dischargedBy: readonly StoredWaiver[];
  readonly clear: boolean;
}

/** Open a run for an initiative, or return the one already open.
 *
 *  IDEMPOTENT BY CONSTRAINT, not by a read-then-write that two requests can interleave. The
 *  unique key is (team, initiative) because an initiative IS one run of the flow governing it;
 *  two runs would mean two answers to "may this close", which is the duplication this adoption
 *  removes rather than adds. */
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
    // `recorded_at` IS WRITTEN RATHER THAN DEFAULTED, and that is not ceremony. The column
    // carries `default now()`, so leaving it out would still populate it — but a reader of
    // this statement could not tell whether the platform decides that value or the database
    // does, and one of this repository's own checks asks exactly that question of every
    // column it enforces. Saying it here answers it in the place somebody looks.
    `insert into zz.control_evidence
       (run_id, entry_id, step_id, kind, about, note, supersedes, recorded_at, recorded_by)
     values ($1,$2,$3,$4,$5,$6,$7, now(), $8)`,
    [runId, entry.id, stepId, entry.kind, entry.about, entry.note ?? "",
     // NULL RATHER THAN THE EMPTY STRING, because `met()` asks whether an id is in the set of
     // withdrawn ids and an empty string is an id nothing has. The same distinction the
     // step-trace column had to learn: two spellings of nothing where one is indexed.
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
 * ORDER IS `seq`, NOT `recorded_at`. Two entries written inside one transaction share a
 * timestamp, and a replay that reordered them would be judging a run that never happened.
 *
 * A REPLAY THAT DROPS AN ENTRY IS WORSE THAN ONE THAT THROWS. `evidenceRecord` refuses a kind
 * the step does not accept, which is right when a caller is recording something new and wrong
 * when we are replaying something already recorded: the module's body can move between the
 * day an entry was written and the day it is replayed. So a rejected entry is collected and
 * returned rather than swallowed — the caller is told the run can no longer be reconstructed
 * against the module it now has, instead of receiving a verdict about a shorter history.
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
  // `supersedes` RIDES BACK WITH THE REST. A rehydration that dropped it would rebuild a run
  // whose withdrawals never happened — every verdict computed from the full history instead of
  // from what still stands, and the column would be written, indexed and read by nothing.
  return rows.map((r: Record<string, string | null>) =>
    ({ id: String(r.id), stepId: String(r.step_id), step_id: String(r.step_id),
       kind: String(r.kind), about: String(r.about), note: String(r.note ?? ""),
       supersedes: r.supersedes ?? undefined }));
}

/** Read a verdict together with the waivers that cover it. Exported because the same reading
 *  is owed wherever a refusal is turned into an answer, and two copies of it would be two
 *  opinions about what "clear" means. */
function withWaivers(
  verdict: ControlVerdict, waivers: readonly StoredWaiver[],
): StandingVerdict {
  // A WAIVER COVERS AN UNMET SENTENCE BY NAMING ITS KIND. The engine's `unmet` is prose for a
  // person deciding what to record next, so this matches on the kind appearing in it rather
  // than parsing a shape the engine deliberately does not promise. A waiver that matches
  // nothing is carried nowhere: it neither clears anything nor disappears, it simply was not
  // needed, and saying otherwise would let a stale waiver make a real gap look signed for.
  const covering = waivers.filter((w) => verdict.unmet.some((u) => u.includes(w.kind)));
  const stillOpen = verdict.unmet.filter((u) => !waivers.some((w) => u.includes(w.kind)));
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
 * A REFUSAL IS A RESULT, NOT A FAULT — the engine's own comment, and it governs here. Being
 * told what is still missing is the normal path through a control loop.
 *
 * Null means NO RUN IS OPEN, which is not the same as a refusal and must not be collapsed into
 * one. A caller deciding what to do about an un-enrolled initiative is answering a different
 * question from a caller deciding what to record next.
 */
export async function claimFor(
  team: string, initiative: string, module: ReviewedModule, stepId: string, action: string,
): Promise<{ grant: ActionGrant; standing: StandingVerdict } | null> {
  const run = await runFor(team, initiative);
  if (!run) return null;
  const { host, kernelRunId } = rehydrate(run, module, await evidenceFor(run.id));
  const grant = host.actionClaim(kernelRunId, stepId, action);
  const standing = withWaivers(host.controlEvaluate(kernelRunId, stepId), await waiversFor(run.id));
  return { grant, standing };
}
