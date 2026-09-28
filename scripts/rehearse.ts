#!/usr/bin/env node
/**
 * scripts/rehearse.ts — the walking skeleton (← AC-9.5): restore a real production backup into a
 * throwaway container, let the real migration runner do exactly what it would do against
 * production, and prove nothing moved that `scripts/rehearse/expect.ts` did not sign off on.
 *
 *   node scripts/rehearse.ts --dump <zz-db-*.sql.gz>
 *
 * Report, in order: the restore, the migrations the real runner applied (`initPlatformDb` prints
 * these itself as it runs), the inventory result (`compareWithTarget` against `SCHEMA_TARGET`),
 * and a before/after table of row counts, content hashes and key joins — ending `REHEARSAL OK`
 * and exit 0, or the disagreeing lines and exit 1. On a tree with no pending migration this
 * reports zero deltas: nothing runs, so nothing is expected to have moved.
 *
 * Exit codes: 0 rehearsed clean; 1 something disagreed; 2 refused to start — a missing or
 * unreadable `--dump`, or `TEAM_DB_URL`/`PLATFORM_DB_URL` already in the environment.
 */
import { accessSync, constants, existsSync, readdirSync } from "node:fs";

import pg from "pg";

import { root } from "./deployment.ts";
import { compareWithTarget } from "./schema/compare.ts";
import { withThrowawayDb } from "./schema/throwaway.ts";
import { SCHEMA_TARGET } from "../schema-target.ts";
import { diffSnapshots, formatTableReport } from "./rehearse/diff.ts";
import { ALWAYS_LABEL, checkJoins } from "./rehearse/joins.ts";
import { restoreDump } from "./rehearse/restore.ts";
import { captureSnapshot, type Snapshot } from "./rehearse/snapshot.ts";

function resolveFlag(argv: readonly string[], name: string): string | undefined {
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const raw = argv[i + 1];
  if (raw === undefined || raw.startsWith("--")) {
    console.error(`rehearsal REFUSED — ${name} was given with no value after it`);
    process.exit(2);
  }
  return raw;
}

/**
 * DELIBERATE: this runs before argv is even parsed. `withThrowawayDb` refuses the same preset,
 * but only after starting a container — a caller reading "refused before doing anything" from
 * the outside must see the refusal land before that, not after.
 */
function refuseIfDbUrlPreset(): void {
  const preset = process.env.PLATFORM_DB_URL ? "PLATFORM_DB_URL" : process.env.TEAM_DB_URL ? "TEAM_DB_URL" : null;
  if (preset) {
    console.error(`rehearsal REFUSED — ${preset} is set in the environment; this only ever migrates a container it starts itself, never a URL handed to it`);
    process.exit(2);
  }
}

function refuseIfUnreadable(path: string, label: string): void {
  if (!existsSync(path)) {
    console.error(`rehearsal REFUSED — ${label} ${path} does not exist`);
    process.exit(2);
  }
  try {
    accessSync(path, constants.R_OK);
  } catch {
    console.error(`rehearsal REFUSED — ${label} ${path} is not readable`);
    process.exit(2);
  }
}

async function schemaMigrationNames(client: pg.Client): Promise<Set<string>> {
  const { rows } = await client.query<{ name: string }>(`select name from "zz"."schema_migration"`);
  return new Set(rows.map((r) => r.name));
}

/** Every `services/gateway/migrations/*.sql` file not already recorded in `beforeNames` — the
 *  candidates the real runner is about to walk. A migration it defers for a missing extension is
 *  never recorded either, so reading the migrations directory (rather than waiting for the
 *  after-set) is what still names it here. */
function pendingMigrationFiles(beforeNames: ReadonlySet<string>): string[] {
  const dir = `${root}/services/gateway/migrations`;
  return readdirSync(dir).filter((f) => f.endsWith(".sql") && !beforeNames.has(f)).sort();
}

async function main(): Promise<void> {
  refuseIfDbUrlPreset();

  const argv = process.argv.slice(2);
  const dumpPath = resolveFlag(argv, "--dump");
  if (!dumpPath) {
    console.error("rehearsal REFUSED — usage: node scripts/rehearse.ts --dump <zz-db-*.sql.gz>");
    process.exit(2);
  }
  refuseIfUnreadable(dumpPath, "--dump");

  const startedAt = Date.now();
  let before: Snapshot | undefined;
  let pendingMigrations: string[] = [];

  const diffs = await withThrowawayDb(
    async (client) => {
      const allDiffs: string[] = [];

      console.log("");
      console.log("inventory:");
      const inventoryDiffs = await compareWithTarget(client);
      if (inventoryDiffs.length === 0) {
        console.log(`  schema inventory: ${Object.keys(SCHEMA_TARGET.tables).length} tables match phase ${SCHEMA_TARGET.phase}`);
      } else {
        for (const line of inventoryDiffs) console.log(`  ${line}`);
      }
      allDiffs.push(...inventoryDiffs);

      console.log("");
      console.log("row counts and content hashes (before -> after):");
      const after = await captureSnapshot(client, pendingMigrations, "after");
      const { lines, diffs: snapshotDiffs } = diffSnapshots(before ?? {}, after, pendingMigrations);
      for (const line of formatTableReport(lines)) console.log(line);
      allDiffs.push(...snapshotDiffs);

      console.log("");
      console.log("key joins:");
      const { lines: joinLines, diffs: joinDiffs } = await checkJoins(client, pendingMigrations);
      if (joinLines.length === 0) {
        console.log("  none declared — which is itself a disagreement, since the always-run set is never empty");
      } else {
        // The always-run invariants first: they hold of any correct store, and a reader looking
        // for "is this deployment sound" should not have to find them among a migration's own.
        const order = [...joinLines].sort((a, b) =>
          (b.migration === ALWAYS_LABEL ? 1 : 0) - (a.migration === ALWAYS_LABEL ? 1 : 0));
        for (const j of order) {
          console.log(`  ${j.name} (${j.migration === ALWAYS_LABEL ? "every rehearsal" : `from ${j.migration}`}): ${j.violating} violating row(s)`);
        }
      }
      allDiffs.push(...joinDiffs);

      return allDiffs;
    },
    async (url) => {
      console.log(`restore: ${dumpPath} -> throwaway container`);
      await restoreDump(url, dumpPath);
      console.log("restore: done");

      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await client.query("set search_path = ''");
        const beforeNames = await schemaMigrationNames(client);
        // The pending set comes first: the before snapshot is hashed the way these migrations'
        // expectations ask for, and it must be read identically to the after one.
        pendingMigrations = pendingMigrationFiles(beforeNames);
        before = await captureSnapshot(client, pendingMigrations, "before");
        console.log(`migrations: ${pendingMigrations.length === 0 ? "none pending" : `${pendingMigrations.length} pending — ${pendingMigrations.join(", ")}`}`);
      } finally {
        await client.end();
      }
    },
  );

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  if (diffs.length === 0) {
    console.log(`REHEARSAL OK (${elapsed}s)`);
    process.exitCode = 0;
  } else {
    console.error("REHEARSAL DISAGREES:");
    for (const line of diffs) console.error(`  ${line}`);
    console.error(`(${elapsed}s)`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
