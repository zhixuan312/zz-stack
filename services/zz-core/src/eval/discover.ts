/**
 * DISCOVER (FR-11, Task I-9): mining real, recorded failures into candidate failure modes
 * before any protocol exists. `failure_discover(observation_snapshot_id)` reads one immutable
 * `zz.eval_observation_snapshot` (OBSERVE, Task I-7) and writes, for every group it finds
 * (Task I-24):
 *
 *   - one `zz.eval_failure_mode` — the failure mode's IDENTITY, `(plugin_id, stable_key)`, which
 *     is current state: a later run that finds the same rule on the same tool resolves to that
 *     row rather than minting a second mode. Its description is the FIRST sighting's, which is
 *     what Task I-20's migration kept when it split the old candidate rows this way.
 *   - one `zz.eval_failure_mode_sighting` — the FINDING of it in this one snapshot: immutable
 *     history, carrying its own prevalence, its owner kind and ref, and the evidence behind them.
 *     `discovery_key` is the stable key it was discovered under.
 *
 * Neither write is a judgement about whether the mode is real. What DISCOVER produces is raw
 * material for DEFINE/QUALIFY: `protocol_record` (Task I-23) is what folds one in, writing the
 * `eval_protocol_failure_mode` row, and `protocol_read`'s `open_candidates` is a sighting of a
 * mode no version of this plugin's protocol has folded in yet. The response still names its array
 * `candidates`, because that is what these sightings are to the stage that reads them — the
 * proposals a `failureTaxonomy` entry may accept, merge or leave uncited (see the plan's own
 * boundary: final deliverable content is not in this plan).
 *
 * Two passes over the evidence, both in `discover-groups.ts`:
 *   - deterministic grouping first, over refusal text/owner/failing tool and over stage-return
 *     patterns — pure arithmetic, no model touches it;
 *   - each group's representative evidence then goes to ONE registered evaluator,
 *     `discover.owner_kind` (a `choice` over `EVAL_STATE_ENUMS.ownerKind`), through
 *     `askEvaluatorQuestion` directly — this file already holds the `evaluator_version_id` it
 *     needs. Every model is asked before the ledger transaction opens (`planCandidates`) and
 *     each answer is recorded inside it (`insertPlanned`), with the sighting it classified.
 *
 * A refusal group with no recorded text at all is the one shape the deterministic pass cannot
 * describe — for that, and only that, ONE generative-critic call proposes the description,
 * through `judge.ts`'s `ask()` (the platform's one existing way to reach a larger model outside
 * the typed service),
 * recorded in `zz.model_call` under its own `purpose` and, on the sighting itself, under
 * `evidence_refs.description_source`. The sighting's own `description_model_call_id` column stays
 * null: `ask()` records the call and hands back only the answer, not its id, so a writer that
 * filled the column would be guessing which of the rows under this purpose was its own.
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
 * never drops a sighting — it is stored with `owner_kind = 'unknown'` and the failure's own
 * reason, in the sighting's `ownership_reason` and its `evidence_refs`. After the FIRST such
 * outage from either model in one run, every remaining group of that kind is answered `unknown`
 * WITHOUT a second evaluator call — so only the group that hit the outage carries a
 * real `zz.assessment` row for `discover.owner_kind`, and its sighting carries that row's id in
 * `assessment_id`; every later group in the same run carries neither, and its only record of the
 * classification is the `not asked: …` reason inside its own `evidence_refs.ownership`.
 * DELIBERATE, and a real narrowing of "each ownership classification
 * is one registered bounded-semantic evaluator answer recorded through
 * `recordEvaluatorAssessment`" for exactly this one case: `judge.ts`'s `ask()` and
 * `typed-service.ts`'s `ask()` each carry up to a ~100s budget per call, and something between
 * this tool and its caller closes the request at about two minutes — asking N more times against
 * an endpoint already known to be down would spend that budget once per remaining group and
 * return nothing at all, which is the one way this function actually could drop a failure mode.
 * Every sighting is still persisted with an owner_kind and a reason either way; what a known-bad
 * endpoint costs is the recorded evaluator row for groups after the first, not the sighting.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EVAL_STATE_ENUMS, parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { entryOf, helperSkillsOf, servesOwnDoor, stageDocumentsOf, toolsNamedBy } from "./plugin-eval.js";
import { pluginTraces, type EvidenceWindow } from "./plugin-profile.js";
import {
  refusalGroups, refusalKey, returnGroups, returnKey, totalToolCallEvents,
  type RefusalGroup, type ReturnGroup,
} from "./discover-groups.js";
import { registerEvaluator, type EvaluatorDefinition } from "./evaluators.js";
import { ask } from "./judge.js";
import { JUDGE_MODEL } from "./judge-model.js";
import {
  decideBeforeWork, withIdempotency, type IdempotencyOutcome, type MutatorOutcome,
} from "./idempotency.js";
import { recordStage } from "./stage-record.js";
import { askEvaluatorQuestion, insertEvaluatorAnswer, type AskedEvaluatorAnswer } from "../semantic.js";
import { NOT_CONFIGURED } from "../typed-service.js";
import { platformEvent } from "../indexing.js";
import { Refusal } from "../refusal.js";
import { db } from "../platform-db.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no failure discovery can be recorded");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** One sighting as `failure_discover`'s response carries it: the finding of one failure mode in
 *  the snapshot this call mined, and the identity it belongs to. Two sightings that carry the same
 *  `failure_mode_id` are two windows' evidence of one failure mode, which is the whole reason the
 *  identity and the sighting are two rows (Task I-24). */
interface SightingOut {
  /** The sighting — the id a `failureTaxonomy` entry names as its `candidateId`, and what
   *  `protocol_record` resolves to the identity it folds in. */
  id: string;
  /** The failure mode's identity: `(plugin_id, stable_key)`, current state. */
  failure_mode_id: string;
  stable_key: string;
  description: string;
  prevalence: { numerator: number; denominator: number };
  owner_kind: string;
  /** The plugin's own name where `owner_kind` is `plugin`, null where nothing here knows which
   *  part of the platform, dependency, environment or input it was. */
  owner_ref: string | null;
  confidence: number | null;
  evidence_refs: unknown;
}
/** `candidates` is this door's own field name for these rows, kept because that is what they are
 *  to the stage that reads them — a `failureTaxonomy` entry may accept, merge or leave each one
 *  uncited. Each element is a sighting, not the mode. */
interface FailureDiscoverResult { candidates: SightingOut[] }

interface Snapshot {
  observation_snapshot_id: string;
  /** The failure-mode identity's own `plugin_id`: a stable key identifies a mode only within one
   *  plugin, which is why `(plugin_id, stable_key)` is the identity and not the key alone. */
  plugin_id: string;
  plugin: string;
  declared_version: string;
  window: EvidenceWindow;
}

/** The subject `observation_snapshot_id` names, or null for one nothing minted — checked BEFORE
 *  `withIdempotency`, the same order `plugin_profile` (observe.ts) already established, so a
 *  refused call writes no ledger row. A malformed uuid refuses the same way an unknown one does,
 *  rather than reaching Postgres and surfacing `::uuid`'s own error text.
 *
 *  The plugin is reached the way every other reader of this table reaches it now (Task I-20): the
 *  snapshot names a `plugin_version_id` itself, so `zz.eval_subject_version` — whose single fact
 *  was that pair — is gone. A snapshot whose window never resolved stores NULL on both window
 *  columns, and DISCOVER reads that as the same empty range a fresh OBSERVE used
 *  (`observe.ts`'s `windowOf`): the two grouping passes then find nothing in it, which is the
 *  honest result for a window that observed nothing. */
async function resolveSnapshot(pool: pg.Pool, id: string): Promise<Snapshot | null> {
  if (!UUID_RE.test(id)) return null;
  const row = (await pool.query<{
    plugin_id: string; plugin: string; declared_version: string;
    window_from: string | null; window_to: string | null;
  }>(`
    select pv.plugin_id::text as plugin_id, p.name as plugin, pv.version as declared_version,
           os.window_from::text as window_from, os.window_to::text as window_to
      from zz.eval_observation_snapshot os
      join zz.plugin_version pv on pv.id = os.plugin_version_id
      join zz.plugin p on p.id = pv.plugin_id
     where os.id = $1::uuid`, [id])).rows[0];
  if (!row) return null;
  return {
    observation_snapshot_id: id, plugin_id: row.plugin_id, plugin: row.plugin,
    declared_version: row.declared_version,
    window: row.window_from !== null && row.window_to !== null
      ? { from: row.window_from, to: row.window_to }
      : { from: "infinity", to: "-infinity" },
  };
}

/** What one owner-kind classification came out to, whichever of the three paths produced it:
 *  a real evaluator answer, an evaluator that answered off-vocabulary (should not happen — the
 *  evaluator's own schema is the vocabulary — reported rather than trusted blindly), or an
 *  outage. `note` is null only for a real, on-vocabulary answer. */
interface Classification {
  owner_kind: string; confidence: number | null; note: string | null;
  /** The evaluator answer still to be recorded in `zz.assessment` — inside the ledger
   *  transaction, never before it; null when no model was asked (`not asked: …`). */
  pending: AskedEvaluatorAnswer | null;
}

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
      pending: null,
    };
  }
  const pending = await askEvaluatorQuestion({
    evaluator_version_id: evaluatorVersionId, subject_text: subjectText, context: contextText,
    askedBy: principal,
  });
  const answered = pending.result;
  if (answered.reading === "unavailable") {
    // NOT_CONFIGURED answers instantly, with no network call — safe, and free, to keep asking:
    // every remaining group gets the same honest "no typed service configured" answer. Anything
    // else spent real budget failing and is worth not repeating.
    if (answered.reason !== NOT_CONFIGURED) outage.owner = answered.reason ?? "unavailable, no reason given";
    return { owner_kind: "unknown", confidence: null, note: answered.reason, pending };
  }
  const distribution = answered.distribution ?? {};
  const [chosen, top] = Object.entries(distribution).sort((a, b) => b[1] - a[1])[0] ?? [null, null];
  if (!chosen || !(EVAL_STATE_ENUMS.ownerKind as readonly string[]).includes(chosen)) {
    return { owner_kind: "unknown", confidence: null,
             note: "the evaluator answered with no option this schema declares", pending };
  }
  return { owner_kind: chosen, confidence: top ?? null, note: null, pending };
}

/** The `SUBJECT`/`CONTEXT` split every evaluator question in this codebase uses (`semantic.ts`):
 *  what is being judged, and what a judge needs to tell `plugin` from `platform` apart. */
function refusalSubject(g: RefusalGroup): string {
  const raw = g.sample_raw_texts.filter(Boolean).map((t) => `"${t}"`).join("; ") || "(none recorded)";
  return `A tool named "${g.tool}" refused ${g.count} time(s) with refusal text (normalised): ` +
    `"${g.normalized_text || "(no text recorded)"}". The platform's own attribution for these ` +
    `refusals is "${g.owner}" (guardrail = the platform refusing on purpose, by a rule it names; ` +
    "ours = the caller sent a malformed call — a missing argument, an input the tool's schema " +
    "rejects — which the calling flow could have avoided; theirs = a dependency failing " +
    `underneath it; unattributed = nothing attributed it yet). Raw examples: ${raw}`;
}
function pluginContext(snapshot: Snapshot): string {
  return `PLUGIN: ${snapshot.plugin} version ${snapshot.declared_version}\n` +
    `SERVES ITS OWN DOOR: ${servesOwnDoor(snapshot.plugin)
      ? "yes — its tools are this plugin itself, so a guardrail refusal is this plugin's own rule"
      : "no — it is a flow reached through the shared baseline door, whose tools are the platform's"}\n` +
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

/** The failure-mode identity under `(plugin_id, stable_key)`, created when this plugin has none
 *  under that key yet, and the id every sighting of it carries in `failure_mode_id`.
 *
 *  `on conflict do nothing` and then a read-back, rather than `do update`: the identity's
 *  description is its FIRST sighting's, which is what Task I-20's migration kept when it split the
 *  candidate rows this way (`(array_agg(c.description order by c.created_at))[1]`), and a
 *  `do update` would rewrite it with whatever wording this run's own prevalence figures happened
 *  to produce. The read-back is also what makes a concurrent run that inserted the same key in
 *  another transaction a wait rather than a unique violation inside this ledger transaction.
 *
 *  A read-back that finds nothing is an error rather than a null: `(plugin_id, stable_key)` is
 *  unique, so a `do nothing` insert that returned no row and a select that returns no row
 *  contradict each other, and writing the sighting without an identity to resolve to is exactly
 *  the defect the split exists to prevent. */
async function resolveFailureMode(
  client: pg.PoolClient, pluginId: string, stableKey: string, description: string,
): Promise<string> {
  const inserted = (await client.query<{ id: string }>(`
    insert into zz.eval_failure_mode (plugin_id, stable_key, description, created_at)
    values ($1::uuid, $2, $3, now())
    on conflict (plugin_id, stable_key) do nothing
    returning id::text as id`, [pluginId, stableKey, description])).rows[0];
  if (inserted) return inserted.id;
  const existing = (await client.query<{ id: string }>(`
    select id::text as id from zz.eval_failure_mode
     where plugin_id = $1::uuid and stable_key = $2`, [pluginId, stableKey])).rows[0];
  if (!existing) {
    throw new Error(`zz.eval_failure_mode (${pluginId}, ${stableKey}) neither inserted nor found`);
  }
  return existing.id;
}

/** One group's finding of one failure mode in one snapshot: the identity resolved, then the
 *  sighting itself. Both writes land in the ledger's transaction, so a rollback takes the
 *  evaluator answer with them and a replay writes neither.
 *
 *  The ownership is written three ways on purpose, and they are one fact: `owner_kind` and
 *  `owner_ref` are what a reader joins on, `ownership_reason` is what the evaluator answered (or
 *  the outage that stopped it), and the `ownership` entry inside `evidence_refs` is the provenance
 *  trail Task I-20's migration derives the first two from — so a sighting DISCOVER writes now
 *  reads exactly like one the migration carried over. The prevalence is two columns rather than a
 *  jsonb object, so `prevalence_numerator <= prevalence_denominator` is a constraint the database
 *  holds rather than a shape a reader hopes for. */
async function insertSighting(
  client: pg.PoolClient, snapshot: Snapshot, planned: PlannedCandidate, discoveredBy: string,
): Promise<SightingOut> {
  // The evaluator answer is recorded first, and its `zz.assessment` id goes on the sighting: a
  // reader that wants to know what the ownership classification answered has the row, not just
  // this file's summary of it. `classification.pending` is null for a group no model was asked
  // (an outage earlier in the run), and the column stays null with it.
  const assessment = planned.classification.pending
    ? await insertEvaluatorAnswer(client, planned.classification.pending)
    : null;
  const modeId = await resolveFailureMode(
    client, snapshot.plugin_id, planned.stableKey, planned.description);
  const row = (await client.query<{
    id: string; failure_mode_id: string; description: string;
    prevalence_numerator: number; prevalence_denominator: number; owner_kind: string;
    owner_ref: string | null; confidence: string | null; evidence_refs: unknown;
  }>(`
    insert into zz.eval_failure_mode_sighting
      (failure_mode_id, observation_snapshot_id, description, prevalence_numerator,
       prevalence_denominator, owner_kind, owner_ref, ownership_reason, confidence,
       assessment_id, evidence_refs, discovered_by, discovery_key, created_at)
    values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::uuid, $13, now())
    returning id::text as id, failure_mode_id::text as failure_mode_id, description,
              prevalence_numerator, prevalence_denominator, owner_kind, owner_ref, confidence,
              evidence_refs`,
    [modeId, snapshot.observation_snapshot_id, planned.description,
     planned.prevalence.numerator, planned.prevalence.denominator,
     planned.classification.owner_kind, planned.ownerRef, planned.ownershipReason,
     planned.classification.confidence, assessment?.assessment_id ?? null,
     JSON.stringify(planned.evidenceRefs), discoveredBy, planned.stableKey])).rows[0];
  if (!row) throw new Error("insert into zz.eval_failure_mode_sighting produced no row");
  return {
    id: row.id, failure_mode_id: row.failure_mode_id, stable_key: planned.stableKey,
    description: row.description,
    prevalence: { numerator: row.prevalence_numerator, denominator: row.prevalence_denominator },
    owner_kind: row.owner_kind, owner_ref: row.owner_ref,
    confidence: row.confidence === null ? null : Number(row.confidence),
    evidence_refs: row.evidence_refs,
  };
}

/** Which owner an owner_kind names, where the evidence says: `plugin` is the plugin under
 *  evaluation, by name. Null where nothing here knows which part of the platform, dependency,
 *  environment or input it was. */
function ownerRef(ownerKind: string, plugin: string): string | null {
  return ownerKind === "plugin" ? plugin : null;
}

/** One group's sighting, fully decided and not yet written: the identity it will belong to is not
 *  known until the write, because a run that finds a mode this plugin already has resolves to that
 *  mode's own row rather than minting a second. */
interface PlannedCandidate {
  readonly stableKey: string;
  readonly description: string;
  readonly prevalence: { numerator: number; denominator: number };
  readonly classification: Classification;
  readonly evidenceRefs: unknown[];
  /** The sighting's own ownership columns, the queryable half of the `ownership` evidence ref
   *  below — `owner_ref` is the plugin's name where `owner_kind` is `plugin`. */
  readonly ownerRef: string | null;
  readonly ownershipReason: string | null;
}

/** The whole discovery run for one snapshot, up to but not including any write: deterministic
 *  grouping, then one ownership classification per group and, for the one group shape that needs
 *  it, one generative-critic description. Runs BEFORE `withIdempotency` opens its transaction —
 *  every model call here can take ~100s, and a transaction held across them pins a pool
 *  connection while the evaluator's own reads need another. `decideBeforeWork` has already ruled
 *  out a replay, so a retried call still never re-asks a model; the outage breaker above only
 *  bounds the proceed path's own worst case. `insertPlanned` writes the result. */
async function planCandidates(
  pool: pg.Pool, snapshot: Snapshot, evaluatorVersionId: string, principal: string,
  idempotencyKey: string,
): Promise<PlannedCandidate[]> {
  const entry = entryOf(snapshot.plugin);
  const stages = (entry?.manifest.stages ?? []).map((s) => s.name);
  const reachable = toolsNamedBy(snapshot.plugin);
  const serves = servesOwnDoor(snapshot.plugin);

  const traces = await pluginTraces(
    pool, snapshot.plugin, snapshot.declared_version, reachable, stages, serves, snapshot.window,
    helperSkillsOf(snapshot.plugin), stageDocumentsOf(snapshot.plugin));
  const [refusals, totalCalls] = await Promise.all([
    refusalGroups(pool, snapshot.plugin, snapshot.declared_version, serves, snapshot.window),
    totalToolCallEvents(pool, snapshot.plugin, snapshot.declared_version, serves, snapshot.window),
  ]);
  const returns = returnGroups(traces.returns);
  const totalWrites = traces.stage_document_writes;

  const outage: Outage = { owner: null, critic: null };
  const planned: PlannedCandidate[] = [];

  for (const g of refusals) {
    const labelable = g.normalized_text.trim().length > 0;
    const built = labelable
      ? { description: `Tool "${g.tool}" refused ${g.count} of ${totalCalls} tool-call(s) in ` +
            `this window with refusal text (normalised): "${g.normalized_text}" ` +
            `(platform-attributed owner: ${g.owner}).`,
          source: { kind: "description_source", method: "deterministic" } as Record<string, unknown> }
      : await criticDescribe(pool, snapshot, g, outage);
    const asked = await classifyOwnerKind(
      evaluatorVersionId, refusalSubject(g), pluginContext(snapshot), principal, outage);
    // A plugin that serves its own door IS platform code: its refusals come from its own tools,
    // so "platform" names no owner a finding could be routed to, and IMPROVE refuses anything
    // not owned by `plugin`. The evaluator's own answer stays on the ref as `folded_from`.
    const folded = serves && asked.owner_kind === "platform";
    const classification: Classification = folded ? { ...asked, owner_kind: "plugin" } : asked;
    const ownership = { kind: "ownership", evaluator: "discover.owner_kind", reason: classification.note,
      owner_ref: ownerRef(classification.owner_kind, snapshot.plugin),
      ...(folded ? { folded_from: "platform" } : {}) };
    const evidenceRefs: unknown[] = [
      ...g.sample_event_ids.map((event_id) => ({ kind: "event", event_id })),
      built.source,
      ownership,
      { kind: "discovery_run", principal, idempotency_key: idempotencyKey },
    ];
    planned.push({
      stableKey: refusalKey(g),
      description: built.description, prevalence: { numerator: g.count, denominator: totalCalls },
      classification, evidenceRefs, ownerRef: ownership.owner_ref, ownershipReason: classification.note,
    });
  }

  for (const g of returns) {
    const description = `The flow returned to stage "${g.back_to_step}" after already reaching ` +
      `stage "${g.from_step}" ${g.count} of ${totalWrites} stage-document write(s) in this window, across ` +
      `${g.sample_initiatives.length} initiative(s).`;
    const classification = await classifyOwnerKind(
      evaluatorVersionId, returnSubject(g), pluginContext(snapshot), principal, outage);
    const ownership = { kind: "ownership", evaluator: "discover.owner_kind", reason: classification.note,
      owner_ref: ownerRef(classification.owner_kind, snapshot.plugin) };
    const evidenceRefs: unknown[] = [
      ...g.sample_initiatives.map((initiative) => ({ kind: "initiative", initiative })),
      { kind: "description_source", method: "deterministic" },
      ownership,
      { kind: "discovery_run", principal, idempotency_key: idempotencyKey },
    ];
    planned.push({ stableKey: returnKey(g), description, prevalence: { numerator: g.count, denominator: totalWrites },
                   classification, evidenceRefs, ownerRef: ownership.owner_ref, ownershipReason: classification.note });
  }

  return planned;
}

/** Every planned sighting — its identity resolved and created where this plugin has none — in the
 *  ledger's transaction, so a rollback takes the `zz.assessment` rows and any identity this run
 *  minted with the sightings, and a replay writes none of the three. */
async function insertPlanned(
  client: pg.PoolClient, snapshot: Snapshot, planned: readonly PlannedCandidate[], discoveredBy: string,
): Promise<FailureDiscoverResult> {
  const candidates: SightingOut[] = [];
  for (const c of planned) candidates.push(await insertSighting(client, snapshot, c, discoveredBy));
  return { candidates };
}

/** A replay's own reconstruction: every candidate row THIS (principal, idempotency_key)
 *  discovery run wrote. `observation_snapshot_id` alone is not enough — 001 gives this
 *  table no column naming which call wrote a row, and nothing in this contract forbids running
 *  DISCOVER again over the same snapshot under a genuinely different `idempotency_key` (a
 *  second, later opinion), which would leave two calls' sightings sharing one
 *  `observation_snapshot_id`. `idempotency_key` alone is not enough either: the ledger's own
 *  primary key is `(principal, tool, idempotency_key)`, so two different principals reusing the
 *  same key string against the same snapshot are two different requests, not one. So every sighting
 *  this file inserts carries both its `principal` and its `idempotency_key` inside
 *  `evidence_refs` (the `discovery_run` entry), and a replay filters on both — the same pair
 *  `withIdempotency`'s own ledger already used to decide this was a replay in the first place.
 *  `discovered_by` names the principal too, but not which call, and a replay is a claim about
 *  which call. */
async function readBackCandidates(
  pool: pg.Pool, observationSnapshotId: string, principal: string, idempotencyKey: string,
): Promise<FailureDiscoverResult> {
  const { rows } = await pool.query<{
    id: string; failure_mode_id: string; stable_key: string; description: string;
    prevalence_numerator: number; prevalence_denominator: number;
    owner_kind: string; owner_ref: string | null; confidence: string | null; evidence_refs: unknown;
  }>(`
    select s.id::text as id, s.failure_mode_id::text as failure_mode_id, fm.stable_key, s.description,
           s.prevalence_numerator, s.prevalence_denominator,
           s.owner_kind, s.owner_ref, s.confidence, s.evidence_refs
      from zz.eval_failure_mode_sighting s
      join zz.eval_failure_mode fm on fm.id = s.failure_mode_id
     where s.observation_snapshot_id = $1::uuid
       and exists (
         select 1 from jsonb_array_elements(s.evidence_refs) el
          where el->>'kind' = 'discovery_run' and el->>'principal' = $2 and el->>'idempotency_key' = $3
       )
     order by s.created_at`, [observationSnapshotId, principal, idempotencyKey]);
  return {
    candidates: rows.map((r) => ({
      id: r.id, failure_mode_id: r.failure_mode_id, stable_key: r.stable_key,
      description: r.description,
      prevalence: { numerator: r.prevalence_numerator, denominator: r.prevalence_denominator },
      owner_kind: r.owner_kind, owner_ref: r.owner_ref,
      confidence: r.confidence === null ? null : Number(r.confidence),
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
        "failure_mode_id, stable_key, description, prevalence: {numerator, denominator}, owner_kind, " +
        "owner_ref, confidence, evidence_refs }], each one a zz.eval_failure_mode_sighting — the " +
        "finding of one failure mode in this snapshot — under the zz.eval_failure_mode identity " +
        "its stable_key (the tool and refusal rule, or the two stages of a return) names: one " +
        "identity per (plugin, stable_key), current state, plus one immutable sighting per " +
        "discovery of it, so a second run that finds the same group re-sights that identity " +
        "rather than minting a second failure mode. Folding an identity into a protocol is " +
        "protocol_record's write of a zz.eval_protocol_failure_mode row, never this tool's. A " +
        "mutator: writes through the FR-59 idempotency ledger, so a retried call with the same " +
        "idempotency_key replays the exact same sighting set rather than re-asking any model. " +
        "REFUSES an observation_snapshot_id nothing minted; never drops a failure mode for a " +
        "model outage — that group is stored with owner_kind='unknown' and the reason in its own " +
        "ownership_reason and evidence_refs instead.",
      inputSchema: {
        observation_snapshot_id: z.string(),
        idempotency_key: z.string().min(1),
        initiative: z.string().optional().describe(
          "The initiative this evaluation runs in: records that DISCOVER ran over this snapshot, " +
          "which initiative_status reads to route the next stage."),
      },
    },
    async ({ observation_snapshot_id, idempotency_key, initiative }) => {
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
      // The sighting names who found it: `discovered_by` is a principal, and an address no
      // principal carries is refused rather than written as an attribution nobody has — the same
      // refusal `plugin_profile` (observe.ts) makes for its own `recorded_by`. Resolved before the
      // ledger, like every other refusal here, so a refused call writes no idempotency row.
      const discoverer = (await pool.query<{ id: string }>(
        "select id::text as id from zz.principal where lower(email) = lower($1) limit 1",
        [principal])).rows[0];
      if (!discoverer) {
        throw new Refusal(`ERROR: no zz.principal carries "${principal}", so this discovery has nobody to name`);
      }
      const prior = await decideBeforeWork(
        principal, "failure_discover", idempotency_key, { observation_snapshot_id });
      const planned = prior.replayed ? [] : await planCandidates(
        pool, snapshot, evaluator.evaluator_version_id, principal, idempotency_key);
      const outcome: IdempotencyOutcome<FailureDiscoverResult> = prior.replayed ? prior : await withIdempotency(
        principal, "failure_discover", idempotency_key, { observation_snapshot_id },
        async (client): Promise<MutatorOutcome<FailureDiscoverResult>> => {
          const result = await insertPlanned(client, snapshot, planned, discoverer.id);
          // Anchored at the snapshot, not at a sighting row: a window with zero refusals and
          // zero returns is a legitimate discovery run that writes no sighting at all, and
          // `zz.eval_idempotency.result_id` is `uuid not null` with nothing to point at then.
          // `readBackCandidates` below narrows this snapshot's rows down to this exact call's
          // own by the `idempotency_key` every sighting also carries in its `evidence_refs`.
          return { result, result_table: "zz.eval_observation_snapshot", result_id: observation_snapshot_id };
        },
      );

      const result = outcome.replayed
        ? await readBackCandidates(pool, observation_snapshot_id, principal, idempotency_key)
        : outcome.result;
      platformEvent({
        actor: principal, kind: "failure_discover", initiative, plugin: snapshot.plugin,
        observation_snapshot_id, sighting_count: result.candidates.length, replayed: outcome.replayed,
      });
      const recorded = await recordStage(initiative, "zz-plugin-discover", { observation_snapshot_id });
      return json({ ...result, ...recorded });
    },
  );
}
