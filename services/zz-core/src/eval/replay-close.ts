/**
 * `replay_begin` and `replay_close`: the two writes that move a `zz.replay_run` through its own
 * lifecycle once `replay_start` (`replay-runs.ts`) has registered it — `registered -> running`
 * when the launcher actually starts, and `running | registered -> completed | failed |
 * cancelled` when it ends. Split out of `replay-runs.ts` when both gained a guard; the teardown
 * they share with the expiry sweep stays there (`closeRun`).
 *
 * `lifecycleGuard` is the one decision both tools make before they write, and it exists because
 * the candidate session holds a real credential for this same door. `provisionReplayTeam` issues
 * the run's PAT to the SAME principal who started the run, so `parseCaller().email` cannot tell
 * the launcher from the candidate: both answer as that principal. The difference is the binding
 * — the candidate's PAT is confined to the run's own `replay-` team, which the gateway forwards
 * as `x-zz-pat-team` — so a caller whose token is bound to any `replay-` team is a candidate,
 * and is refused. Without that, a candidate could close its own run `completed` with whatever
 * `produced` it liked, which is what `replay_score` then judges.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller, REPLAY_TEAM_PREFIX, teardownReplayTeam } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { platformEvent } from "../indexing.js";
import { db } from "../platform-db.js";
import { Refusal } from "../refusal.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no replay run can be begun or closed");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? "";

const CLOSE_STATUSES = ["completed", "failed", "cancelled"] as const;
/** The statuses a run is still live in — the only ones either tool moves a run out of. A
 *  terminal run (closed, swept `cancelled` by `sweepExpired`, abandoned) stays what it is. */
const LIVE_STATUSES: readonly string[] = ["registered", "running"];

interface RunRow { principal: string; team_slug: string; status: string; pat_id: string }

/** The candidate check on its own: a credential bound to ANY reserved `replay-` team is one a
 *  candidate session holds, refused whoever it names — not only this run's own. Every such
 *  credential is issued to the same principal who started its run, so a candidate running for run
 *  A would otherwise pass as that principal on run B (a concurrent or earlier replay) and close or
 *  score it. Nothing but `provisionReplayTeam` ever makes a `replay-` team (`team_create` refuses
 *  the prefix), so the prefix alone names a candidate. Exported for `replay-score.ts`, which
 *  refuses the same credential the same way — one sentence, never two that drift. */
export function candidateCredentialRefusal(tool: string, patTeam: string | null, teamSlug: string): string | null {
  if (!patTeam?.startsWith(REPLAY_TEAM_PREFIX)) return null;
  const whose = patTeam === teamSlug ? "the run's own replay team" : `another run's replay team ('${patTeam}')`;
  return `ERROR: ${tool} refuses a credential scoped to ${whose} ` +
    `(this run's is '${teamSlug}') — that is a candidate's credential; the launcher calls ${tool} ` +
    "with its own";
}

/** Null when `caller` may move `run` on; otherwise the refusal text. Pure — the plan's check
 *  (`checks/replay-isolation-pure.ts`) proves each branch on values alone. In order:
 *    - a credential bound to the run's own team is the candidate's — refused whoever it names;
 *    - any other principal than the one who started the run — refused;
 *    - a run no longer live — refused, so a swept or already-closed run is never rewritten
 *      (the launcher closing `completed` over a sweep's `cancelled` was exactly that). */
export function lifecycleGuard(
  tool: "replay_begin" | "replay_close",
  caller: { principal: string; patTeam: string | null },
  run: { principal: string; team_slug: string; status: string },
): string | null {
  const candidate = candidateCredentialRefusal(tool, caller.patTeam, run.team_slug);
  if (candidate) return candidate;
  if (caller.principal !== run.principal) {
    return `ERROR: ${tool} is for the principal who started this run, not ${caller.principal}`;
  }
  if (!LIVE_STATUSES.includes(run.status)) {
    return `ERROR: this replay run is already ${run.status} — ${tool} moves only a registered ` +
      "or running run";
  }
  return null;
}

async function lockRun(client: pg.PoolClient, id: string): Promise<RunRow> {
  const row = (await client.query<RunRow>(
    `select principal, team_slug, status, pat_id::text as pat_id
       from zz.replay_run where id = $1::uuid for update`, [id])).rows[0];
  if (!row) throw new Refusal(`ERROR: unknown replay_run_id ${id}`);
  return row;
}

function callerOf(): { principal: string; patTeam: string | null } {
  return { principal: parseCaller(requestHeaders()).email, patTeam: one(requestHeaders()["x-zz-pat-team"]) || null };
}

interface BeginResult { status: "running"; expires_at: string }
interface CloseResult { archived: boolean; revoked: boolean }

export function registerReplayCloseTools(server: McpServer): void {
  server.registerTool(
    "replay_begin",
    {
      description:
        "WHEN the launcher (npm run replay) actually starts executing a registered replay run: " +
        "moves it registered -> running, so a reader can tell a run somebody is executing from one " +
        "only registered; its expiry (and its PAT's) stays what replay_start set. RETURNS " +
        "{ status: 'running', expires_at }. REFUSES an unknown replay_run_id; a credential scoped " +
        "to any reserved replay- team (a candidate's); any principal but the one who started " +
        "the run; a run already completed, failed or cancelled (swept); and a deployment with no " +
        "platform database. A mutator: writes through the FR-59 idempotency ledger.",
      inputSchema: {
        replay_run_id: z.string(),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ replay_run_id, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();
      if (!UUID_RE.test(replay_run_id)) return text(`ERROR: unknown replay_run_id ${replay_run_id}`);

      const caller = callerOf();
      const outcome: IdempotencyOutcome<BeginResult> = await withIdempotency(
        caller.principal, "replay_begin", idempotency_key, { replay_run_id },
        async (client): Promise<MutatorOutcome<BeginResult>> => {
          const run = await lockRun(client, replay_run_id);
          const refused = lifecycleGuard("replay_begin", caller, run);
          if (refused) throw new Refusal(refused);
          // DELIBERATE: the expiry is left exactly as replay_start wrote it. The run's and its PAT's
          // expiry move together only through provisionReplayTeam/issuePat — a second write path
          // onto zz.pat here would be a second credential mechanism (pat.ts's own rule) — and
          // REPLAY_RUN_TTL_MS is sized to outlast a whole launch started straight after replay_start.
          const row = (await client.query<{ expires_at: string }>(
            "update zz.replay_run set status = 'running' where id = $1::uuid returning expires_at::text as expires_at",
            [replay_run_id])).rows[0];
          platformEvent({
            actor: caller.principal, kind: "replay_run.begun", subject: replay_run_id, team: run.team_slug,
            detail: { team_slug: run.team_slug, from: run.status, expires_at: row.expires_at },
          });
          return { result: { status: "running", expires_at: row.expires_at }, result_table: "zz.replay_run", result_id: replay_run_id };
        },
      );
      if (!outcome.replayed) return json(outcome.result);
      const row = (await p.query<{ status: string; expires_at: string }>(
        "select status, expires_at from zz.replay_run where id = $1::uuid", [outcome.result_id])).rows[0];
      return json({ status: row?.status ?? "unknown", expires_at: row?.expires_at ?? null });
    },
  );

  server.registerTool(
    "replay_close",
    {
      description:
        "WHEN a candidate or subject execution has finished, failed or been cancelled: records " +
        "the terminal status and, when given, the run's model_usage/cost/duration_ms/produced " +
        "(protocol/environment identity was already stored by replay_start), then tears down its " +
        "reserved team and PAT (teardownReplayTeam, Task I-15). produced is the launcher's " +
        "bounded, redacted record of what the session actually produced: { transcript, " +
        "artifacts: [{ path, sha256, bytes, head }] } — what replay_score reads to build the text " +
        "a model-backed measure is asked to judge. No score is accepted here: replay_score " +
        "computes and stores it from produced. RETURNS { archived, revoked }; a retry with the " +
        "same idempotency_key replays and re-reads the live teardown state. REFUSES an unknown " +
        "replay_run_id; a credential scoped to any reserved replay- team (a candidate's); any " +
        "principal but the one who started the run; a run already completed, failed or " +
        "cancelled — a swept run stays cancelled; and a deployment with no platform database. " +
        "A mutator: writes through the FR-59 idempotency ledger, and records one admin audit " +
        "event in zz.event for the team it archives and the PAT it revokes.",
      inputSchema: {
        replay_run_id: z.string(),
        status: z.enum(CLOSE_STATUSES),
        result: z.object({
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

      const caller = callerOf();
      const outcome: IdempotencyOutcome<CloseResult> = await withIdempotency(
        caller.principal, "replay_close", idempotency_key, { replay_run_id, status, result: result ?? null },
        async (client): Promise<MutatorOutcome<CloseResult>> => {
          const run = await lockRun(client, replay_run_id);
          const refused = lifecycleGuard("replay_close", caller, run);
          if (refused) throw new Refusal(refused);
          await client.query(
            `update zz.replay_run
                set status = $2,
                    model_usage = coalesce($3::jsonb, model_usage),
                    cost = coalesce($4::numeric, cost),
                    duration_ms = coalesce($5::bigint, duration_ms),
                    produced = coalesce($6::jsonb, produced)
              where id = $1::uuid`,
            [replay_run_id, status,
             result?.model_usage ? JSON.stringify(result.model_usage) : null,
             result?.cost ?? null, result?.duration_ms ?? null,
             result?.produced ? JSON.stringify(result.produced) : null]);

          const { archived, revoked } = await teardownReplayTeam(client, { teamSlug: run.team_slug, patId: run.pat_id });
          platformEvent({
            actor: caller.principal, kind: "replay_team.torn_down", subject: replay_run_id, team: run.team_slug,
            detail: { team_slug: run.team_slug, pat_id: run.pat_id, status, reason: "closed", archived, revoked },
          });
          return { result: { archived, revoked }, result_table: "zz.replay_run", result_id: replay_run_id };
        },
      );

      if (!outcome.replayed) return json(outcome.result);

      // A replay of the idempotency ledger never re-runs teardownReplayTeam, so the ledger's own
      // ids are the only thing it hands back. teardownReplayTeam is safe to call again for real
      // here — both halves answer false for a team already archived and a PAT already revoked —
      // so a retry reads the live state, not a cached guess at it.
      const run = (await p.query<{ team_slug: string; pat_id: string }>(
        "select team_slug, pat_id::text as pat_id from zz.replay_run where id = $1::uuid", [outcome.result_id],
      )).rows[0];
      if (!run) return json({ archived: false, revoked: false } satisfies CloseResult);
      return json(await teardownReplayTeam(p, { teamSlug: run.team_slug, patId: run.pat_id }));
    },
  );
}
