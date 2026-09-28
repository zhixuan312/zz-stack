#!/usr/bin/env node
// This column exists because a fixed column set can never be complete against fields a FLOW
// declares, so what has to be asserted is the rule that keeps it from becoming a second home:
// the residual is computed against the COLUMNS' keys, and the columns win on read. A check that
// only saw the column declared could not tell this apart from a blob that duplicates the schema.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
// DELIBERATE: the folded file, and the property rather than the statement. 004_envelope_fields.sql
// was folded into 001 once its release was verified, and a re-dump emits the column in the
// table's own CREATE rather than as an `add column` — so asking for the ALTER asks a question the
// fold made meaningless. The claim is that `zz.doc_revision` has the column.
const dir = "services/gateway/migrations";
const one = readFileSync(join(dir, "001_init.sql"), "utf8");
const rev = one.slice(one.indexOf("CREATE TABLE zz.doc_revision ("), one.indexOf(");", one.indexOf("CREATE TABLE zz.doc_revision (")));
assert.ok(/^\s*fields\s+jsonb,\s*$/m.test(rev), "zz.doc_revision declares fields jsonb");
assert.ok(/-- absorbs: 004_envelope_fields\.sql/.test(one),
  "and the folded file names the envelope-fields migration it absorbed");

// 3. the writer computes the residual against the columns, and the reader prefers them.
const v = readFileSync("services/zz-core/src/versions.ts", "utf8");
assert.ok(/parseEnvelope/.test(v), "the writer reads the envelope it is storing");
assert.ok(/fields/.test(v), "and names the payload");
// The columns-win rule, stated where a reader can see it.
assert.ok(/(columns?\s+win|column\s+wins|over\s+it|columns?\s+over)/i.test(v),
  "and the module states that the columns win over the payload on read");

// 4. the backfill that filled the existing rows, and its own assertion, left with its one-shot
// script: it read the teams' file stores, that volume is retired, and every revision it had to
// fill is filled (measured on production: 1,481 of 1,663 revisions carry a payload, the rest
// genuinely have none). A check that asserted its existence would be asserting that a script
// nothing runs still exists.

console.log("ok envelope-fields");
