#!/usr/bin/env node
/**
 * checks/skill-row-shape.ts — no statement in the write trees inserts a catalog table or column
 * the phase-3 migration retires.
 *
 * The phase-3 migration dropped `skill_asset` whole and gave `skill` its `flow` instead of a
 * `kind` and its name instead of an `ordinal`, moves `plugin`'s ownership off the `owner_team`
 * text column and the `release_owners` jsonb, and gives `plugin_version_skill` a `skill_id` so its
 * key is `(plugin_version_id, skill_id)`. Every one of those names compiles today and stops
 * being a legal INSERT the moment the migration is applied — and nothing compiles a SQL
 * statement, so the break surfaces as a runtime error on the first path somebody happens to
 * exercise, which for the registration path is a release.
 *
 * DELIBERATE: this reads INSERTs, not readers. `checks/catalog-eval-columns.ts` reads statements
 * for every dropped name, and its own list stops short of `plugin.owner_team`, which is retired by
 * the same migration and is this file's to catch. The two are complementary: that one asks whether
 * a statement can still be *read*, this one asks whether a row can still be *written*.
 *
 * Read, not run. A statement is matched in the file's source with its comments removed, so a
 * paragraph explaining that `insert into zz.plugin (name, owner_team)` is gone does not read as
 * one — while a diagnosis or a failure message that spells a retired column inside a string is
 * still read, and reported, for the reason `checks/dropped-columns.ts` gives: a message telling
 * its reader about a column the schema no longer has is wrong in the message too.
 *
 * DELIBERATE: a `/` opens a comment only where the next character is `/` or `*`. A regex literal
 * is not recognised as a literal, so a `//` inside one would be read as a comment and the
 * statement after it not seen at all — a violation this check misses, never one it invents.
 *
 * A column list is matched only where it is one: every comma-separated part must be a bare
 * identifier, so the arguments of a `values (...)` or a nested `select (...)` are not mistaken for
 * a column list by a statement that names none.
 *
 * EXEMPT: `services/gateway/migrations/` — an applied migration is history. `001_init.sql`
 * created `skill_asset` and defined every column the phase retired; the file that retired them is
 * exactly the file that must still spell them. `checks/dropped-columns.ts:47-51` carries this
 * exemption for the same reason.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { withoutComments } from "../scripts/gate/read.ts";

/** The trees that write to a database. `testing/` holds the mutation report — recorded runs of
 *  planted defects rather than call sites — and `checks/` reads files instead of writing rows. */
const ROOTS = ["services", "packages", "scripts", "deploy"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** The columns each table stops carrying, with what carries the fact now. */
const RETIRED: Record<string, [column: string, instead: string][]> = {
  skill: [
    ["kind", "`flow` — a skill under a flow's directory is a step of that flow's method"],
    ["ordinal", "`name` — order the readers that used it by the skill's name"],
  ],
  plugin: [
    ["owner_team", "`owner_team_id`, resolved through zz.team"],
    ["evolvable", "nothing — a catalog plugin is evolvable by construction"],
    ["release_owners", "`zz.plugin_release_owner`, one row per owner team"],
  ],
};

/** The tables that stop existing, which no statement may write at all. */
const DROPPED = ["skill_asset"];

/** A relation that took a column into its key, so every writer of it has to name that column. */
const MUST_NAME: Record<string, string[]> = {
  // `(plugin_version_id, skill_id)`: a binding names the skill it is a version of, which is what
  // makes a second version of one skill in one plugin version impossible to write.
  plugin_version_skill: ["skill_id"],
};

/** A word that never appears between a table and its column list, so an alias group does not
 *  swallow the keyword that comes next. */
const NOT_AN_ALIAS = new Set(["values", "select", "default"]);

interface Source { path: string; src: string }

function sources(dir: string, out: Source[] = []): Source[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { sources(p, out); continue; }
    if (!/\.(ts|sh)$/.test(name) || p.includes("services/gateway/migrations/")) continue;
    out.push({ path: p, src: readFileSync(p, "utf8") });
  }
  return out;
}

interface Insert { table: string; cols: string[]; line: number }

/** Every `insert into <table> (<columns>)` in a file, with the columns it names. */
function inserts(src: string): Insert[] {
  const out: Insert[] = [];
  const re = /insert\s+into\s+((?:zz\.)?[a-z_]\w*)(?:\s+([a-z_]\w*))?\s*\(([^)]*)\)/gi;
  for (const m of src.matchAll(re)) {
    const word = (m[2] ?? "").toLowerCase();
    if (NOT_AN_ALIAS.has(word)) continue;
    const cols = m[3].split(",").map((c) => c.trim().toLowerCase());
    // A column list is a list of bare names. Anything else is the arguments of a call, and a
    // statement that names no columns is one this cannot report either way.
    if (!cols.length || !cols.every((c) => /^[a-z_]\w*$/.test(c))) continue;
    out.push({
      table: m[1].replace(/^zz\./i, "").toLowerCase(),
      cols,
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

const fail: string[] = [];
let scanned = 0;

// A root that is not there is skipped rather than fatal — a check is run from wherever its
// subject is — and the summary names what was read, so a run that scanned nothing says so.
const present = ROOTS.filter((r) => existsSync(r));
const absent = ROOTS.filter((r) => !existsSync(r));

for (const { path, src } of present.flatMap((r) => sources(r))) {
  const sql = withoutComments(src);
  for (const ins of inserts(sql)) {
    scanned++;
    if (DROPPED.includes(ins.table)) {
      fail.push(`FAIL: ${path}:${ins.line} — inserts zz.${ins.table}, which this phase drops whole`);
      continue;
    }
    for (const [column, instead] of RETIRED[ins.table] ?? []) {
      // Whole names only, so the column that replaced one is not read as the one it replaced:
      // `owner_team_id` carries `owner_team` and is not it.
      if (ins.cols.includes(column)) {
        fail.push(`FAIL: ${path}:${ins.line} — inserts ${ins.table}.${column}, which this phase ` +
                  `retires; the fact is ${instead}`);
      }
    }
    for (const column of MUST_NAME[ins.table] ?? []) {
      if (!ins.cols.includes(column)) {
        fail.push(`FAIL: ${path}:${ins.line} — inserts zz.${ins.table} without ${column}, so the row ` +
                  `names no ${column} and the write is refused by the column, at release time`);
      }
    }
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log(`catalog row shape: ${scanned} insert(s) under ${present.join(", ") || "nothing"} name ` +
            "no catalog table or column this phase retires" +
            (absent.length ? ` (${absent.join(", ")} not present)` : ""));
