/**
 * `replay_start`, `replay_read`, `replay_close` (Task I-16, FR-28 to FR-33, AC-29.1 to AC-33.1):
 * one isolated execution of a candidate or subject against one replay case, in the reserved
 * `replay-` team Task I-15's `provisionReplayTeam`/`teardownReplayTeam` (`@zz/contracts`) create
 * and tear down for it.
 *
 * `dependencyAction` and `sealedRows` are the two pure decisions FR-28 to FR-30 turn on, exported
 * for the plan's own `checks/eval-replay-safety.ts` and for every adapter and search-facing read
 * to share — a dependency surface never gets a second, ad hoc verdict written somewhere else, and
 * a proof-split case never gets a second, ad hoc redaction written somewhere else either.
 *   - `dependencyAction`: what a protocol's declared replay mode (`sandbox` | `recorded` |
 *     `simulated` | `live_read_only` | `non_replayable`) resolves one dependency request to. The
 *     mode itself is read off `zz.eval_protocol_version.replay_policy.dependencies`
 *     (`ReplayDependencyPolicy[]`, `@zz/contracts`) — `replay_start`'s own `dependency_modes`
 *     output is that same list, validated here for the one property FR-28 requires of it: every
 *     surface names exactly one mode. Whatever runs a request against the sandbox (Task I-31)
 *     calls `dependencyAction` per request, with that request's own `is_write`/`matcher_accepts`
 *     — this file does not execute a case, only registers, reads and closes the run around it.
 *   - `sealedRows`: FR-30's own boundary. A `search` context never sees a `split: "proof"` row,
 *     whether that row is a case (`replay_read`) or one of several (nothing here batches rows
 *     today, but the function is written generically because a proof case is exactly as sealed
 *     read one at a time as read many at a time).
 *
 * verifier_token (the plan's own Errors clause): a `context: "verifier"` call must present one,
 * checked against `zz.replay_verifier_token` (migration 079) — real validation, not a stub.
 * `candidate_prove` (Task I-21, `candidate-prove.ts`) is the only writer of that table: it mints
 * one token per proof allocation it opens, so a verifier request only ever succeeds for a run the
 * IMPROVE agent is driving against an actual, still-open proof.
 *
 * Every admin write here — the team `provisionReplayTeam` creates and the PAT it issues, the team
 * `teardownReplayTeam` archives and the PAT it revokes — is recorded in `zz.event` through
 * `platformEvent` (`../indexing.js`), the same path every other admin write in this service uses.
 * Task I-15 provisioned and tore down a team with no such record; this task is what closes that
 * gap, so an access review reading `zz.event` sees a replay team's whole life, not half of it.
 *
 * Migration 082 (Task I-22, fix dispatch on a defect Task I-21 left): `replay_start` now stamps
 * every verifier-context `zz.replay_run` row with `verifier_allocation_id`, the exact
 * `zz.replay_verifier_token` row its own `verifier_token` argument resolved to. Before this, a
 * baseline-side proof run (no `candidate_id` of its own) was distinguishable from another
 * candidate's own baseline-side proof runs only by `base_subject_version_id` — nothing at all
 * when two candidates prove the SAME base subject against the SAME case set concurrently. This
 * column is what lets `candidate-prove.ts`'s own `cancelProofRuns` scope an abandon to exactly
 * the one allocation it opened.
 */
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  EVAL_STATE_ENUMS, parseCaller, provisionReplayTeam, ReplayDependencyPolicy, sha256,
  teardownReplayTeam, type Db,
} from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { canonicalJson, withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { visibleEvents } from "./replay-cases.js";
import { platformEvent } from "../indexing.js";
import { db } from "../platform-db.js";
import { Refusal } from "../refusal.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no replay run can be started, read or closed");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPLAY_CASE_SPLITS = EVAL_STATE_ENUMS.replayCaseSplit;
const CLOSE_STATUSES = ["completed", "failed", "cancelled"] as const;
const CONTEXTS = ["search", "verifier"] as const;
// I-17's own addition (launch.ts, worker report): `replay_read`'s `role` argument, so the
// launcher can read a case's events through the one function that already gates them by role
// (`visibleEvents`) instead of a second, ad hoc filter living in packages/tools. Same three
// names `visibleEvents` already recognises.
const READ_ROLES = ["actor", "simulated_person", "evaluator"] as const;

// How long a replay team's PAT — and the run it belongs to — lives before replay_start's own
// expiry sweep (AC-29.1) reclaims it. Long enough for one case to run, short enough that a
// crashed or abandoned caller does not squat on the reserved `replay-` namespace indefinitely.
// DELIBERATE: not a caller-supplied argument — the plan's own signature carries none, and a
// per-call TTL would be a second, silent policy nobody agreed to.
const REPLAY_RUN_TTL_MS = 60 * 60 * 1000;

const PROOF_SEALED = "ERROR: proof is sealed";
const VERIFIER_REFUSED =
  "ERROR: verifier_token invalid, expired or revoked. A verifier context requires a token " +
  "minted by candidate_prove for this proof allocation — open one there before driving a " +
  "verifier-context replay against it.";

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? "";

// `Db` (`@zz/contracts`, `pat.ts`) rather than a locally declared `Queryable`: every helper
// below eventually hands its runner to `provisionReplayTeam`/`teardownReplayTeam`, which take
// `Db`, and a second, differently-shaped interface for "a pool or a client" would not be
// assignable to it — generic methods are not structurally compatible across two independently
// declared signatures, only across the same one.
//
// -------------------------------------------------------------------------------------------
// dependencyAction / sealedRows — pure, exported, the plan's own check target.

type DependencyOutcome = "sandbox" | "serve_recorded" | "simulate" | "live_read" | "not_replayable";

/** One dependency request resolved against its surface's declared replay mode (FR-28 to FR-30).
 *  `is_write`/`matcher_accepts` describe the one request being resolved, never the surface as a
 *  whole — a `recorded` surface can serve some requests and refuse others in the same run,
 *  exactly as the events it was recorded from did. */
export function dependencyAction(args: {
  mode: string; is_write: boolean; matcher_accepts: boolean;
}): DependencyOutcome {
  switch (args.mode) {
    // The replay team's own ZZ surfaces stand in for the real dependency — every request,
    // written or not, is safe to make for real.
    case "sandbox": return "sandbox";
    // A recorded response is served only when the protocol's matcher accepts this exact
    // request (FR-29's own words) — never fabricated for a request the recording never saw.
    case "recorded": return args.matcher_accepts ? "serve_recorded" : "not_replayable";
    // A declared simulator evaluator stands in for the surface, write or not.
    case "simulated": return "simulate";
    // A live surface may be read, never written — FR-28's "a state-changing surface with no
    // sandbox makes the case not_replayable", applied per request.
    case "live_read_only": return args.is_write ? "not_replayable" : "live_read";
    // Refused outright, whatever the request looks like.
    case "non_replayable": return "not_replayable";
    default:
      throw new Error(`dependencyAction: "${args.mode}" is not a registered replay mode`);
  }
}

/** FR-30's own boundary, applied to whatever rows a reader is about to hand back: a `search`
 *  context never sees a `split: "proof"` row. Generic over the row shape — a case, a run, a
 *  result reference — because the boundary is the same whichever of those is being read. */
export function sealedRows<T extends { split: string | null }>(rows: readonly T[], context: string): T[] {
  if (context === "search") return rows.filter((r) => r.split !== "proof");
  return rows.slice();
}

/** The launcher's own boundary (I-17, agreed with the orchestrator as a `replay_read`
 *  extension rather than a new tool): a credential bound to a run's OWN reserved `replay-`
 *  team is the credential the CANDIDATE session holds, and that session must only ever read
 *  `actor` events — even if it reaches this door directly with the PAT it was handed, rather
 *  than through the launcher's own fetch. `patTeam === teamSlug` is exactly that case: the
 *  caller is acting AS the run's own team. Any other caller (the launching principal's own
 *  unbound credential, reading for the simulated person or the verifier) is unrestricted here
 *  — `requireContext`/`sealedRows` above still gate `evaluator` against a proof case and a
 *  missing `verifier_token`, so this is additive, never a relaxation of either. Null means
 *  allowed; a string is the refusal text. */
export function roleReadGuard(patTeam: string | null, teamSlug: string, role: string): string | null {
  if (patTeam !== teamSlug) return null;
  if (role === "actor") return null;
  return `ERROR: a credential scoped to its own replay run ('${teamSlug}') may only read ` +
    `role: actor events, not role: ${role}`;
}

// -------------------------------------------------------------------------------------------
// verifier_token — real validation against a table only candidate_prove writes a row into.

/** The `zz.replay_verifier_token` row id a presented token names, or null when it is missing,
 *  revoked or expired — real validation, not a stub (Task I-16's own module note). Its id, not a
 *  bare boolean: migration 082's own fix dispatch (this task) needs the exact allocation a
 *  verifier-context `replay_start` call is acting under, so `cancelProofRuns`
 *  (`candidate-prove.ts`) can cancel only the runs THIS allocation spawned, never a different
 *  candidate's own proof runs that happen to share a base subject or case set. */
async function verifierAllocationId(p: Db, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const row = (await p.query<{ id: string }>(
    `select id::text as id from zz.replay_verifier_token
      where token_hash = $1 and revoked_at is null and expires_at > now()`,
    [sha256(token)])).rows[0];
  return row?.id ?? null;
}

/** Shared by replay_start and replay_read — the only two tools the plan's Errors clause names as
 *  taking `context`. A search context is always admitted, with no allocation of its own.
 *  `replay_start` alone uses `verifierAllocationId` on the `ok` branch — see this module's own
 *  header note (migration 082) — replay_read only needs the admit/refuse verdict. */
async function requireContext(
  p: Db, context: string, verifierToken: string | undefined,
): Promise<{ ok: true; verifierAllocationId: string | null } | { ok: false; error: string }> {
  if (context !== "verifier") return { ok: true, verifierAllocationId: null };
  const id = await verifierAllocationId(p, verifierToken);
  return id ? { ok: true, verifierAllocationId: id } : { ok: false, error: VERIFIER_REFUSED };
}

// -------------------------------------------------------------------------------------------
// Case set / protocol / case lookups.

async function caseSetPlugin(p: Db, caseSetId: string): Promise<string | null> {
  if (!UUID_RE.test(caseSetId)) return null;
  const row = (await p.query<{ plugin_id: string }>(
    "select plugin_id::text as plugin_id from zz.replay_case_set where id = $1::uuid", [caseSetId])).rows[0];
  return row?.plugin_id ?? null;
}

async function pluginSlug(p: Db, pluginId: string): Promise<string | null> {
  const row = (await p.query<{ name: string }>("select name from zz.plugin where id = $1::uuid", [pluginId])).rows[0];
  return row?.name ?? null;
}

/** Fix 4: `subject_version_id` got the same "nothing minted" treatment `candidate_id` already
 *  had — without it, an unknown `subject_version_id` reached `zz.replay_run`'s own FK constraint
 *  (`subject_version_id uuid null references zz.eval_subject_version(id)`) and came back as a
 *  raw postgres error rather than a house-style refusal. Exported and pure over its inputs (no
 *  `requestHeaders()`) so a check can call it directly against a live pool without a request
 *  context. Returns the refusal text, or null when the id is fine to proceed with (including
 *  `undefined`, since `replay_start`'s own exactly-one-of check runs before this and already
 *  rejects neither/both). */
export async function resolveSubjectOrCandidate(
  p: Db, subjectVersionId: string | undefined, candidateId: string | undefined,
): Promise<string | null> {
  if (candidateId) {
    if (!UUID_RE.test(candidateId)) return `ERROR: unknown candidate_id ${candidateId}`;
    const cand = (await p.query<{ id: string }>(
      "select id::text as id from zz.candidate where id = $1::uuid", [candidateId])).rows[0];
    if (!cand) return `ERROR: unknown candidate_id ${candidateId}`;
  }
  if (subjectVersionId) {
    if (!UUID_RE.test(subjectVersionId)) return `ERROR: unknown subject_version_id ${subjectVersionId}`;
    const sv = (await p.query<{ id: string }>(
      "select id::text as id from zz.eval_subject_version where id = $1::uuid", [subjectVersionId])).rows[0];
    if (!sv) return `ERROR: unknown subject_version_id ${subjectVersionId}`;
  }
  return null;
}

interface DependencyMode { surface: string; mode: string }
interface PluginProtocol { protocolVersionId: string; dependencies: DependencyMode[] }

/** The plugin's newest protocol version and its declared dependency modes (FR-28: "every
 *  dependency surface resolves to exactly one declared replay mode"), read off
 *  `replay_policy.dependencies` — `EvaluationProtocol.replay` (`@zz/contracts`), stored under
 *  that snake_case column exactly as `protocol-record.ts` writes it. A malformed entry is the
 *  protocol's own defect and is dropped rather than failing every replay of this plugin; a
 *  surface named twice is refused outright, because two different modes for one surface is not
 *  "exactly one" whatever either of them says. */
async function pluginProtocol(p: Db, pluginId: string): Promise<PluginProtocol | null> {
  const row = (await p.query<{ id: string; replay_policy: unknown }>(`
    select epv.id::text as id, epv.replay_policy
      from zz.eval_protocol_version epv
      join zz.eval_protocol ep on ep.id = epv.protocol_id
     where ep.plugin_id = $1::uuid
     order by epv.version desc
     limit 1`, [pluginId])).rows[0];
  if (!row) return null;

  const rawDeps = (row.replay_policy as { dependencies?: unknown } | null)?.dependencies;
  const dependencies: DependencyMode[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(rawDeps) ? rawDeps : []) {
    const parsed = ReplayDependencyPolicy.safeParse(entry);
    if (!parsed.success) continue;
    if (seen.has(parsed.data.surface)) {
      throw new Refusal(
        `ERROR: this protocol declares surface "${parsed.data.surface}" more than once — every ` +
        "dependency surface must resolve to exactly one replay mode");
    }
    seen.add(parsed.data.surface);
    dependencies.push({ surface: parsed.data.surface, mode: parsed.data.mode });
  }
  return { protocolVersionId: row.id, dependencies };
}

/** One available case: `replayable`, in the requested split, with no run against it still
 *  `registered`/`running`. Deterministic order (`c.id`) rather than random, so two callers
 *  racing for the same split do not draw the same case twice by accident — the second one's
 *  `not exists` simply excludes what the first has already claimed.
 *
 *  `caseId`, when given, narrows the same predicate to that one case instead of drawing the
 *  lowest-id one — a completed run leaves its case's `status` and every other run's exclusion
 *  untouched, so with no way to name a case a driver repeating `replay_start` against the same
 *  case_set_id/split can never advance past the first case once one run against it has finished
 *  (nothing here marks "already covered"). `candidate_validate`'s own orchestration (Task I-19)
 *  is what needs this: it plans one run per (case, repeat) and hands each plan its own case_id,
 *  never trusting the draw to spread itself across a validation split on its own. */
async function selectCase(client: Db, caseSetId: string, split: string, caseId?: string): Promise<{ id: string } | null> {
  const row = (await client.query<{ id: string }>(`
    select c.id::text as id
      from zz.replay_case c
     where c.case_set_id = $1::uuid and c.split = $2 and c.status = 'replayable'
       and ($3::uuid is null or c.id = $3::uuid)
       and not exists (
         select 1 from zz.replay_run r where r.case_id = c.id and r.status in ('registered', 'running')
       )
     order by c.id
     limit 1`, [caseSetId, split, caseId ?? null])).rows[0];
  return row ?? null;
}

// -------------------------------------------------------------------------------------------
// Teardown, shared by replay_close and replay_start's own expiry sweep — the plan's second
// obligation: every teardown records the admin audit event teardownReplayTeam alone does not.

interface ClosingRun { id: string; team_slug: string; pat_id: string }

/** Exported for `candidate-prove.ts`'s own `candidate_prove(..., abandon: true)` (Task I-21 fix
 *  dispatch, FR-28): abandoning an open proof allocation tears down every still-live replay_run
 *  its verifier_token could have spawned the SAME way replay_close/sweepExpired already do —
 *  never a second, ad hoc teardown that could drift from this one's own admin-event record. */
export async function closeRun(
  p: Db, run: ClosingRun, status: string, actor: string, reason: string,
): Promise<{ archived: boolean; revoked: boolean }> {
  await p.query("update zz.replay_run set status = $2 where id = $1::uuid", [run.id, status]);
  const { archived, revoked } = await teardownReplayTeam(p, { teamSlug: run.team_slug, patId: run.pat_id });
  platformEvent({
    actor, kind: "replay_team.torn_down", subject: run.id, team: run.team_slug,
    detail: { team_slug: run.team_slug, pat_id: run.pat_id, status, reason, archived, revoked },
  });
  return { archived, revoked };
}

/** AC-29.1's first clause and FR-31's own words — "Any `replay_start` or `improvement_start`
 *  call first closes the caller's own runs whose liveness bound has passed" — before
 *  registering anything new, close every one of THIS principal's own runs whose PAT has already
 *  expired: an unreachable sandbox left `registered`/`running` forever otherwise, squatting on
 *  the reserved `replay-` namespace. Scoped to `principal` alone, never every caller's expired
 *  runs: one caller's `replay_start`/`improvement_start` is not the moment to sweep the whole
 *  platform. Exported for `candidates.ts`'s `improvement_start` — the second of the two callers
 *  FR-31 names, never a second implementation of the same sweep. */
export async function sweepExpired(p: Db, principal: string): Promise<void> {
  const { rows } = await p.query<{ id: string; team_slug: string; pat_id: string }>(`
    select id::text as id, team_slug, pat_id::text as pat_id
      from zz.replay_run
     where principal = $1 and status in ('registered', 'running') and expires_at < now()`,
    [principal]);
  for (const run of rows) await closeRun(p, run, "cancelled", principal, "expired");
}

// -------------------------------------------------------------------------------------------
// Tool shapes.

interface StartResult {
  replay_run_id: string; team_slug: string; worktree_ref: string; digest: string;
  token: string | null; token_already_issued: boolean; dependency_modes: DependencyMode[];
}

interface CloseResult { archived: boolean; revoked: boolean }

export function registerReplayRunTools(server: McpServer): void {
  server.registerTool(
    "replay_start",
    {
      description:
        "WHEN a candidate or subject is ready to execute one replay case in isolation: first " +
        "closes the CALLER'S OWN expired replay runs (AC-29.1 — an unreachable sandbox is torn " +
        "down before a new one opens), selects one available replayable case from " +
        "case_set_id's split — case_id, when given, narrows that draw to exactly that case " +
        "(Task I-19's own need: a driver planning several runs per case names each one rather " +
        "than trusting the default lowest-id draw, which never advances past one case once a " +
        "run against it has completed) — provisions a reserved replay- team and PAT for it " +
        "(provisionReplayTeam, Task I-15), and registers a zz.replay_run. RETURNS " +
        "{ replay_run_id, team_slug, worktree_ref, digest, token, token_already_issued, " +
        "dependency_modes: [{surface, mode}] } — token is the new PAT's plaintext on a fresh " +
        "call and null on a same idempotency_key retry, which instead answers " +
        "token_already_issued: true against the same identifiers. dependency_modes is this " +
        "plugin's protocol's own declared surface -> replay mode mapping (sandbox | recorded | " +
        "simulated | live_read_only | non_replayable), what dependencyAction resolves each " +
        "request against once the run is underway. REFUSES a verifier context with no valid " +
        "verifier_token — one minted by candidate_prove for the proof allocation this run is " +
        "part of; a search context naming split: proof (ERROR: proof is " +
        "sealed); neither or both of subject_version_id/candidate_id; an unknown case_set_id; " +
        "a plugin with no recorded protocol version; a split with no available replayable " +
        "case, or, with case_id given, that exact case not being an available replayable one " +
        "in the requested split; an unknown candidate_id; and a deployment with no platform " +
        "database. A mutator: writes through the FR-59 idempotency ledger, and records one " +
        "admin audit event in zz.event for the team it provisions and the PAT it issues.",
      inputSchema: {
        case_set_id: z.string(),
        subject_version_id: z.string().optional()
          .describe("Exactly one of subject_version_id/candidate_id — a subject replay."),
        candidate_id: z.string().optional()
          .describe("Exactly one of subject_version_id/candidate_id — a candidate replay."),
        split: z.enum(REPLAY_CASE_SPLITS),
        case_id: z.string().optional()
          .describe("Steer the draw to this exact case (must be an available replayable case " +
                    "in case_set_id's own split) instead of the default lowest-id draw."),
        repeats: z.number().int().positive()
          .describe("How many times the caller intends to replay the selected case for this " +
                    "run's own statistics — folded into this run's environment digest, so a " +
                    "different repeat count is a different run identity even for the same case."),
        context: z.enum(CONTEXTS).default("search"),
        verifier_token: z.string().optional()
          .describe("Required when context is verifier — minted by candidate_prove for the proof allocation this run is part of."),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ case_set_id, subject_version_id, candidate_id, split, case_id, repeats, context, verifier_token, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();

      const ctx = await requireContext(p, context, verifier_token);
      if (!ctx.ok) return text(ctx.error);
      if (context === "search" && split === "proof") return text(PROOF_SEALED);
      if (!!subject_version_id === !!candidate_id) {
        return text(
          "ERROR: replay_start takes exactly one of subject_version_id or candidate_id, never both or neither");
      }
      // Without this, an unknown candidate_id or subject_version_id reached zz.replay_run's own
      // FK constraints and came back as a raw postgres error rather than a house-style refusal —
      // the same shape every other "nothing minted" check in this file already answers with.
      const subjectErr = await resolveSubjectOrCandidate(p, subject_version_id, candidate_id);
      if (subjectErr) return text(subjectErr);
      // Same shape, same reason: a malformed case_id would otherwise reach selectCase's own
      // `$3::uuid` cast and come back as a raw postgres error.
      if (case_id && !UUID_RE.test(case_id)) return text(`ERROR: unknown case ${case_id}`);

      const pluginId = await caseSetPlugin(p, case_set_id);
      if (!pluginId) return text("ERROR: unknown case set");
      const protocol = await pluginProtocol(p, pluginId);
      if (!protocol) {
        return text(
          "ERROR: this plugin has no recorded protocol version yet — record and affirm one before replay_start");
      }

      const principal = parseCaller(requestHeaders()).email;
      const principalPatTeam = one(requestHeaders()["x-zz-pat-team"]) || null;

      await sweepExpired(p, principal);

      const outcome: IdempotencyOutcome<StartResult> = await withIdempotency(
        principal, "replay_start", idempotency_key,
        { case_set_id, subject_version_id: subject_version_id ?? null, candidate_id: candidate_id ?? null,
          split, case_id: case_id ?? null, repeats, context },
        async (client): Promise<MutatorOutcome<StartResult>> => {
          const chosen = await selectCase(client, case_set_id, split, case_id);
          if (!chosen) {
            throw new Refusal(case_id
              ? `ERROR: case ${case_id} is not an available replayable case in split "${split}" for case set ${case_set_id}`
              : `ERROR: no available replayable case in split "${split}" for case set ${case_set_id}`);
          }

          const runId = randomUUID();
          const expiresAt = new Date(Date.now() + REPLAY_RUN_TTL_MS).toISOString();
          const plugin = await pluginSlug(client, pluginId);
          if (!plugin) throw new Refusal("ERROR: unknown case set"); // the plugin behind it was deleted mid-call

          const { teamSlug, patId, token } = await provisionReplayTeam(client, {
            principal, principalPatTeam, plugin, runId, expiresAt,
          });

          const digest = sha256(canonicalJson({
            case_set_id, case_id: chosen.id, split, repeats,
            subject_version_id: subject_version_id ?? null, candidate_id: candidate_id ?? null,
            protocol_version_id: protocol.protocolVersionId,
          }));
          const worktreeRef = `refs/replay/${teamSlug}`;

          await client.query(
            `insert into zz.replay_run
               (id, case_id, subject_version_id, candidate_id, protocol_version_id,
                environment_digest, sandbox_ref, status, principal, team_slug, pat_id, expires_at,
                verifier_allocation_id, created_at)
             values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, 'registered', $8, $9,
                     $10::uuid, $11, $12::uuid, now())`,
            [runId, chosen.id, subject_version_id ?? null, candidate_id ?? null, protocol.protocolVersionId,
             digest, worktreeRef, principal, teamSlug, patId, expiresAt, ctx.verifierAllocationId]);

          platformEvent({
            actor: principal, kind: "replay_team.provisioned", subject: runId, team: teamSlug,
            detail: { team_slug: teamSlug, pat_id: patId, case_set_id, case_id: chosen.id, split },
          });

          const result: StartResult = {
            replay_run_id: runId, team_slug: teamSlug, worktree_ref: worktreeRef, digest, token,
            token_already_issued: false, dependency_modes: protocol.dependencies,
          };
          return { result, result_table: "zz.replay_run", result_id: runId };
        },
      );

      if (!outcome.replayed) return json(outcome.result);

      const row = (await p.query<{ team_slug: string; sandbox_ref: string; environment_digest: string }>(
        "select team_slug, sandbox_ref, environment_digest from zz.replay_run where id = $1::uuid",
        [outcome.result_id])).rows[0];
      return json({
        replay_run_id: outcome.result_id, team_slug: row?.team_slug ?? "", worktree_ref: row?.sandbox_ref ?? "",
        digest: row?.environment_digest ?? "", token: null, token_already_issued: true,
        dependency_modes: protocol.dependencies,
      } satisfies StartResult);
    },
  );

  server.registerTool(
    "replay_read",
    {
      description:
        "WHEN a caller needs a replay run's current status and result references, never a live " +
        "sandbox handle: reads one zz.replay_run row, joined to its case's split. RETURNS " +
        "{ replay_run_id, status, case_id, split, subject_version_id, candidate_id, " +
        "protocol_version_id, environment_digest, sandbox_ref, team_slug, score, guardrails, " +
        "model_usage, cost, duration_ms, created_at, subject_plugin, subject_source_locator, " +
        "candidate_patchset } — the result fields answer null until status reaches a " +
        "terminal value; subject_plugin/subject_source_locator resolve for EITHER a " +
        "subject_version_id run or a candidate_id run (Task I-18: through the recorded " +
        "candidate's own base_subject_version_id), null only when that subject was never " +
        "located; candidate_patchset (the recorded diff a candidate replay must apply " +
        "before its session starts) is null for a subject_version_id run. Pass `role` " +
        "(actor | simulated_person | evaluator, the same three replay-cases.ts's visibleEvents " +
        "recognises) to also get `events`: the case's own events, filtered to that role and " +
        "ordered by seq — the one path the launcher (Task I-17) or any other reader uses to see " +
        "a case's timeline, so the FR-25/26 boundary is enforced here rather than re-decided by " +
        "every caller. Read-only; never writes. REFUSES an unknown replay_run_id; a verifier " +
        "context with no valid verifier_token — one minted by candidate_prove for the proof " +
        "allocation this run is part of; ERROR: proof is sealed — a search context " +
        "reading a run whose case is split: proof, which this tool never exposes to a search " +
        "caller; and a credential bound to this run's own reserved team asking for any role " +
        "other than actor — that credential is the one the candidate session holds, and it may " +
        "only ever read actor events.",
      inputSchema: {
        replay_run_id: z.string(),
        context: z.enum(CONTEXTS).default("search"),
        verifier_token: z.string().optional()
          .describe("Required when context is verifier — minted by candidate_prove for the proof allocation this run is part of."),
        role: z.enum(READ_ROLES).optional()
          .describe("Adds `events`, filtered to this role — actor | simulated_person | evaluator."),
      },
    },
    async ({ replay_run_id, context, verifier_token, role }) => {
      const p = db();
      if (!p) return noDb();

      const ctx = await requireContext(p, context, verifier_token);
      if (!ctx.ok) return text(ctx.error);
      if (!UUID_RE.test(replay_run_id)) return text(`ERROR: unknown replay_run_id ${replay_run_id}`);

      const row = (await p.query<{
        id: string; status: string; case_id: string; split: string | null;
        subject_version_id: string | null; candidate_id: string | null; protocol_version_id: string;
        environment_digest: string; sandbox_ref: string; team_slug: string;
        score: unknown; guardrails: unknown; model_usage: unknown; cost: string | null;
        duration_ms: string | null; created_at: string;
        subject_plugin: string | null; subject_source_locator: unknown;
        candidate_patchset: { diff: string; files?: string[] } | null;
      }>(`
        select r.id::text as id, r.status, r.case_id::text as case_id, c.split,
               r.subject_version_id::text as subject_version_id, r.candidate_id::text as candidate_id,
               r.protocol_version_id::text as protocol_version_id, r.environment_digest, r.sandbox_ref,
               r.team_slug, r.score, r.guardrails, r.model_usage, r.cost, r.duration_ms, r.created_at,
               -- I-18: a candidate_id run has no subject_version_id of its own — its plugin comes
               -- from the recorded candidate's own base_subject_version_id instead, through the
               -- SAME zz.eval_subject_version/zz.plugin join, never a second derivation.
               coalesce(pl.name, cand_pl.name) as subject_plugin,
               coalesce(sv.source_locator, cand_sv.source_locator) as subject_source_locator,
               cand.patchset as candidate_patchset
          from zz.replay_run r
          join zz.replay_case c on c.id = r.case_id
          left join zz.eval_subject_version sv on sv.id = r.subject_version_id
          left join zz.plugin pl on pl.id = sv.plugin_id
          left join zz.candidate cand on cand.id = r.candidate_id
          left join zz.eval_subject_version cand_sv on cand_sv.id = cand.base_subject_version_id
          left join zz.plugin cand_pl on cand_pl.id = cand_sv.plugin_id
         where r.id = $1::uuid`, [replay_run_id])).rows[0];
      if (!row) return text(`ERROR: unknown replay_run_id ${replay_run_id}`);

      const [visible] = sealedRows([row], context);
      if (!visible) return text(PROOF_SEALED);

      if (!role) return json(visible);

      const patTeam = one(requestHeaders()["x-zz-pat-team"]) || null;
      const guardErr = roleReadGuard(patTeam, visible.team_slug, role);
      if (guardErr) return text(guardErr);

      const rawEvents = (await p.query<{ seq: number; actor: string; visibility: string; kind: string; payload: unknown }>(
        `select seq, actor, visibility, kind, payload from zz.replay_event where case_id = $1::uuid order by seq`,
        [visible.case_id])).rows;
      const events = visibleEvents(rawEvents, role);
      return json({ ...visible, events });
    },
  );

  server.registerTool(
    "replay_close",
    {
      description:
        "WHEN a candidate or subject execution has finished, failed or been cancelled: records " +
        "the terminal status and, when given, the run's score/guardrails/model_usage/cost/" +
        "duration_ms/produced (protocol/environment identity was already stored by " +
        "replay_start), then tears down its reserved team and PAT (teardownReplayTeam, Task " +
        "I-15). produced (Task I-19's own fix — a replay's score must measure the replay) is " +
        "the launcher's bounded, redacted record of what the session actually produced: " +
        "{ transcript, artifacts: [{ path, sha256, bytes, head }] } — what replay_score reads " +
        "to build the text a model-backed measure is asked to judge, in place of a templated " +
        "sentence naming an id. RETURNS { archived, revoked } — both false on a run whose team " +
        "is already torn down, so a second close is a safe no-op rather than an error. REFUSES " +
        "an unknown replay_run_id and a deployment with no platform database. A mutator: writes " +
        "through the FR-59 idempotency ledger, and records one admin audit event in zz.event " +
        "for the team it archives and the PAT it revokes.",
      inputSchema: {
        replay_run_id: z.string(),
        status: z.enum(CLOSE_STATUSES),
        result: z.object({
          score: z.record(z.string(), z.unknown()).optional(),
          guardrails: z.record(z.string(), z.unknown()).optional(),
          model_usage: z.record(z.string(), z.unknown()).optional(),
          cost: z.number().optional(),
          duration_ms: z.number().optional(),
          produced: z.object({
            transcript: z.string(),
            artifacts: z.array(z.object({
              path: z.string(), sha256: z.string(), bytes: z.number(), head: z.string(),
            })),
          }).optional(),
        }).optional(),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ replay_run_id, status, result, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();
      if (!UUID_RE.test(replay_run_id)) return text(`ERROR: unknown replay_run_id ${replay_run_id}`);

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<CloseResult> = await withIdempotency(
        principal, "replay_close", idempotency_key, { replay_run_id, status, result: result ?? null },
        async (client): Promise<MutatorOutcome<CloseResult>> => {
          // `coalesce(..., <column>)` rather than overwriting with null: `replay_score` (I-19)
          // stores this run's per-case overall on `score` AFTER this same close call has already
          // stored `produced` — the launcher closes the run with its own produced output first,
          // then attempts the verifier (replay_score) against the now-closed run, never the
          // other way around. A bare overwrite here would null out the very score
          // candidate_validate reads back, on every real run, the moment a later call closes it
          // again (a second close is a safe no-op, per this tool's own contract).
          const row = (await client.query<{ team_slug: string; pat_id: string }>(
            `update zz.replay_run
                set status = $2,
                    score = coalesce($3::jsonb, score),
                    guardrails = coalesce($4::jsonb, guardrails),
                    model_usage = coalesce($5::jsonb, model_usage),
                    cost = coalesce($6::numeric, cost),
                    duration_ms = coalesce($7::bigint, duration_ms),
                    produced = coalesce($8::jsonb, produced)
              where id = $1::uuid
             returning team_slug, pat_id::text as pat_id`,
            [replay_run_id, status,
             result?.score ? JSON.stringify(result.score) : null,
             result?.guardrails ? JSON.stringify(result.guardrails) : null,
             result?.model_usage ? JSON.stringify(result.model_usage) : null,
             result?.cost ?? null, result?.duration_ms ?? null,
             result?.produced ? JSON.stringify(result.produced) : null],
          )).rows[0];
          if (!row) throw new Refusal(`ERROR: unknown replay_run_id ${replay_run_id}`);

          const { archived, revoked } = await teardownReplayTeam(client, { teamSlug: row.team_slug, patId: row.pat_id });
          platformEvent({
            actor: principal, kind: "replay_team.torn_down", subject: replay_run_id, team: row.team_slug,
            detail: { team_slug: row.team_slug, pat_id: row.pat_id, status, reason: "closed", archived, revoked },
          });
          return { result: { archived, revoked }, result_table: "zz.replay_run", result_id: replay_run_id };
        },
      );

      if (!outcome.replayed) return json(outcome.result);

      // A replay of the idempotency ledger never re-runs teardownReplayTeam, so the ledger's own
      // ids are the only thing it hands back. teardownReplayTeam is safe to call again for real
      // here — both halves answer false for a team already archived and a PAT already revoked —
      // which is what makes this genuinely idempotent rather than merely deduplicated: a second
      // read of "is it torn down" reflects the live state, not a cached guess at it.
      const run = (await p.query<{ team_slug: string; pat_id: string }>(
        "select team_slug, pat_id::text as pat_id from zz.replay_run where id = $1::uuid", [outcome.result_id],
      )).rows[0];
      if (!run) return json({ archived: false, revoked: false } satisfies CloseResult);
      return json(await teardownReplayTeam(p, { teamSlug: run.team_slug, patId: run.pat_id }));
    },
  );
}
