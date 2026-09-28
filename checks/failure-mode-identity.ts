#!/usr/bin/env node
/**
 * checks/failure-mode-identity.ts — a failure mode is an IDENTITY and a discovery of it is a
 * SIGHTING (AC-6.4, Task I-24).
 *
 * `zz.eval_failure_mode_candidate` was two things in one row: the failure mode — `(plugin_id,
 * stable_key)` — and the finding of it in one snapshot. Two of those facts move in opposite
 * directions, and the split is what stops them fighting: the identity is current state (a later
 * run that finds the same rule on the same tool resolves to the row it already has), and a
 * sighting is immutable history (its prevalence, owner and evidence are that snapshot's, and
 * nothing rewrites them). The phase-3 migration performed the split and dropped the candidate
 * table. This is the static half of proving the split holds:
 *
 *   - a failure mode is identified by `(plugin_id, stable_key)` — the table carries exactly that
 *     unique, and the writer resolves an identity through it rather than minting a second mode;
 *   - a sighting carries its OWN prevalence, owner and evidence — two figures with a constraint,
 *     the owner kind with the vocabulary check, and `evidence_refs`, all on the sighting and none
 *     of them left behind on the identity;
 *   - a sighting's `failure_mode_id` always resolves — `not null` with a foreign key to
 *     `eval_failure_mode(id)`, and never a value the writer invented.
 *
 * Read, not run. The table shapes are read from `SCHEMA_TARGET` — the target is what the migration
 * must produce, and `checks/schema-inventory.ts` is what holds the migration to it — and the
 * statements are read from the four trees that write to a database, with the text after a `--` on
 * each of their lines stripped and each `${callee(…)}` replaced by the literals that callee
 * returns, the way `checks/catalog-eval-columns.ts:229-238` and `checks/skill-row-shape.ts:81-100`
 * do it. The shapes below are the criterion's own clauses, not a restatement of the migration.
 *
 * DELIBERATE: the roots are relative to `process.cwd()`, not to this file's own location, and the
 * schema target is imported from there too, so the check can be pointed at a scratch tree that
 * plants a violation. Run it from the repository root and it reads the repository.
 *
 * EXEMPT, each with the reason it is:
 *
 *   `services/gateway/migrations/` — an applied migration is history. `001_init.sql` declares the
 *   split table, the phase-3 migration that made it having folded back into it; the file that
 *   retires a name is exactly the file that must still spell it. `checks/catalog-eval-columns.ts:44-48` carries this
 *   exemption for the same reason.
 *
 *   `scripts/mutation/specs*.ts` — a mutation spec quotes a statement in order to plant a defect
 *   in it. Its `find`/`replace` text is the subject of the check that owns the spec, and reading
 *   it as a call site would report the defect the spec exists to plant.
 *
 *   `checks/` — deliberately not a scan root. This file spells `zz.eval_failure_mode_candidate`,
 *   `status` and `merged_into_id` to explain the rule it applies, and read as a call site every
 *   one of those is a finding that reads nothing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { withoutComments } from "../scripts/gate/read.ts";
import { pathToFileURL } from "node:url";

/** The trees that write to a database, the same four `checks/catalog-eval-columns.ts` scans. */
const ROOTS = ["services", "packages", "scripts", "deploy"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

const fail: string[] = [];

/** An applied migration is history — see the module doc. */
const isAppliedMigration = (p: string): boolean => p.includes("services/gateway/migrations/");

/** A mutation spec quotes a statement to plant a defect in it — see the module doc. */
const isMutationSpec = (p: string): boolean => /(^|\/)scripts\/mutation\/specs[^/]*\.ts$/.test(p);

interface Source { path: string; src: string }

function sources(dir: string, out: Source[] = []): Source[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { sources(p, out); continue; }
    if (!/\.(ts|sh)$/.test(name) || isMutationSpec(p) || isAppliedMigration(p)) continue;
    out.push({ path: p, src: readFileSync(p, "utf8") });
  }
  return out;
}

interface Insert { table: string; cols: string[]; line: number }

/** Every `insert into <table> (<columns>)` in a file, with the columns it names. A statement that
 *  names no column list is one this cannot read either way, and is left alone. */
function inserts(src: string): Insert[] {
  const out: Insert[] = [];
  const re = /insert\s+into\s+((?:zz\.)?[a-z_]\w*)(?:\s+([a-z_]\w*))?\s*\(([^)]*)\)/gi;
  for (const m of src.matchAll(re)) {
    const cols = m[3].split(",").map((c) => c.trim().toLowerCase());
    if (!cols.length || !cols.every((c) => /^[a-z_]\w*$/.test(c))) continue;
    out.push({
      table: m[1].replace(/^zz\./i, "").toLowerCase(),
      cols, line: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

/** The SQL of every template literal or string in a file that opens as a statement, with the
 *  `${…}` a template interpolates left as written — a statement this cannot fold is still read for
 *  the tables and columns it names with its own keys. */
function statements(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/[`"']([^`"']*)[`"']/g)) {
    const text = m[1].replace(/--[^\n]*/g, " ");
    if (/^\s*(select|insert|update|delete|with)\b/i.test(text)) out.push(text);
    else if (/\b(select|insert|update|delete)\b/i.test(text) &&
             /\b(from|into|set|join)\b/i.test(text)) out.push(text);
  }
  return out;
}

/** The failure-mode family's own names, before and after the split. */
const IDENTITY = "eval_failure_mode";
const SIGHTING = "eval_failure_mode_sighting";
const LINK = "eval_protocol_failure_mode";

// ---------------------------------------------------------------------------------------------
// 1. The shapes `SCHEMA_TARGET` declares, which `schema-inventory.ts` holds the migration to.
// ---------------------------------------------------------------------------------------------
interface Column { name: string; type: string; nullable: boolean }
interface Table {
  columns: [name: string, type: string, nullable: boolean, defaultExpr: string | null][];
  primaryKey: string[] | null;
  uniques: string[][];
  foreignKeys: { columns: string[]; refTable: string; refColumns: string[] }[];
  checks: string[];
}

const { SCHEMA_TARGET } = await import(
  pathToFileURL(join(process.cwd(), "schema-target.ts")).href) as { SCHEMA_TARGET: { tables: Record<string, Table> } };

const table = (name: string): Table | null => SCHEMA_TARGET.tables[name] ?? null;
const columnsOf = (t: Table): Column[] =>
  t.columns.map(([name, type, nullable]) => ({ name, type, nullable }));
const column = (t: Table, name: string): Column | null => columnsOf(t).find((c) => c.name === name) ?? null;

for (const name of [IDENTITY, SIGHTING, LINK]) {
  if (!table(name)) fail.push(`FAIL: SCHEMA_TARGET declares no zz.${name} — the split has no table to land in`);
}

const identity = table(IDENTITY);
const sighting = table(SIGHTING);
const link = table(LINK);

if (identity) {
  // `(plugin_id, stable_key)` is the identity: the pair is unique, so a mode found twice is one
  // row, and `plugin_id` is on the mode rather than on the finding of it.
  if (!identity.uniques.some((u) => u.length === 2 && u[0] === "plugin_id" && u[1] === "stable_key")) {
    fail.push(`FAIL: zz.${IDENTITY} carries no unique over (plugin_id, stable_key), so nothing makes ` +
              "one failure mode one row");
  }
  for (const name of ["plugin_id", "stable_key", "description", "created_at"]) {
    const c = column(identity, name);
    if (!c) fail.push(`FAIL: zz.${IDENTITY} carries no ${name} — the identity is (plugin_id, stable_key)`);
    else if (c.nullable) fail.push(`FAIL: zz.${IDENTITY}.${name} is nullable, and the identity is not a maybe`);
  }
  if (!identity.foreignKeys.some((f) => f.columns.length === 1 && f.columns[0] === "plugin_id" &&
                                       f.refTable === "plugin" && f.refColumns[0] === "id")) {
    fail.push(`FAIL: zz.${IDENTITY}.plugin_id has no foreign key to zz.plugin(id), so a stable key ` +
              "identifies a failure mode of nothing");
  }
  // The prevalence, the owner and the evidence are the sighting's. An identity that still carried
  // any of them would be the candidate row again, with its two facts back in one row.
  for (const name of ["prevalence", "prevalence_numerator", "owner_kind", "evidence_refs", "observation_snapshot_id"]) {
    if (column(identity, name)) {
      fail.push(`FAIL: zz.${IDENTITY} carries ${name}, which is one discovery's fact — it belongs on ` +
                `zz.${SIGHTING}, or the identity moves whenever a later window finds it again`);
    }
  }
}

if (sighting) {
  // The sighting's own prevalence: two figures, so the rate is re-derivable, with the constraint
  // that holds them to a share of a whole.
  for (const name of ["prevalence_numerator", "prevalence_denominator"]) {
    const c = column(sighting, name);
    if (!c) fail.push(`FAIL: zz.${SIGHTING} carries no ${name}, so a sighting records no prevalence of its own`);
    else if (c.nullable || c.type !== "integer") {
      fail.push(`FAIL: zz.${SIGHTING}.${name} is ${c.type}${c.nullable ? ", nullable" : ""} — a sighting's ` +
                "prevalence is two integer figures, and every sighting has them");
    }
  }
  if (!sighting.checks.some((c) => /prevalence_numerator\s*<=\s*prevalence_denominator/.test(c))) {
    fail.push(`FAIL: zz.${SIGHTING} has no check that prevalence_numerator <= prevalence_denominator, so a ` +
              "sighting can record a share larger than the whole it is a share of");
  }
  // The sighting's own owner: the kind, with the vocabulary the evaluator answers in, and the two
  // nullable columns the answer's own detail lands in.
  const ownerKind = column(sighting, "owner_kind");
  if (!ownerKind) fail.push(`FAIL: zz.${SIGHTING} carries no owner_kind, so a sighting records no owner`);
  else if (ownerKind.nullable) fail.push(`FAIL: zz.${SIGHTING}.owner_kind is nullable, and every sighting has an owner`);
  if (!sighting.checks.some((c) => /owner_kind\s*=/.test(c) &&
                                   /'plugin'/.test(c) && /'unknown'/.test(c))) {
    fail.push(`FAIL: zz.${SIGHTING} has no check holding owner_kind to the evaluator's own vocabulary, so an ` +
              "answer outside it is a row no finding can be routed by");
  }
  for (const name of ["owner_ref", "ownership_reason", "confidence"]) {
    if (!column(sighting, name)) {
      fail.push(`FAIL: zz.${SIGHTING} carries no ${name}, so a sighting's owner is a kind with nothing behind it`);
    }
  }
  // The sighting's own evidence.
  const evidence = column(sighting, "evidence_refs");
  if (!evidence) fail.push(`FAIL: zz.${SIGHTING} carries no evidence_refs, so a sighting records no evidence`);
  else if (evidence.nullable || evidence.type !== "jsonb") {
    fail.push(`FAIL: zz.${SIGHTING}.evidence_refs is ${evidence.type}${evidence.nullable ? ", nullable" : ""} — ` +
              "every sighting carries the evidence it was found from");
  }
  if (!column(sighting, "observation_snapshot_id")) {
    fail.push(`FAIL: zz.${SIGHTING} carries no observation_snapshot_id, so a sighting names no window`);
  }
  // `failure_mode_id` always resolves: not null, and a foreign key to the identity it names.
  const mode = column(sighting, "failure_mode_id");
  if (!mode) fail.push(`FAIL: zz.${SIGHTING} carries no failure_mode_id, so a sighting belongs to nothing`);
  else if (mode.nullable) fail.push(`FAIL: zz.${SIGHTING}.failure_mode_id is nullable, so a sighting can resolve to no mode`);
  if (!sighting.foreignKeys.some((f) => f.columns.length === 1 && f.columns[0] === "failure_mode_id" &&
                                         f.refTable === IDENTITY && f.refColumns[0] === "id")) {
    fail.push(`FAIL: zz.${SIGHTING}.failure_mode_id has no foreign key to zz.${IDENTITY}(id), so a sighting's ` +
              "identity is whatever the writer happened to put there");
  }
  // The candidate row's own columns are gone: a sighting keeps neither the mode's key nor the
  // mutable status the old table carried in place of the relation.
  for (const name of ["stable_key", "status", "merged_into_id", "prevalence", "plugin_id"]) {
    if (column(sighting, name)) {
      fail.push(`FAIL: zz.${SIGHTING} carries ${name} — the candidate row's split left it on the wrong side; ` +
                `the key is zz.${IDENTITY}'s and this sighting's own provenance is discovery_key, ` +
                "discovered_by and the evidence it names");
    }
  }
}

if (link) {
  // A protocol's lineage is a relation: the key is the pair, so folding one identity in twice is
  // one row, and it resolves to the identity rather than naming a key.
  const pk = link.primaryKey ?? [];
  if (!(pk.length === 2 && pk.includes("protocol_version_id") && pk.includes("failure_mode_id"))) {
    fail.push(`FAIL: zz.${LINK} has no primary key over (protocol_version_id, failure_mode_id), so a protocol ` +
              "folds one failure mode in more than once");
  }
  for (const ref of ["protocol_version_id", "failure_mode_id"]) {
    if (!link.foreignKeys.some((f) => f.columns.length === 1 && f.columns[0] === ref)) {
      fail.push(`FAIL: zz.${LINK}.${ref} has no foreign key, so a lineage row can point at nothing`);
    }
  }
  if (column(link, "stable_key")) {
    fail.push(`FAIL: zz.${LINK} carries a stable_key — lineage is the relation, not the key the taxonomy ` +
              "used to spell");
  }
}

// ---------------------------------------------------------------------------------------------
// 2. The writers and readers in the four trees that write to a database.
// ---------------------------------------------------------------------------------------------
/** The dropped row, and the columns of it that are no writer's business any more. */
const DROPPED_TABLE = "eval_failure_mode_candidate";
const RETIRED_ON_SIGHTING = ["stable_key", "status", "merged_into_id", "prevalence"];
/** What an insert into a sighting names, at minimum: the identity it resolves to, the window it
 *  was found in, its own prevalence, its own owner and its own evidence. */
const SIGHTING_MUST_NAME = [
  "failure_mode_id", "observation_snapshot_id", "prevalence_numerator", "prevalence_denominator",
  "owner_kind", "evidence_refs",
];
/** What an insert into an identity names: the pair that identifies a failure mode. */
const IDENTITY_MUST_NAME = ["plugin_id", "stable_key"];

let scanned = 0;
const files = new Set<string>();
const writeTrees = ROOTS.flatMap((r) => (existsSync(r) ? sources(r) : []));

for (const { path, src } of writeTrees) {
  const sql = withoutComments(src);
  for (const st of statements(sql)) {
    scanned++;
    files.add(path);
    if (new RegExp(`\\bzz\\.${DROPPED_TABLE}\\b`, "i").test(st)) {
      fail.push(`FAIL: ${path} — a statement names zz.${DROPPED_TABLE}, which the phase-3 migration ` +
                `drops; the same fact is a zz.${IDENTITY} row and a zz.${SIGHTING} row`);
    }
    if (new RegExp(`\\bupdate\\s+(?:zz\\.)?${SIGHTING}\\b|\\bdelete\\s+from\\s+(?:zz\\.)?${SIGHTING}\\b`, "i").test(st)) {
      fail.push(`FAIL: ${path} — a statement updates or deletes a zz.${SIGHTING}, which is immutable ` +
                "history: a later window's finding of the same mode is another sighting, never an edit");
    }
    if (new RegExp(`\\bupdate\\s+(?:zz\\.)?${LINK}\\b`, "i").test(st)) {
      fail.push(`FAIL: ${path} — a statement updates a zz.${LINK}, which is a relation: a protocol folds an ` +
                "identity in or leaves it out, and neither is an edit");
    }
    // The identity's own key is what every sighting and every lineage row resolves through, so no
    // statement rewrites it. A description may still be corrected — that is not the identity.
    const rewrite = new RegExp(`\\bupdate\\s+(?:zz\\.)?${IDENTITY}\\b[^;]*?\\bset\\b([^;]*)`, "i").exec(st);
    if (rewrite && /\b(plugin_id|stable_key)\s*=/i.test(rewrite[1])) {
      fail.push(`FAIL: ${path} — a statement rewrites the key of a zz.${IDENTITY}, which is the pair ` +
                "everything else resolves through");
    }
  }

  for (const ins of inserts(sql)) {
    if (ins.table === DROPPED_TABLE) {
      fail.push(`FAIL: ${path}:${ins.line} — inserts zz.${DROPPED_TABLE}, which this phase drops whole`);
      continue;
    }
    if (ins.table === IDENTITY) {
      for (const name of IDENTITY_MUST_NAME) {
        if (!ins.cols.includes(name)) {
          fail.push(`FAIL: ${path}:${ins.line} — inserts zz.${IDENTITY} without ${name}, so the identity is ` +
                    "not (plugin_id, stable_key) and a mode found twice is two modes");
        }
      }
      // Resolved by the pair rather than minted blind: without this, a second DISCOVER over a
      // plugin that already has the mode raises a unique violation instead of re-sighting it.
      const bound = new RegExp(`insert\\s+into\\s+(?:zz\\.)?${IDENTITY}\\s*\\([^)]*\\)[^` + "`" +
                               `]*?on\\s+conflict\\s*\\(([^)]*)\\)`, "i").exec(sql);
      const conflict = bound?.[1].split(",").map((c) => c.trim().toLowerCase()) ?? [];
      if (!(conflict.length === 2 && conflict[0] === "plugin_id" && conflict[1] === "stable_key")) {
        fail.push(`FAIL: ${path}:${ins.line} — this insert into zz.${IDENTITY} does not resolve through ` +
                  "`on conflict (plugin_id, stable_key)`, so it neither mints nor finds the mode's one row");
      }
    }
    if (ins.table === SIGHTING) {
      for (const name of RETIRED_ON_SIGHTING) {
        if (ins.cols.includes(name)) {
          fail.push(`FAIL: ${path}:${ins.line} — inserts zz.${SIGHTING}.${name}, which the split retires; ` +
                    `the key is zz.${IDENTITY}'s, and this sighting's own provenance is what it names`);
        }
      }
      for (const name of SIGHTING_MUST_NAME) {
        if (!ins.cols.includes(name)) {
          fail.push(`FAIL: ${path}:${ins.line} — inserts zz.${SIGHTING} without ${name}, so the sighting ` +
                    "carries no evidence of its own or resolves to no failure mode");
        }
      }
      // A sighting's identity is resolved, never invented: the file that writes one names the
      // identity table, and the value it binds came from there (a parameter, not a literal uuid).
      if (!new RegExp(`\\b${IDENTITY}\\b`).test(sql)) {
        fail.push(`FAIL: ${path}:${ins.line} — writes a zz.${SIGHTING} in a file that never names ` +
                  `zz.${IDENTITY}, so nothing there resolves the identity the sighting points at`);
      }
      const values = new RegExp(`insert\\s+into\\s+(?:zz\\.)?${SIGHTING}\\s*\\([^)]*\\)[^` + "`" +
                                "`]*?values\\s*\\(\\s*([^,)]*)", "i").exec(sql);
      const first = (values?.[1] ?? "").trim();
      if (!/^\$\d+/.test(first)) {
        fail.push(`FAIL: ${path}:${ins.line} — binds zz.${SIGHTING}.failure_mode_id to \`${first || "nothing"}\`, ` +
                  `which is no parameter of this statement; a sighting's identity is a zz.${IDENTITY}.id ` +
                  "resolved in the same transaction");
      }
    }
  }
}

if (!writeTrees.length) {
  fail.push("FAIL: no source tree was found under " + ROOTS.join(", ") + " — this check read nothing");
}

if (fail.length) {
  console.error(fail.join("\n"));
  process.exit(1);
}
console.log(`failure-mode identity: zz.${IDENTITY} is unique over (plugin_id, stable_key), ` +
            `zz.${SIGHTING} carries its own prevalence, owner and evidence and resolves through ` +
            `failure_mode_id, and ${scanned} statement(s) in ${files.size} file(s) under ` +
            `${ROOTS.join(", ")} write neither the dropped candidate row nor an identity the ` +
            "sightings cannot resolve.");
