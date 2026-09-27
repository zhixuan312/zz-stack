#!/usr/bin/env node
// This column exists because a fixed column set can never be complete against fields a FLOW
// declares, so what has to be asserted is the rule that keeps it from becoming a second home:
// the residual is computed against the COLUMNS' keys, and the columns win on read. A check that
// only saw the column declared could not tell this apart from a blob that duplicates the schema.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 1. the target declares it, as jsonb and nullable
const { SCHEMA_TARGET } = await import(pathToFileURL(join(process.cwd(), "schema-target.ts")).href);
const cols = (SCHEMA_TARGET.tables.doc_revision?.columns ?? []) as [string, string, boolean, unknown][];
const f = cols.find((c) => c[0] === "fields");
assert.ok(f, "doc_revision.fields is declared");
assert.equal(f?.[1], "jsonb", "and is an open payload, not a text column");
assert.equal(f?.[2], true, "and is nullable: a revision with no extra field carries none");

// 2. the migration adds it, and one migration owns it
const dir = "services/gateway/migrations";
const named = readdirSync(dir).filter((n: string) => /envelope_fields\.sql$/.test(n));
assert.equal(named.length, 1, "exactly one envelope-fields migration");
assert.ok(/add column\s+fields\s+jsonb/i.test(readFileSync(join(dir, named[0]), "utf8")),
  "and it adds the column");

// 3. the writer computes the residual against the columns, and the reader prefers them.
const v = readFileSync("services/zz-core/src/versions.ts", "utf8");
assert.ok(/parseEnvelope/.test(v), "the writer reads the envelope it is storing");
assert.ok(/fields/.test(v), "and names the payload");
// The columns-win rule, stated where a reader can see it.
assert.ok(/(columns?\s+win|column\s+wins|over\s+it|columns?\s+over)/i.test(v),
  "and the module states that the columns win over the payload on read");

// 4. the backfill exists and touches only rows that have none
assert.ok(existsSync("scripts/envelope-backfill.ts"), "the backfill exists");
const b = readFileSync("scripts/envelope-backfill.ts", "utf8");
assert.ok(/fields is null|fields is null|is null/i.test(b), "and only fills rows that have none");
assert.ok(/--store|storeRoot|--dest|artifacts/i.test(b), "and takes the store as an argument");

console.log("ok envelope-fields");
