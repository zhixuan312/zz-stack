/**
 * `replay_case_set_build` (Task I-14, FR-24, FR-60): applies FR-60's seven rules, in order, to
 * every closed initiative `source_scope` names, and writes one new, immutable
 * `zz.replay_case_set` version — its cases, their FR-25/26 visibility-tagged events, and their
 * FR-27 three-way split. This tool is the only writer of `zz.replay_case`/`zz.replay_event`
 * (FR-60's own words); `replay-derive.ts` carries the derivation itself, `split.ts` the split.
 *
 * `visibleEvents(events, role)` is exported from here (the plan header's own placement): the ONE
 * function any session reads a case's events through, so the FR-25/26 visibility boundary is
 * enforced in one place rather than re-decided by every reader.
 *
 * Unchanged material reuses the plugin's existing case-set version rather than minting a
 * redundant one — `replay-derive.ts`'s `materialDigest` is computed from the raw store material
 * plus `replay.source_kind`'s own qualification state, before any per-source evaluator call, so
 * this is a cheap equality check, not a second derivation. Changed material — or a qualification
 * state that has moved since the last build — always gets a new version: a case set is never
 * edited (FR-60's own words), so there is no third option.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller, ThreeWaySplitPolicy } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import {
  buildMaterial, classifyMaterial, deriveCase, materialDigest, meetsOperational, resolveInitiatives,
  resolveQualification, SOURCE_KIND_EVALUATOR, type ClassifiedMaterial, type DerivedCase, type SourceScope,
} from "./replay-derive.js";
import { insertEvaluatorAnswer } from "../semantic.js";
import { Refusal } from "../refusal.js";
import { registerEvaluator } from "./evaluators.js";
import { recordQualification, resolveProtocol, type GatheredQualification } from "./qualify.js";
import { assignSplits, minimumsMet, type SplitCase, type SplitPolicy } from "./split.js";
import {
  decideBeforeWork, withIdempotency, type IdempotencyOutcome, type MutatorOutcome,
} from "./idempotency.js";
import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { db } from "../platform-db.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no replay case set can be built");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The one shape a pool and a transaction's own client both satisfy — mirrors
 *  `idempotency.ts`'s own `Queryable`: an explicit generic signature, not
 *  `Pick<pg.Pool, "query">`, which TypeScript infers as a non-callable union over `Pool`'s
 *  overloads. Every helper below that may run inside or outside `withIdempotency`'s
 *  transaction takes this instead of naming `pg.Pool`/`pg.PoolClient` twice. */
interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

// -------------------------------------------------------------------------------------------
// visibleEvents — read by every session that opens a case, exported from here per the plan.

interface ReplayEventLike {
  readonly seq: number;
  readonly visibility: string;
}

/** FR-25/26's own boundary: which visibilities each role may read, once, so a reader that wants
 *  "everything a candidate actor may see" never has to re-derive it from the raw visibility
 *  column. Ordered by `seq`, always — the caller's own array order is never trusted, because a
 *  chronological reader is the one thing every role here needs in common. An unknown role is
 *  refused, never defaulted to the narrowest (or widest) set: silently narrowing would hide a
 *  caller's typo as "the actor saw nothing today" and silently widening would leak an oracle. */
export function visibleEvents<T extends ReplayEventLike>(events: readonly T[], role: string): T[] {
  const allowed: Readonly<Record<string, ReadonlySet<string>>> = {
    actor: new Set(["actor"]),
    simulated_person: new Set(["actor", "user_oracle"]),
    evaluator: new Set(["actor", "user_oracle", "evaluation_oracle"]),
  };
  const set = allowed[role];
  if (!set) {
    throw new Error(`"${role}" is not a registered replay role — one of ${Object.keys(allowed).join(", ")}`);
  }
  return events.filter((e) => set.has(e.visibility)).slice().sort((a, b) => a.seq - b.seq);
}

// -------------------------------------------------------------------------------------------
// subject_version_id -> plugin, the same lookup protocol.ts's pluginOf makes.

async function pluginOf(p: pg.Pool, subjectVersionId: string): Promise<string | null> {
  if (!UUID_RE.test(subjectVersionId)) return null;
  const row = (await p.query<{ plugin_id: string }>(
    "select plugin_id::text as plugin_id from zz.eval_subject_version where id = $1::uuid",
    [subjectVersionId])).rows[0];
  return row?.plugin_id ?? null;
}

const DEFAULT_SPLIT_POLICY: SplitPolicy = {
  evolve: 0.4, validation: 0.3, proof: 0.3, min: { evolve: 5, validation: 10, proof: 10 },
};

/** The protocol's own FR-27 split policy (`replay.splitPolicy` inside `replay_policy`, FR-57's
 *  bootstrap values by default) — never a caller-supplied argument; `replay_case_set_build`'s own
 *  signature carries no split weights, so inventing one here would be a second, silent policy
 *  nobody agreed to. */
function splitPolicyOf(replayPolicy: unknown): SplitPolicy {
  const parsed = ThreeWaySplitPolicy.safeParse((replayPolicy as { splitPolicy?: unknown } | null)?.splitPolicy);
  return parsed.success ? parsed.data : DEFAULT_SPLIT_POLICY;
}

interface Counts { evolve: number; validation: number; proof: number; not_replayable: number }

async function countsFor(runner: Queryable, caseSetId: string): Promise<Counts> {
  const { rows } = await runner.query<{ split: string | null; status: string; n: string }>(`
    select split, status, count(*)::text as n from zz.replay_case
     where case_set_id = $1::uuid group by split, status`, [caseSetId]);
  const counts: Counts = { evolve: 0, validation: 0, proof: 0, not_replayable: 0 };
  for (const r of rows) {
    const n = Number(r.n);
    if (r.status === "not_replayable") counts.not_replayable += n;
    else if (r.split === "evolve") counts.evolve += n;
    else if (r.split === "validation") counts.validation += n;
    else if (r.split === "proof") counts.proof += n;
  }
  return counts;
}

interface BuildResult {
  case_set_id: string; version: number; counts: Counts; minimums_met: boolean; source_kind_qualification: string;
}

async function latestCaseSet(
  runner: Queryable, pluginId: string,
): Promise<{ id: string; version: number; digest: string } | null> {
  const row = (await runner.query<{ id: string; version: number; digest: string }>(`
    select id::text as id, version, source_snapshot_digest as digest
      from zz.replay_case_set where plugin_id = $1::uuid order by version desc limit 1`,
    [pluginId])).rows[0];
  return row ?? null;
}

/** Writes every case and its events for one derived case (FR-25, FR-26, FR-60): one
 *  `zz.replay_case` row, then its events in the timeline's own order — `seq` starts at 0 per
 *  case, matching `DerivedCase.events`'s own indices. */
async function writeCase(
  client: Queryable, caseSetId: string, c: DerivedCase, split: "evolve" | "validation" | "proof" | null,
): Promise<void> {
  const row = (await client.query<{ id: string }>(`
    insert into zz.replay_case
      (case_set_id, source_initiative, case_digest, split, status, not_replayable_reason,
       user_oracle_coverage, decisions_only_in_documents)
    values ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
    returning id::text as id`,
    [caseSetId, c.initiative, c.caseDigest, split, c.status, c.notReplayableReason,
     c.userOracleCoverage, c.decisionsOnlyInDocuments])).rows[0];
  if (!row) throw new Error("insert into zz.replay_case produced no row");
  for (const ev of c.events) {
    await client.query(`
      insert into zz.replay_event (case_id, seq, actor, visibility, kind, payload, payload_digest)
      values ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7)`,
      [row.id, ev.seq, ev.actor, ev.visibility, ev.kind, JSON.stringify(ev.payload), ev.payloadDigest]);
  }
}

/** Everything a build decided before its transaction opened: the material's digest, the
 *  protocol's policies, the qualification state (and, when this call established it, the
 *  unrecorded run behind it), and every source classification already asked. */
interface BuildPlan {
  readonly pluginId: string;
  readonly protocolVersionId: string;
  readonly snapshotDigest: string;
  readonly splitPolicy: SplitPolicy;
  readonly scoringPolicy: unknown;
  readonly qualState: string;
  readonly qualified: boolean;
  readonly materialCount: number;
  readonly classified: readonly ClassifiedMaterial[];
  readonly qualification: GatheredQualification | null;
}

/** The transaction body of `replay_case_set_build`: writes only, through `client`, never a model
 *  call — every question was asked before the transaction opened. Exported for
 *  `checks/eval-replay-build-split.ts`, which drives it with a stub client. */
export async function recordBuild(client: Queryable, plan: BuildPlan): Promise<MutatorOutcome<BuildResult>> {
  if (plan.qualification) await recordQualification(client, plan.qualification);

  const existing = await latestCaseSet(client, plan.pluginId);
  if (existing && existing.digest === plan.snapshotDigest) {
    const counts = await countsFor(client, existing.id);
    const result: BuildResult = {
      case_set_id: existing.id, version: existing.version, counts,
      minimums_met: minimumsMet(counts, plan.splitPolicy), source_kind_qualification: plan.qualState,
    };
    return { result, result_table: "zz.replay_case_set", result_id: existing.id };
  }
  if (plan.classified.length !== plan.materialCount) {
    // Classification was skipped because the plugin's newest case set matched this material when
    // it was read, and a concurrent build has since replaced it. Refused before any case-set row
    // is written, and never answered by asking a model in here. The refusal rolls back with no
    // ledger row, so the same idempotency_key is still unused.
    throw new Refusal("ERROR: another build replaced this plugin's case set while this call was preparing; nothing was recorded — call again, the same idempotency_key is still unused");
  }

  const version = (existing?.version ?? 0) + 1;
  const splitSeed = plan.snapshotDigest;
  const caseSetRow = await client.query<{ id: string }>(`
    insert into zz.replay_case_set (plugin_id, version, source_snapshot_digest, split_seed, created_at)
    values ($1::uuid, $2, $3, $4, now())
    returning id::text as id`,
    [plan.pluginId, version, plan.snapshotDigest, splitSeed]);
  const caseSetId = caseSetRow.rows[0]?.id;
  if (!caseSetId) throw new Error("insert into zz.replay_case_set produced no row");

  const record = async (asked: Parameters<typeof insertEvaluatorAnswer>[1]) =>
    (await insertEvaluatorAnswer(client, asked)).assessment_id;
  const derived: DerivedCase[] = [];
  for (const c of plan.classified) {
    derived.push(await deriveCase(c, record, plan.qualified, plan.scoringPolicy, plan.protocolVersionId));
  }

  const splitInput: SplitCase[] = derived.map((c) => ({
    case_digest: c.caseDigest, replayable: c.status === "replayable",
  }));
  const assigned = assignSplits(splitInput, splitSeed, plan.splitPolicy);

  for (const c of derived) {
    await writeCase(client, caseSetId, c, assigned.get(c.caseDigest) ?? null);
  }

  const counts: Counts = { evolve: 0, validation: 0, proof: 0, not_replayable: 0 };
  for (const c of derived) {
    if (c.status === "not_replayable") { counts.not_replayable += 1; continue; }
    const split = assigned.get(c.caseDigest);
    if (split) counts[split] += 1;
  }
  const result: BuildResult = {
    case_set_id: caseSetId, version, counts, minimums_met: minimumsMet(counts, plan.splitPolicy),
    source_kind_qualification: plan.qualState,
  };
  return { result, result_table: "zz.replay_case_set", result_id: caseSetId };
}

export function registerReplayCaseTools(server: McpServer): void {
  server.registerTool(
    "replay_case_set_build",
    {
      description:
        "WHEN a plugin's protocol needs FR-24/FR-60 replay evidence derived from real closed " +
        "work: applies FR-60 rules 1-7 in order over every closed initiative source_scope " +
        "names — classifies each source through the registered replay.source_kind evaluator " +
        "(person_statement | agent_record, qualified first through evaluator_qualify's own " +
        "ladder if never qualified before), builds each case's chronological actor/" +
        "user_oracle/evaluation_oracle timeline, and splits every replayable case with " +
        "assignSplits. RETURNS { case_set_id, version, counts: {evolve, validation, proof, " +
        "not_replayable}, minimums_met, source_kind_qualification }. REFUSES an unknown " +
        "subject_version_id or protocol_version_id, a protocol_version_id that is not this " +
        "subject's own plugin's, source_scope naming an initiative that is not closed, and " +
        "source_scope naming nothing. Unchanged source material since the plugin's newest " +
        "case-set version reuses it rather than minting a redundant one; changed material " +
        "always creates a new version, because a case set is never edited. A mutator: writes " +
        "through the FR-59 idempotency ledger, so a retried call with the same " +
        "idempotency_key replays the same version rather than re-deriving it.",
      inputSchema: {
        subject_version_id: z.string(),
        protocol_version_id: z.string(),
        source_scope: z.union([
          z.object({ initiatives: z.array(z.string()).min(1) }),
          z.object({ flow: z.string(), closed_between: z.tuple([z.string(), z.string()]) }),
        ]),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ subject_version_id, protocol_version_id, source_scope, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();

      const pluginId = await pluginOf(p, subject_version_id);
      if (!pluginId) return text("ERROR: unknown subject_version_id — call plugin_locate or plugin_register first");
      const protocol = await resolveProtocol(p, protocol_version_id);
      if (!protocol) return text("ERROR: unknown protocol_version_id");
      if (protocol.pluginId !== pluginId) {
        return text("ERROR: protocol_version_id does not belong to this subject_version_id's plugin");
      }

      const root = await userRoot();
      const scope = source_scope as SourceScope;
      const resolved = resolveInitiatives(root, scope);
      if ("error" in resolved) return text(resolved.error);
      if (!resolved.initiatives.length) {
        return text("ERROR: source_scope names no closed initiative to derive a case from");
      }

      const principal = parseCaller(requestHeaders()).email;

      // A retry is ruled out before anything is asked: a replayed build neither qualifies nor
      // classifies. Every model call a fresh build makes happens below, before the transaction.
      const args = { subject_version_id, protocol_version_id, source_scope };
      const prior = await decideBeforeWork(principal, "replay_case_set_build", idempotency_key, args);

      const evaluator = await registerEvaluator(SOURCE_KIND_EVALUATOR);
      const qualification = await resolveQualification(
        p, protocol_version_id, evaluator.evaluator_version_id, protocol, principal, !prior.replayed);
      const qualState = qualification.state;
      const qualified = meetsOperational(qualState);

      const protocolRow = (await p.query<{ replay_policy: unknown; scoring_policy: unknown }>(
        "select replay_policy, scoring_policy from zz.eval_protocol_version where id = $1::uuid",
        [protocol_version_id])).rows[0];
      const splitPolicy = splitPolicyOf(protocolRow?.replay_policy ?? null);
      const scoringPolicy = protocolRow?.scoring_policy ?? null;

      const materials = resolved.initiatives.map((init) => buildMaterial(root, init));
      const snapshotDigest = materialDigest(materials, protocol_version_id, scoringPolicy, qualState);

      // Unchanged material (the existing case set's digest) needs no classification at all.
      const unchanged = !prior.replayed && (await latestCaseSet(p, pluginId))?.digest === snapshotDigest;
      const classified: ClassifiedMaterial[] = [];
      if (!prior.replayed && !unchanged) {
        for (const material of materials) {
          classified.push(await classifyMaterial(material, evaluator.evaluator_version_id, qualified, principal));
        }
      }

      const plan: BuildPlan = {
        pluginId, protocolVersionId: protocol_version_id, snapshotDigest, splitPolicy, scoringPolicy,
        qualState, qualified, materialCount: materials.length, classified,
        qualification: qualification.pending,
      };
      const outcome: IdempotencyOutcome<BuildResult> = prior.replayed ? prior : await withIdempotency(
        principal, "replay_case_set_build", idempotency_key, args, (client) => recordBuild(client, plan));

      let result: BuildResult;
      if (outcome.replayed) {
        const row = (await p.query<{ version: number }>(
          "select version from zz.replay_case_set where id = $1::uuid", [outcome.result_id])).rows[0];
        const counts = await countsFor(p, outcome.result_id);
        result = {
          case_set_id: outcome.result_id, version: row?.version ?? 0, counts,
          minimums_met: minimumsMet(counts, splitPolicy), source_kind_qualification: qualState,
        };
      } else {
        result = outcome.result;
      }

      logActivity(root, null, {
        user: principal, action: "replay_case_set_build", plugin_id: pluginId,
        case_set_id: result.case_set_id, version: result.version, replayed: outcome.replayed,
      });
      return json(result);
    },
  );
}
