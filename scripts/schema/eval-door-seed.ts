/**
 * scripts/schema/eval-door-seed.ts — one plugin's release, protocol versions, observation, evaluation
 * run and an approved protocol.md, seeded with SQL on a `withThrowawayCore` database, and a client
 * of its `/eval-mcp` door as any person: what the evaluation door's checks stand on.
 */
import { Mcp } from "@zz/mcp-client";

import type { Core } from "./throwaway-core.ts";

export const PLUGIN = "zz-core";
export const VERSION = "0.0.1";
export const LONER = "loner@example.test";
export const OTHER = "other@example.test";
export const SLUG = "2026-10-31-protocol";

/** A client on the evaluation door, as `email`. */
export function evalDoor(c: Core, email: string): Mcp {
  return new Mcp(c.mcp.url.replace(/\/mcp$/, "/eval-mcp"), { client: "zz-eval-check", timeoutMs: 60_000, headers: {
    "x-zz-user-email": email, "x-zz-user-name": email, "x-zz-user-id": "", "x-zz-user-role": "user",
    "x-zz-via": "forwarded", "x-zz-pat-team": "", "x-zz-session-team": "" } });
}

/** The reply, or what the door threw in its place — a raw database error reaches the caller that way. */
export async function ask(door: Mcp, tool: string, args: unknown): Promise<string> {
  try {
    return await door.call(tool, args);
  } catch (err) {
    return `THROWN: ${(err as Error).message}`;
  }
}

export interface Seed {
  pluginId: string; versionId: string; team: string; me: string; other: string;
  protocols: { bound: string; replayed: string }; snapshot: string; run: string;
}

export async function one<T extends Record<string, unknown>>(c: Core, sql: string, params: unknown[] = []): Promise<T> {
  return (await c.sql.query<T>(sql, params)).rows[0];
}

export async function seed(c: Core): Promise<Seed> {
  const me = (await one<{ id: string }>(c, "select id::text as id from zz.principal where email = $1", [c.email])).id;
  const team = (await one<{ id: string }>(c, "select id::text as id from zz.team where slug = $1", [c.team])).id;
  const other = (await one<{ id: string }>(c,
    "insert into zz.principal (email, display_name) values ($1, 'Other') returning id::text as id", [OTHER])).id;
  await c.sql.query("insert into zz.principal (email, display_name) values ($1, 'Loner')", [LONER]);
  await c.sql.query(
    "insert into zz.plugin (name, origin) select $1, 'platform' where not exists (select 1 from zz.plugin where name = $1)",
    [PLUGIN]);
  const pluginId = (await one<{ id: string }>(c, "select id::text as id from zz.plugin where name = $1", [PLUGIN])).id;
  const versionId = (await one<{ id: string }>(c,
    "insert into zz.plugin_version (plugin_id, version, digest) values ($1, $2, 'check') returning id::text as id",
    [pluginId, VERSION])).id;
  const protocol = async (digest: string, version: number) => (await one<{ id: string }>(c,
    `insert into zz.eval_protocol_version
       (version, purpose, qualification_policy, scoring_policy, improvement_policy, content_digest, created_at,
        plugin_id, protocol_key, observable_surfaces, recorded_by)
     values ($4, 'check', '{}', '{}', '{}', $1, now(), $2, 'check', '{}', $3) returning id::text as id`,
    [digest, pluginId, me, version])).id;
  const protocols = { bound: await protocol("digest-bound-0001", 1), replayed: await protocol("digest-replay-0002", 2) };
  const snapshot = (await one<{ id: string }>(c,
    `insert into zz.eval_observation_snapshot
       (usable_run_count, total_run_count, evidence_digest, created_at, plugin_version_id, surface_observed,
        surface_total, platform_version, recorded_by)
     values (0, 0, 'check', now(), $1, 0, 0, '0', $2) returning id::text as id`, [versionId, me])).id;
  const run = (await one<{ id: string }>(c,
    `insert into zz.eval_run (protocol_version_id, created_at, team_id, observation_snapshot_id, started_by)
     values ($1, now(), $2, $3, $4) returning id::text as id`, [protocols.replayed, team, snapshot, me])).id;

  // The seeded team's approved protocol.md under SLUG, quoting both versions' digests.
  const initiative = (await one<{ id: string }>(c,
    "insert into zz.initiative (team_id, slug, flow) values ($1, $2, '') returning id::text as id", [team, SLUG])).id;
  await c.sql.query("BEGIN");
  await c.sql.query("SET CONSTRAINTS ALL DEFERRED");
  const doc = (await one<{ id: string }>(c,
    `insert into zz.doc (initiative_id, path, status, updated_at, current_revision, current_version)
     values ($1, 'protocol.md', 'draft', now(), 1, 1) returning id::text as id`, [initiative])).id;
  await c.sql.query(
    `insert into zz.doc_revision (doc_id, revision, version, content_state, title, body, tags, content_hash,
                                  written_by, written_at, fields, approved_by, approved_at)
     values ($1, 1, 1, 'retained', 'Protocol', $2, '{}', 'h1', $3, now(), '{}', $3, now())`,
    [doc, "# Protocol\n\ndigest-bound-0001 and digest-replay-0002\n", me]);
  await c.sql.query("update zz.doc set status = 'approved', approved_revision = 1 where id = $1", [doc]);
  await c.sql.query("COMMIT");
  return { pluginId, versionId, team, me, other, protocols, snapshot, run };
}

/** A finding of the seeded run, deferred unless `by` has already decided it. */
export async function finding(c: Core, s: Seed, pattern: string, by?: string): Promise<string> {
  return (await one<{ id: string }>(c,
    `insert into zz.eval_finding (pattern, decision, owner_kind, eval_run_id, kind, decided_by, decided_at, decision_note)
     values ($1, $2, 'plugin', $3, 'defect', $4, case when $4::uuid is null then null else now() - interval '1 day' end, $5)
     returning id::text as id`,
    [pattern, by ? "rejected" : "deferred", s.run, by ?? null, by ? "not worth it" : ""])).id;
}
