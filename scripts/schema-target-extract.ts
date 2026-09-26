#!/usr/bin/env node
/**
 * schema-target-extract — the baseline catalog, produced from a real migration run.
 *
 * Default: migrates a throwaway PostgreSQL 17 (`scripts/schema/throwaway.ts`) off
 * `services/gateway/migrations/001_init.sql`, reads its catalog (`scripts/schema/catalog.ts`)
 * and writes `schema-target.ts` plus `schema-target/part-N.ts` at the repository root.
 *
 * `--check`: does the same extraction but writes nothing. It compares the freshly generated
 * files against what is committed and exits non-zero on the first difference, naming the first
 * table (in sorted order) whose catalog entry no longer matches the commit — or, if every
 * table's data still matches but a generated file's bytes differ regardless (a serializer or
 * chunking change with no schema change behind it), naming that file instead.
 *
 * Errors:
 *  - Docker not running: `withThrowawayDb` throws naming Docker; this prints it and exits 1.
 *  - A migration fails: `initPlatformDb`'s own error propagates; this prints it and exits 1.
 *  - `--check` finds a difference: exits 1 after printing what differs, per above.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { root } from "./deployment.ts";
import { readCatalog } from "./schema/catalog.ts";
import { generateFiles } from "./schema/serialize.ts";
import { withThrowawayDb } from "./schema/throwaway.ts";
import type { SchemaTarget, TableTarget } from "./schema/types.ts";

const check = process.argv.includes("--check");

/** Deep-equal over the plain JSON-shaped values a `TableTarget` is made of. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    return ak.join("\u0000") === bk.join("\u0000")
      && ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** The committed `SCHEMA_TARGET.tables`, or `{}` when `schema-target.ts` does not exist yet —
 *  the first run has nothing to compare against. Imported rather than parsed: it is plain
 *  data with no side effects, and this is the same shape `readCatalog` produces. */
async function committedTables(): Promise<Record<string, TableTarget>> {
  const path = join(root, "schema-target.ts");
  if (!existsSync(path)) return {};
  const mod = (await import(pathToFileURL(path).href)) as { SCHEMA_TARGET: SchemaTarget };
  return mod.SCHEMA_TARGET.tables;
}

function writeFiles(files: { path: string; content: string }[]): void {
  rmSync(join(root, "schema-target"), { recursive: true, force: true });
  mkdirSync(join(root, "schema-target"), { recursive: true });
  for (const f of files) writeFileSync(join(root, f.path), f.content);
}

/** Every existing `schema-target/part-*.ts` path, so `--check` also catches a stale part left
 *  over from a run that produced fewer chunks than before. */
function existingPartPaths(): string[] {
  const dir = join(root, "schema-target");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => join("schema-target", f)).sort();
}

async function main(): Promise<void> {
  const tables = await withThrowawayDb((client) => readCatalog(client));
  const count = Object.keys(tables).length;
  const generated = generateFiles(tables);

  if (!check) {
    writeFiles(generated);
    console.log(`schema-target-extract: wrote ${generated.length} file(s), ${count} design tables`);
    return;
  }

  const generatedByPath = new Map(generated.map((f) => [f.path, f.content]));
  const onDiskPaths = new Set([...existingPartPaths(), "schema-target.ts"]);
  const allPaths = new Set([...generatedByPath.keys(), ...onDiskPaths]);
  let filesDiffer = false;
  for (const p of allPaths) {
    const onDisk = existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null;
    if (onDisk !== (generatedByPath.get(p) ?? null)) { filesDiffer = true; break; }
  }

  if (!filesDiffer) {
    console.log(`schema-target-extract --check: ok, ${count} design tables match the commit byte for byte`);
    return;
  }

  const old = await committedTables();
  const names = [...new Set([...Object.keys(tables), ...Object.keys(old)])].sort();
  const firstTable = names.find((n) => !deepEqual(tables[n], old[n]));
  if (firstTable !== undefined) {
    const was = old[firstTable] === undefined ? "absent from the commit"
      : tables[firstTable] === undefined ? "no longer in the live catalog"
      : "differs from the commit";
    console.error(`schema-target-extract --check: table "${firstTable}" ${was}`);
    process.exitCode = 1;
    return;
  }

  // Every table's data matches, so the mismatch is in how it was serialized or chunked.
  const firstFile = [...allPaths].sort().find((p) => {
    const onDisk = existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null;
    return onDisk !== (generatedByPath.get(p) ?? null);
  });
  console.error(`schema-target-extract --check: every table's data matches the commit, but `
    + `"${firstFile}" differs byte for byte — the serializer or its chunking changed with no `
    + "schema change behind it");
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
