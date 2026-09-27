#!/usr/bin/env node
/**
 * `scripts/schema/comments.ts` — renders the structured comments `schema-target.ts` declares into
 * the `COMMENT ON` statements a migration carries.
 *
 *   node scripts/schema/comments.ts            # the SQL, on stdout
 *   node scripts/schema/comments.ts --write    # write it into the migrations directory
 *
 * The comments have ONE home: the target. This renders them and never invents one — a table or a
 * column the target declares with no classification is a REFUSAL that names it, not a placeholder
 * comment, because a default is the one thing that makes the standard meaningless. The shape is
 * `SCHEMA.md`'s own template, checked here rather than assumed: a comment that stops at its first
 * token, a `projection` with no rebuild source, a `state_machine` with no transitions or an
 * ephemeral table with no retention is refused the same way.
 *
 * `checks/comment-completeness.ts` is the completeness half — nothing anywhere is missing.
 * `checks/schema-inventory.ts` is the equality half — the migrated catalog's comments are these,
 * entry for entry. This script is the half in between: what a migration is allowed to say at all.
 *
 * `--write` takes the next free number in `services/gateway/migrations/`, or overwrites the
 * `<NNN>_comments.sql` a previous run already wrote, so re-running it is not a second migration.
 *
 * Exit 0: rendered (or written) — one summary line on stderr when writing.
 * Exit 1: a table or column carries no usable comment, or a comment breaks the template. Every
 *         refusal is reported, not just the first, so one run names the whole gap.
 */
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { SCHEMA_TARGET } from "../../schema-target.ts";
import { root } from "../deployment.ts";

const CLASSES = ["current_state", "immutable_history", "state_machine", "relation", "ephemeral", "projection"];
const MIGRATIONS = "services/gateway/migrations";

/** PostgreSQL string literal: a single quote is doubled, which is the whole escape. */
function literal(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** The `key=value` a structured comment carries, or undefined when it does not carry it. */
function field(comment: string, key: string): string | undefined {
  const m = new RegExp(`(?:^|; )${key}=([^;]*)`).exec(comment);
  return m?.[1];
}

/** Every way one comment can fail the contract, as whole sentences naming what is wrong. */
function faults(what: string, comment: string | null | undefined, allow: readonly string[]): string[] {
  const bad: string[] = [];
  if (comment === undefined || comment === null || comment.trim() === "") {
    return [`${what} carries no comment`];
  }
  if (comment.includes("\n")) bad.push(`${what} spans more than one line`);
  const cls = field(comment, "class");
  if (!cls) bad.push(`${what} states no class`);
  else if (!CLASSES.includes(cls)) bad.push(`${what} names class=${cls}, which is not one of the six`);
  if (field(comment, "authority") === undefined) bad.push(`${what} names no authority`);
  const question = field(comment, "question");
  if (!question) bad.push(`${what} asks no question`);
  else if (!question.endsWith("?")) bad.push(`${what} asks a question that does not end in ?`);
  for (const key of ["transitions", "rebuilt_from", "retention"]) {
    if (field(comment, key) !== undefined && !allow.includes(key)) {
      bad.push(`${what} carries ${key}=, which its class does not take`);
    }
  }
  return bad;
}

/** The refusal list for the whole target: every table and every column, in name order. */
function commentFaults(): string[] {
  const bad: string[] = [];
  for (const name of Object.keys(SCHEMA_TARGET.tables).sort()) {
    const t = SCHEMA_TARGET.tables[name];
    const tableClass = field(t.comment ?? "", "class");
    // A table's allowed tails follow from its own class, read rather than guessed: a comment with
    // no readable class has already been reported and gets no tail allowance to argue about.
    // `retention` is allowed on every class: it is a class that makes it MANDATORY (ephemeral) and
    // rule 9 that makes it mandatory for an unbounded table, which is `immutable_history`'s own
    // shape — `zz.event` is the case the rule exists for.
    const allow = ["retention",
      ...(tableClass === "state_machine" ? ["transitions"] : []),
      ...(tableClass === "projection" ? ["rebuilt_from"] : [])];
    bad.push(...faults(`table ${name}`, t.comment, allow));
    if (field(t.comment ?? "", "authority") !== "this") {
      bad.push(`table ${name} does not name itself as its authority — the table template fixes authority=this`);
    }
    // A `projection` and an unbounded table say so in their own words; the two classes the
    // contract makes mandatory are checked here, and `checks/schema-inventory.ts` holds the
    // database to whatever this renders.
    if (tableClass === "projection" && !field(t.comment ?? "", "rebuilt_from")) {
      bad.push(`table ${name} is a projection and names no rebuilt_from`);
    }
    if (tableClass === "ephemeral" && !field(t.comment ?? "", "retention")) {
      bad.push(`table ${name} is ephemeral and names no retention`);
    }
    for (const [col] of t.columns) {
      const c = t.columnComments?.[col];
      const colClass = field(c ?? "", "class");
      const colAllow = colClass === "projection" ? ["rebuilt_from"] : [];
      bad.push(...faults(`column ${name}.${col}`, c, colAllow));
      const auth = field(c ?? "", "authority");
      if (colClass === "projection" && auth === "this") {
        bad.push(`column ${name}.${col} is a projection and names itself as its authority`);
      }
      if (colClass !== undefined && colClass !== "projection" && auth !== undefined && auth !== "this") {
        bad.push(`column ${name}.${col} names authority=${auth} without being a projection`);
      }
    }
  }
  return bad;
}

/** Every `COMMENT ON` the target declares, sorted by table then by the column's own order. */
function renderComments(): string {
  const lines: string[] = [
    "-- <NNN>_comments.sql — every table and every column of the delivered schema, commented.",
    "--",
    "-- Rendered from `schema-target.ts` by `scripts/schema/comments.ts`. The target is the comments'",
    "-- one home: this file is a rendering of it and never a second place a comment is written. A",
    "-- table or column the target declares with no classification is refused by that script rather",
    "-- than rendered here with a placeholder, which is why every line below is a real answer.",
    "--",
    "-- The shape is `SCHEMA.md`'s contract — `class`, `authority` and a one-sentence `question`, with",
    "-- `transitions` on a state_machine, `rebuilt_from` on a projection and `retention` on an",
    "-- ephemeral or unbounded table. `checks/comment-completeness.ts` proves nothing is missing and",
    "-- `checks/schema-inventory.ts` proves the migrated catalog carries exactly these.",
    "",
  ];
  for (const name of Object.keys(SCHEMA_TARGET.tables).sort()) {
    const t = SCHEMA_TARGET.tables[name];
    lines.push(`COMMENT ON TABLE zz.${name} IS ${literal(t.comment as string)};`);
    for (const [col] of t.columns) {
      lines.push(`COMMENT ON COLUMN zz.${name}.${col} IS ${literal(t.columnComments[col])};`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** The path `--write` writes: the `<NNN>_comments.sql` already written, else the next free number. */
function targetPath(): string {
  const existing = readdirSync(join(root, MIGRATIONS)).filter((f) => /^\d+_comments\.sql$/.test(f));
  if (existing.length > 0) return join(root, MIGRATIONS, existing.sort()[0]);
  const numbers = readdirSync(join(root, MIGRATIONS))
    .map((f) => /^(\d+)_/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return join(root, MIGRATIONS, `${String(Math.max(...numbers) + 1).padStart(3, "0")}_comments.sql`);
}

function main(): void {
  const faultsFound = commentFaults();
  if (faultsFound.length > 0) {
    for (const f of faultsFound) console.error(`comments: ${f}`);
    console.error(`comments: ${faultsFound.length} table(s) or column(s) carry no usable comment — ` +
                  "declare the classification in the area file under schema-target/, never here");
    process.exit(1);
  }

  const sql = renderComments();
  if (!process.argv.includes("--write")) {
    process.stdout.write(sql);
    return;
  }

  const path = targetPath();
  const tables = Object.keys(SCHEMA_TARGET.tables).length;
  const columns = Object.values(SCHEMA_TARGET.tables)
    .reduce((n, t) => n + t.columns.length, 0);
  // The header names the file it actually is, so a re-run under a new number does not leave the
  // old one's name in the comment.
  const named = sql.replace("-- <NNN>_comments.sql", `-- ${path.split("/").pop()}`);
  writeFileSync(path, named);
  console.error(`comments: wrote ${path} — ${tables} tables, ${columns} columns`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
