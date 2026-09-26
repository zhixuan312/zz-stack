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
      host.evidenceRecord(kernelRunId, e.step_id,
                          { id: e.id, kind: e.kind, about: e.about, note: e.note, supersedes: e.supersedes });
    } catch (err) {
      unreplayable.push(`${e.id} at ${e.step_id}: ${err instanceof Error ? err.message : String(err)}`);
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

const escapeRegExp = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `waiver` covers the unmet sentence `sentence`: that step's own rule of that exact kind.
 *  COUPLED: the sentence shape is `unmetSentence`, packages/contracts/src/host.ts. */
function waiverCovers(waiver: StoredWaiver, sentence: string): boolean {
  return new RegExp(`^${escapeRegExp(waiver.step_id)} needs \\d+ ${escapeRegExp(waiver.kind)}( about a recorded .+)?$`)
    .test(sentence);
}

/** The predecessor-chain sentence `evaluate` writes: `"<before> has not completed, and <step>
 *  follows it"`. COUPLED: packages/contracts/src/host.ts, `evaluate`. */
const CHAIN_SENTENCE = /^(.+) has not completed, and (.+) follows it$/;

/** Whether everything that keeps `stepId` from completing is excused: each of its own unmet
 *  sentences is waived, and every predecessor it waits on is itself excused (or ruled out). The
 *  flat `unmet` list carries the whole trail — `evaluate` appends a predecessor's own sentences
 *  after its chain sentence — so a step's gaps are read back as its own `"<step> needs …"`
 *  sentences plus the chain sentences that end `"and <step> follows it"`. The graph is acyclic
 *  (`refuseCycle`, host.ts), so the recursion ends; `memo` keeps a fan-in linear. */
function stepExcused(
  stepId: string, unmet: readonly string[], waivers: readonly StoredWaiver[],
  ruledOutSteps: readonly string[], memo: Map<string, boolean>,
): boolean {
  if (ruledOutSteps.includes(stepId)) return true;
  const known = memo.get(stepId);
  if (known !== undefined) return known;
  let excused = true;
  for (const u of unmet) {
    const chain = CHAIN_SENTENCE.exec(u);
    if (chain) {
      if (chain[2] === stepId && !stepExcused(chain[1]!, unmet, waivers, ruledOutSteps, memo)) excused = false;
    } else if (u.startsWith(`${stepId} needs `) && !waivers.some((w) => waiverCovers(w, u))) {
      excused = false;
    }
    if (!excused) break;
  }
  memo.set(stepId, excused);
  return excused;
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
 *  every later step whose only outstanding reason is that ruled-out step.
 *
 *  A waiver covers exactly one sentence shape: its own step's `"<step_id> needs <n> <kind>"`,
 *  optionally followed by `" about a recorded <x>"`. Anchored at both ends of the kind, and on
 *  the step: a substring match let a waiver of kind `spec` cover `review needs 1 audit about a
 *  recorded spec`, kind `review` cover `ship needs 1 review_approval`, and a waiver signed for
 *  step A discharge step B's identical-kind gap carried up the predecessor chain — a signature
 *  standing for gaps nobody signed for.
 *
 *  A chain sentence is discharged once its predecessor is excused (`stepExcused`): a predecessor
 *  whose every gap is waived counts as completed, so the step after it is not held back by a
 *  sentence no waiver could ever match. A predecessor only partly waived still blocks. The chain
 *  sentence never enters `dischargedBy` — no waiver was signed for it; the ones that excused the
 *  predecessor are already there.
 *
 *  Exported for checks/store-waivers.ts. */
export function withWaivers(
  verdict: ControlVerdict, waivers: readonly StoredWaiver[], ruledOutSteps: readonly string[] = [],
): StandingVerdict {
  // A waiver that matches nothing is carried nowhere, so a stale waiver cannot make a real gap
  // look signed for.
  const covering = waivers.filter((w) => verdict.unmet.some((u) => waiverCovers(w, u)));
  const memo = new Map<string, boolean>();
  const afterWaivers = verdict.unmet.filter((u) => {
    if (waivers.some((w) => waiverCovers(w, u))) return false;
    const chain = CHAIN_SENTENCE.exec(u);
    return !(chain && stepExcused(chain[1]!, verdict.unmet, waivers, ruledOutSteps, memo));
  });
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
  return judgeClaim(run, module, await evidenceFor(run.id), await waiversFor(run.id),
                    stepId, action, ruledOutSteps);
}

/** `claimFor` once the run's facts are loaded: replay them, then claim.
 *
 *  A run whose history no longer replays in full is refused, naming each entry that did not
 *  replay. Judging the entries that did would answer for a shorter run than the one recorded,
 *  and a withdrawal among the dropped entries would leave standing what it withdrew.
 *
 *  Exported for scripts/gate/checks/host-chain.ts. */
export function judgeClaim(
  run: StoredRun, module: ReviewedModule, evidence: readonly (EvidenceEntry & { step_id: string })[],
  waivers: readonly StoredWaiver[], stepId: string, action: string,
  ruledOutSteps: readonly string[] = [],
): { grant: ActionGrant; standing: StandingVerdict } {
  const { host, kernelRunId, unreplayable } = rehydrate(run, module, evidence);
  if (unreplayable.length) {
    const unmet = unreplayable.map((u) => `recorded entry ${u}`);
    return {
      grant: { action, granted: false, refusal:
        `this run's history cannot be replayed in full against ${module.id} as registered now, ` +
        `and a verdict on the shorter history would judge a run that never happened — ` +
        `${unmet.length} recorded ${unmet.length === 1 ? "entry does" : "entries do"} not replay: ` +
        unmet.join("; ") },
      standing: { satisfied: false, unmet, dischargedBy: [], clear: false },
    };
  }
  const grant = host.actionClaim(kernelRunId, stepId, action);
  const standing = withWaivers(host.controlEvaluate(kernelRunId, stepId), waivers, ruledOutSteps);
  return { grant, standing };
}
