/**
 * DISCOVER (FR-11, Task I-9): mining real, recorded failures into candidate failure modes
 * before any protocol exists. `failure_discover(observation_snapshot_id)` reads one immutable
 * `zz.eval_observation_snapshot` (OBSERVE, Task I-7) and writes durable
 * `zz.eval_failure_mode_candidate` rows — never a judgement about whether a candidate is real,
 * only a recorded proposal `status = 'candidate'` starts at. Only `protocol_record`, later, may
 * move one to `accepted`/`merged` (see the plan's own boundary: final deliverable content is not
 * in this plan).
 *
 * Two passes over the evidence, both in `discover-groups.ts`:
 *   - deterministic grouping first, over refusal text/owner/failing tool and over stage-return
 *     patterns — pure arithmetic, no model touches it;
 *   - each group's representative evidence then goes to ONE registered evaluator,
 *     `discover.owner_kind` (a `choice` over `EVAL_STATE_ENUMS.ownerKind`), through
 *     `recordEvaluatorAssessment` directly — this file already holds the `evaluator_version_id`
 *     it needs, so it has no reason to go through `evaluators.ts`'s `askEvaluator` wrapper.
 *
 * A refusal group with no recorded text at all is the one shape the deterministic pass cannot
 * describe — for that, and only that, ONE generative-critic call proposes the description,
 * through `judge.ts`'s `ask()` (the platform's one existing way to reach a larger model outside
 * the typed service — the same reading judge `judge.ts`/`judge-thresholds.ts` fall back to),
 * recorded in `zz.model_call` under its own `purpose` and, on the candidate itself, under
 * `evidence_refs.description_source`.
 *
 * Where this platform registers its own built-in evaluators (this task's own choice, recorded
 * here because nothing else asked the question yet): inline, at the top of this handler, one
 * `registerEvaluator` call per request. `evaluators.ts`'s own header already prescribes this —
 * "a caller defines its evaluator once, in code, and calls this at the point it needs an
 * evaluator_version_id; there is no separate seeding step" — and `registerEvaluator` is
 * idempotent by content digest, so calling it on every `failure_discover` request costs one
 * upsert-and-read-back and never mints a second version of the same question.
 *
 * Errors: a model outage (typed-judgement transport failure, or the reading judge unreachable)
 * never drops a candidate — it is stored with `owner_kind = 'unknown'` and the failure's own
 * reason, folded into `evidence_refs` (migration 077 gives this table no separate reason column,
 * and the contract's own response shape has none either). After the FIRST such outage from
 * either model in one run, every remaining group of that kind is answered `unknown` WITHOUT a
 * second call to `recordEvaluatorAssessment` — so only the group that hit the outage carries a
 * real `zz.assessment` row for `discover.owner_kind`; every later group in the same run carries
 * none, and its only record of the classification is the `not asked: …` reason inside its own
 * `evidence_refs.ownership`. DELIBERATE, and a real narrowing of "each ownership classification
 * is one registered bounded-semantic evaluator answer recorded through
 * `recordEvaluatorAssessment`" for exactly this one case: `judge.ts`'s `ask()` and
 * `typed-service.ts`'s `ask()` each carry up to a ~100s budget per call, and something between
 * this tool and its caller closes the request at about two minutes — asking N more times against
 * an endpoint already known to be down would spend that budget once per remaining group and
 * return nothing at all, which is the one way this function actually could drop a candidate.
 * Every candidate is still persisted with an owner_kind and a reason either way; what a known-bad
 * endpoint costs is the recorded evaluator row for groups after the first, not the candidate.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EVAL_STATE_ENUMS, parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { entryOf, servesOwnDoor, toolsNamedBy } from "./plugin-eval.js";
import { pluginTraces, type EvidenceWindow } from "./plugin-profile.js";
import {
  refusalGroups, returnGroups, totalToolCallEvents, totalStepVisits,
  type RefusalGroup, type ReturnGroup,
} from "./discover-groups.js";
import { registerEvaluator, type EvaluatorDefinition } from "./evaluators.js";
import { ask } from "./judge.js";
import { JUDGE_MODEL } from "./judge-model.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { recordEvaluatorAssessment } from "../semantic.js";
import { NOT_CONFIGURED } from "../typed-service.js";
import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { Refusal } from "../refusal.js";
import { db } from "../platform-db.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no failure discovery can be recorded");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `zz.eval_failure_mode_candidate.status` this tool ever writes — every row DISCOVER mints
 *  starts here, and only `protocol_record` (a later task) may move one on. Checked against the
 *  contract's own vocabulary at import rather than assumed, the same guard
 *  `semantic.ts`'s `FAMILY_INSTRUCTIONS` loop applies to its own vocabulary. */
const CANDIDATE_STATUS = "candidate";
if (!(EVAL_STATE_ENUMS.failureCandidateStatus as readonly string[]).includes(CANDIDATE_STATUS)) {
  throw new Error(`"${CANDIDATE_STATUS}" is not in EVAL_STATE_ENUMS.failureCandidateStatus`);
}

/** What each `owner_kind` option means, read to the evaluator as its `choice` criteria —
 *  `EVAL_STATE_ENUMS.ownerKind` is the vocabulary, this is the prose, and the loop below is the
 *  same "every value the source of truth declares has an instruction" guard `semantic.ts` runs
 *  over `QUESTION_FAMILIES`. */
const OWNER_KIND_MEANING: Readonly<Record<string, string>> = Object.freeze({
  plugin: "this plugin's own skill, prompt or tool-use logic caused it",
  dependency: "an external service or API this plugin depends on caused it, underneath the platform",
  platform: "the ZZ platform itself (a core door, a shared tool, the gateway) caused it",
  environment: "the deployment environment caused it — missing configuration, no database, no credentials",
  user_input: "the person or agent calling this plugin supplied bad or incomplete input",
  unknown: "the evidence given does not say whose fault this is",
});
for (const k of EVAL_STATE_ENUMS.ownerKind) {
  if (!OWNER_KIND_MEANING[k]) throw new Error(`discover.owner_kind evaluator has no meaning for owner_kind "${k}"`);
}

/** The one evaluator this task defines (FR-13, FR-15): a `choice` over exactly
 *  `EVAL_STATE_ENUMS.ownerKind`, so its answer is in this table's vocabulary by construction —
 *  `recordEvaluatorAssessment` cannot return an option this schema did not declare. */
const OWNER_KIND_EVALUATOR: EvaluatorDefinition = {
  stable_key: "discover.owner_kind",
  kind: "choice",
  question:
    "Below is one group of real, recorded failures from a plugin's production runs — the " +
    "failing tool (or, for a stage return, which stage was revisited), how the platform itself " +
    "already attributed the failure where it could, and raw examples. Whose fault is this " +
    "failure pattern, most likely?",
  answer_schema: { type: "choice", criteria: OWNER_KIND_MEANING },
  polarity: {},
  model_policy: {},
};

/** One candidate as `failure_discover`'s response carries it — the plan header's own shape. */
interface CandidateOut {
  id: string;
  stable_key: string | null;
  description: string;
  prevalence: { numerator: number; denominator: number };
  owner_kind: string;
  confidence: number | null;
  evidence_refs: unknown;
}
interface FailureDiscoverResult { candidates: CandidateOut[] }

interface Snapshot {
  observation_snapshot_id: string;
  plugin: string;
  declared_version: string;
  window: EvidenceWindow;
}

/** The subject `observation_snapshot_id` names, or null for one nothing minted — checked BEFORE
 *  `withIdempotency`, the same order `plugin_profile` (observe.ts) already established, so a
 *  refused call writes no ledger row. A malformed uuid refuses the same way an unknown one does,
 *  rather than reaching Postgres and surfacing `::uuid`'s own error text. */
async function resolveSnapshot(pool: pg.Pool, id: string): Promise<Snapshot | null> {
  if (!UUID_RE.test(id)) return null;
  const row = (await pool.query<{
    plugin: string; declared_version: string; production_window: { resolved: EvidenceWindow };
  }>(`
    select p.name as plugin, sv.declared_version as declared_version,
           os.production_window as production_window
      from zz.eval_observation_snapshot os
      join zz.eval_subject_version sv on sv.id = os.subject_version_id
      join zz.plugin p on p.id = sv.plugin_id
     where os.id = $1::uuid`, [id])).rows[0];
  if (!row) return null;
  return {
    observation_snapshot_id: id, plugin: row.plugin, declared_version: row.declared_version,
    window: row.production_window.resolved,
  };
}

/** What one owner-kind classification came out to, whichever of the three paths produced it:
 *  a real evaluator answer, an evaluator that answered off-vocabulary (should not happen — the
 *  evaluator's own schema is the vocabulary — reported rather than trusted blindly), or an
 *  outage. `note` is null only for a real, on-vocabulary answer. */
interface Classification { owner_kind: string; confidence: number | null; note: string | null }

/** Mutable across one `failure_discover` call: the first reason either model became unavailable
 *  for, so every later group of that kind stops asking and answers `unknown` for free. See this
 *  file's header for why. */
interface Outage { owner: string | null; critic: string | null }

async function classifyOwnerKind(
  evaluatorVersionId: string, subjectText: string, contextText: string, principal: string, outage: Outage,
): Promise<Classification> {
  if (outage.owner) {
    return {
      owner_kind: "unknown", confidence: null,
      note: `not asked: discover.owner_kind was unavailable earlier in this run — ${outage.owner}`,
    };
  }
  const answered = await recordEvaluatorAssessment({
    evaluator_version_id: evaluatorVersionId, subject_text: subjectText, context: contextText,
    askedBy: principal,
  });
  if (answered.reading === "unavailable") {
    // NOT_CONFIGURED answers instantly, with no network call — safe, and free, to keep asking:
    // every remaining group gets the same honest "no typed service configured" answer. Anything
    // else spent real budget failing and is worth not repeating.
    if (answered.reason !== NOT_CONFIGURED) outage.owner = answered.reason ?? "unavailable, no reason given";
    return { owner_kind: "unknown", confidence: null, note: answered.reason };
  }
  const distribution = answered.distribution ?? {};
  const [chosen, top] = Object.entries(distribution).sort((a, b) => b[1] - a[1])[0] ?? [null, null];
  if (!chosen || !(EVAL_STATE_ENUMS.ownerKind as readonly string[]).includes(chosen)) {
    return { owner_kind: "unknown", confidence: null,
             note: "the evaluator answered with no option this schema declares" };
  }
  return { owner_kind: chosen, confidence: top ?? null, note: null };
}

/** The `SUBJECT`/`CONTEXT` split every evaluator question in this codebase uses (`semantic.ts`):
 *  what is being judged, and what a judge needs to tell `plugin` from `platform` apart. */
function refusalSubject(g: RefusalGroup): string {
  const raw = g.sample_raw_texts.filter(Boolean).map((t) => `"${t}"`).join("; ") || "(none recorded)";
  return `A tool named "${g.tool}" refused ${g.count} time(s) with refusal text (normalised): ` +
    `"${g.normalized_text || "(no text recorded)"}". The platform's own attribution for these ` +
    `refusals is "${g.owner}" (guardrail = the platform refusing on purpose, ours = this ` +
    "platform's own code failing, theirs = a dependency failing underneath it, unattributed = " +
    `nothing attributed it yet). Raw examples: ${raw}`;
}
function pluginContext(snapshot: Snapshot): string {
  return `PLUGIN: ${snapshot.plugin} version ${snapshot.declared_version}\n` +
    `SERVES ITS OWN DOOR: ${servesOwnDoor(snapshot.plugin)
      ? "yes — its tools are this plugin itself, so \"ours\" here means this plugin"
      : "no — it is a flow reached through the shared baseline door, so \"ours\" there can mean the platform"}\n` +
    `WINDOW: ${snapshot.window.from} to ${snapshot.window.to}`;
}
function returnSubject(g: ReturnGroup): string {
  return `The flow returned to stage "${g.back_to_step}" after already reaching stage ` +
    `"${g.from_step}" ${g.count} time(s), across ${g.sample_initiatives.length} initiative(s). ` +
    "A return means a stage already passed was entered again later in the same initiative.";
}

/** The one generative-critic call this task makes (FR-11's own carve-out): a refusal group with
 *  no recorded text at all, which the deterministic pass has nothing to build a description
 *  from. Reuses `judge.ts`'s reading-judge `ask()` — the platform's one existing way to reach a
 *  larger model outside the typed service — under its own `purpose` so its `zz.model_call` rows
 *  never mix with a judging round's. */
async function criticDescribe(
  pool: pg.Pool, snapshot: Snapshot, g: RefusalGroup, outage: Outage,
): Promise<{ description: string; source: Record<string, unknown> }> {
  const fallback = `Tool "${g.tool}" refused ${g.count} time(s) in this window with no refusal ` +
    "text recorded at all — nothing in the evidence says what actually went wrong.";
  if (outage.critic) {
    return {
      description: fallback,
      source: { kind: "description_source", method: "generative_critic", model: JUDGE_MODEL,
                reason: `not asked: unavailable earlier in this run — ${outage.critic}` },
    };
  }
  const system = [
    "You are DISCOVER, part of a plugin-evaluation platform. Below is one group of real,",
    "recorded tool-call failures from a plugin's production runs. Every failure in this group",
    "recorded NO refusal text at all, so a deterministic pass could not describe it on its own.",
    "Propose ONE plain sentence describing what this failure mode most likely is, grounded only",
    "in the facts given below — never invent a cause the facts do not support, and say so if the",
    "facts genuinely do not support any specific cause.",
    "",
    'Answer as JSON only: {"description": string}',
  ].join("\n");
  const user = [
    `TOOL: ${g.tool}`,
    `OWNER (the platform's own attribution for refused calls from this tool): ${g.owner}`,
    `COUNT: ${g.count} refusal(s) recorded, with an empty refusal text every time`,
    pluginContext(snapshot),
  ].join("\n");
  const askedAt = new Date().toISOString();
  try {
    const said = await ask(pool, snapshot.plugin, system, user, "failure-discover");
    const proposed = typeof said?.description === "string" ? said.description.trim() : "";
    if (!proposed) {
      return { description: fallback,
               source: { kind: "description_source", method: "generative_critic", model: JUDGE_MODEL, asked_at: askedAt,
                         reason: "answered with no usable description" } };
    }
    return { description: proposed.slice(0, 800),
             source: { kind: "description_source", method: "generative_critic", model: JUDGE_MODEL, asked_at: askedAt, reason: null } };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    outage.critic = reason;
    return { description: fallback,
             source: { kind: "description_source", method: "generative_critic", model: JUDGE_MODEL, asked_at: askedAt, reason } };
  }
}

async function insertCandidate(
  client: pg.PoolClient, observationSnapshotId: string, description: string,
  prevalence: { numerator: number; denominator: number }, classification: Classification,
  evidenceRefs: unknown[],
): Promise<CandidateOut> {
  const row = (await client.query<{
    id: string; description: string; prevalence: { numerator: number; denominator: number };
    owner_kind: string; confidence: string | null; evidence_refs: unknown; stable_key: string | null;
  }>(`
    insert into zz.eval_failure_mode_candidate
      (observation_snapshot_id, stable_key, description, prevalence, owner_kind, confidence,
       evidence_refs, status, created_at)
    values ($1::uuid, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, now())
    returning id::text as id, description, prevalence, owner_kind, confidence, evidence_refs, stable_key`,
    [observationSnapshotId, null, description, JSON.stringify(prevalence), classification.owner_kind,
     classification.confidence, JSON.stringify(evidenceRefs), CANDIDATE_STATUS])).rows[0];
  if (!row) throw new Error("insert into zz.eval_failure_mode_candidate produced no row");
  return {
    id: row.id, stable_key: row.stable_key, description: row.description,
    prevalence: row.prevalence, owner_kind: row.owner_kind,
    confidence: row.confidence === null ? null : Number(row.confidence),
    evidence_refs: row.evidence_refs,
  };
}

/** The whole discovery run for one snapshot: deterministic grouping, then one ownership
 *  classification per group and, for the one group shape that needs it, one generative-critic
 *  description — then every group becomes exactly one inserted row, however its evidence or its
 *  models behaved. Runs inside `withIdempotency`'s `fn`, so a replay never re-enters here and
 *  therefore never re-asks a model — the ledger's proceed/replay decision is the circuit that
 *  actually matters; the outage breaker above only bounds the proceed path's own worst case. */
async function discoverCandidates(
  pool: pg.Pool, client: pg.PoolClient, snapshot: Snapshot, evaluatorVersionId: string, principal: string,
  idempotencyKey: string,
): Promise<FailureDiscoverResult> {
  const entry = entryOf(snapshot.plugin);
  const stages = (entry?.manifest.stages ?? []).map((s) => s.name);
  const reachable = toolsNamedBy(snapshot.plugin);
  const serves = servesOwnDoor(snapshot.plugin);

  const traces = await pluginTraces(
    pool, snapshot.plugin, snapshot.declared_version, reachable, stages, serves, snapshot.window);
  const [refusals, totalCalls] = await Promise.all([
    refusalGroups(pool, snapshot.plugin, snapshot.declared_version, serves, snapshot.window),
    totalToolCallEvents(pool, snapshot.plugin, snapshot.declared_version, serves, snapshot.window),
  ]);
  const returns = returnGroups(traces.returns);
  const totalVisits = totalStepVisits(traces.stage_paths);

  const outage: Outage = { owner: null, critic: null };
  const candidates: CandidateOut[] = [];

  for (const g of refusals) {
    const labelable = g.normalized_text.trim().length > 0;
    const built = labelable
      ? { description: `Tool "${g.tool}" refused ${g.count} of ${totalCalls} tool-call(s) in ` +
            `this window with refusal text (normalised): "${g.normalized_text}" ` +
            `(platform-attributed owner: ${g.owner}).`,
          source: { kind: "description_source", method: "deterministic" } as Record<string, unknown> }
      : await criticDescribe(pool, snapshot, g, outage);
    const classification = await classifyOwnerKind(
      evaluatorVersionId, refusalSubject(g), pluginContext(snapshot), principal, outage);
    const evidenceRefs: unknown[] = [
      ...g.sample_event_ids.map((event_id) => ({ kind: "event", event_id })),
      built.source,
      { kind: "ownership", evaluator: "discover.owner_kind", reason: classification.note },
      { kind: "discovery_run", principal, idempotency_key: idempotencyKey },
    ];
    candidates.push(await insertCandidate(
      client, snapshot.observation_snapshot_id, built.description,
      { numerator: g.count, denominator: totalCalls }, classification, evidenceRefs));
  }

  for (const g of returns) {
    const description = `The flow returned to stage "${g.back_to_step}" after already reaching ` +
      `stage "${g.from_step}" ${g.count} of ${totalVisits} step visit(s) in this window, across ` +
      `${g.sample_initiatives.length} initiative(s).`;
    const classification = await classifyOwnerKind(
      evaluatorVersionId, returnSubject(g), pluginContext(snapshot), principal, outage);
    const evidenceRefs: unknown[] = [
      ...g.sample_initiatives.map((initiative) => ({ kind: "initiative", initiative })),
      { kind: "description_source", method: "deterministic" },
      { kind: "ownership", evaluator: "discover.owner_kind", reason: classification.note },
      { kind: "discovery_run", principal, idempotency_key: idempotencyKey },
    ];
    candidates.push(await insertCandidate(
      client, snapshot.observation_snapshot_id, description,
      { numerator: g.count, denominator: totalVisits }, classification, evidenceRefs));
  }

  return { candidates };
}

/** A replay's own reconstruction: every candidate row THIS (principal, idempotency_key)
 *  discovery run wrote. `observation_snapshot_id` alone is not enough — migration 077 gives this
 *  table no column naming which call wrote a row, and nothing in this contract forbids running
 *  DISCOVER again over the same snapshot under a genuinely different `idempotency_key` (a
 *  second, later opinion), which would leave two calls' candidates sharing one
 *  `observation_snapshot_id`. `idempotency_key` alone is not enough either: the ledger's own
 *  primary key is `(principal, tool, idempotency_key)`, so two different principals reusing the
 *  same key string against the same snapshot are two different requests, not one. So every row
 *  this file inserts carries both its `principal` and its `idempotency_key` inside
 *  `evidence_refs` (the `discovery_run` entry), and a replay filters on both — the same pair
 *  `withIdempotency`'s own ledger already used to decide this was a replay in the first place. */
async function readBackCandidates(
  pool: pg.Pool, observationSnapshotId: string, principal: string, idempotencyKey: string,
): Promise<FailureDiscoverResult> {
  const { rows } = await pool.query<{
    id: string; description: string; prevalence: { numerator: number; denominator: number };
    owner_kind: string; confidence: string | null; evidence_refs: unknown; stable_key: string | null;
  }>(`
    select id::text as id, description, prevalence, owner_kind, confidence, evidence_refs, stable_key
      from zz.eval_failure_mode_candidate c
     where c.observation_snapshot_id = $1::uuid
       and exists (
         select 1 from jsonb_array_elements(c.evidence_refs) el
          where el->>'kind' = 'discovery_run' and el->>'principal' = $2 and el->>'idempotency_key' = $3
       )
     order by created_at`, [observationSnapshotId, principal, idempotencyKey]);
  return {
    candidates: rows.map((r) => ({
      id: r.id, stable_key: r.stable_key, description: r.description, prevalence: r.prevalence,
      owner_kind: r.owner_kind, confidence: r.confidence === null ? null : Number(r.confidence),
      evidence_refs: r.evidence_refs,
    })),
  };
}

export function registerFailureDiscoverTools(server: McpServer): void {
  server.registerTool(
    "failure_discover",
    {
      description:
        "WHEN an observation_snapshot_id (from plugin_profile) needs its real evidence mined " +
        "for candidate failure modes: DISCOVER. Groups refusals (by failing tool and " +
        "normalised text) and stage-return patterns deterministically, classifies each group's " +
        "ownership through the registered discover.owner_kind evaluator (a choice over " +
        "plugin | dependency | platform | environment | user_input | unknown), and — only for " +
        "a refusal group with no recorded text at all — proposes a description with one " +
        "generative-critic call, recorded with its provenance. RETURNS candidates: [{ id, " +
        "stable_key, description, prevalence: {numerator, denominator}, owner_kind, " +
        "confidence, evidence_refs }], every one persisted as zz.eval_failure_mode_candidate " +
        "rows with status='candidate', before any protocol exists. A mutator: writes through " +
        "the FR-59 idempotency ledger, so a retried call with the same idempotency_key replays " +
        "the exact same candidate set rather than re-asking any model. REFUSES an " +
        "observation_snapshot_id nothing minted; never drops a candidate for a model outage — " +
        "that group is stored with owner_kind='unknown' and the reason folded into its own " +
        "evidence_refs instead.",
      inputSchema: {
        observation_snapshot_id: z.string(),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ observation_snapshot_id, idempotency_key }) => {
      const pool = db();
      if (!pool) return noDb();

      const snapshot = await resolveSnapshot(pool, observation_snapshot_id);
      if (!snapshot) throw new Refusal("ERROR: unknown observation_snapshot_id");

      // Content-idempotent and ahead of the ledger: a refused registration (this file's own
      // kind/schema mismatch, were one ever introduced) writes no idempotency row, and
      // repeating this exact definition on every future call costs one upsert-and-read-back,
      // never a second evaluator version. See this file's header for why here and not a
      // separate seeding step.
      const evaluator = await registerEvaluator(OWNER_KIND_EVALUATOR);

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<FailureDiscoverResult> = await withIdempotency(
        principal, "failure_discover", idempotency_key, { observation_snapshot_id },
        async (client): Promise<MutatorOutcome<FailureDiscoverResult>> => {
          const result = await discoverCandidates(
            pool, client, snapshot, evaluator.evaluator_version_id, principal, idempotency_key);
          // Anchored at the snapshot, not at a candidate row: a window with zero refusals and
          // zero returns is a legitimate discovery run that writes no candidate at all, and
          // `zz.eval_idempotency.result_id` is `uuid not null` with nothing to point at then.
          // `readBackCandidates` below narrows this snapshot's rows down to this exact call's
          // own by the `idempotency_key` every row also carries in its `evidence_refs`.
          return { result, result_table: "zz.eval_observation_snapshot", result_id: observation_snapshot_id };
        },
      );

      const result = outcome.replayed
        ? await readBackCandidates(pool, observation_snapshot_id, principal, idempotency_key)
        : outcome.result;
      logActivity(await userRoot(), null, {
        user: principal, action: "failure_discover", plugin: snapshot.plugin,
        observation_snapshot_id, candidate_count: result.candidates.length, replayed: outcome.replayed,
      });
      return json(result);
    },
  );
}
