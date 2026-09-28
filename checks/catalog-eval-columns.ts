/**
 * checks/catalog-eval-columns.ts — no statement in the write trees names a table or a column the
 * phase-3 migration retires.
 *
 * The phase-3 migration dropped nine legacy evaluation tables whole and `skill_asset` with
 * them, gave `skill` its `flow` instead of a `kind` and its name instead of an `ordinal`, gave
 * `plugin_version` one identity instead of a `rubric_id`, moves a plugin's ownership off
 * `plugin.evolvable` and the `release_owners` jsonb, and reshapes `eval_run` and
 * `eval_assessment` — whose `evidence_snapshot_id`, `run_status`, `dimension_scores`,
 * `subject_version_id`, `evaluator_version_id`, `subject_ref`, `evidence_ref`, `answer`,
 * `policy_version` and `resulting_action` all stop reading. Every one of those names compiles
 * today and stops reading the moment the migration is applied, and nothing compiles a SQL
 * statement, so the break surfaces as a runtime error on the first path somebody happens to
 * exercise. This is the static half of that: read every statement under the trees that write to
 * a database, and report the ones naming a retired name.
 *
 * Read, not run. A statement is the text of a string or template literal — adjacent literals
 * that a `+` joins read as one, so a select list spread across four of them is still a single
 * statement — with the text after a `--` on each of its lines stripped, the way
 * `checks/telemetry-columns.ts:29-31` strips it; or, in a shell script, one line. A `${callee(…)}`
 * the statement interpolates is replaced by the literals that callee returns before the statement
 * is read, so the `from` a caller cannot see is one this reads (`foldInterpolations` below). A
 * retired column is read through an alias bound to its table (`from zz.eval_run er … er.run_status`),
 * a qualified name (`zz.eval_assessment.subject_ref`), or — where the statement binds one table
 * that retires the name and none that still carries it — bare (`select subject_ref from
 * zz.eval_assessment`). The ten dropped tables are matched wherever the statement names them.
 *
 * DELIBERATE: a name this cannot attribute is reported rather than passed, for the reason
 * `checks/dropped-columns.ts` gives — a statement it cannot read is not evidence that the writer
 * is correct.
 *
 * DELIBERATE: the removed table names are matched in every literal, prose included. A diagnosis
 * naming `zz.eval` mid-sentence, or a failure message naming a table this phase drops, stops
 * being true once the migration landed, and a check that skipped prose would pass a tree still
 * telling its user about a table that is gone.
 *
 * DELIBERATE: the list of names is the phase's own technical acceptance criterion, not every name
 * this migration retires. `eval_protocol_version.protocol_id`, `eval_dimension.name`,
 * `eval_measure.suite`, `eval_evaluator_version.evaluator_id`, `eval_evaluator_version.polarity`,
 * `eval_evaluator_version.model_policy`,
 * `eval_evaluator_qualification.evaluator_version_id`, `...protocol_version_id`,
 * `...subject_scope`, `eval_observation_snapshot.subject_version_id`, `...production_window`,
 * `...coverage`, `...runtime_identity`, `...environment_digest`, `plugin.owner_team` and
 * `eval_failure_mode_candidate` are retired by the same file and are read by the same phase's
 * later tasks; this check names what the criterion names, and adding a name here would report a
 * file that criterion never asked its owner to change.
 *
 * EXEMPT, each with the reason it is:
 *
 *   `services/gateway/migrations/` — an applied migration is history. `001_init.sql` creates
 *   every table this phase drops and every column it retires; the file that retires them is
 *   exactly the file that must still spell them. `checks/dropped-columns.ts:47-51` carries this
 *   exemption for the same reason.
 *
 *   `checks/` — deliberately not a scan root. This check reads files; `checks/` plants defects in
 *   them and quotes them in its own messages. This file's module doc is the standing example: it
 *   spells `eval_subject_version`, `skill_asset` and `subject_ref` to explain the rule it
 *   applies, and read as call sites every one of those is a finding that reads nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { SCHEMA_TARGET } from "../schema-target.ts";

// The statement reader, once — `packages/tools/src/lib/sql-statements.ts`. This check carried its
// own copy of it, byte for byte with four others.
const { sourceFiles, regions, statementsOf, opensStatement, bindings, cteNames, bareMention,
        foldInterpolations } =
  await import(pathToFileURL(join(process.cwd(), "packages/tools/dist/lib/sql-statements.js")).href);

/** The trees that write to a database. `testing/` holds the mutation report — recorded runs of
 *  planted defects rather than call sites — and `checks/` reads files instead of writing rows. */
const ROOTS = ["services", "packages", "scripts", "deploy"];
/** Which files this check reads — its own policy, which is why the reader takes it as a predicate. */
const KEEP = (p: string): boolean => /\.(ts|sh)$/.test(p) && !isMutationSpec(p) && !isAppliedMigration(p);

/** A mutation spec quotes a statement in order to plant a defect in it. Its `find`/`replace` text
 *  is the subject of the check that owns the spec, and reading it as a call site would report the
 *  defect the spec exists to plant. */
const isMutationSpec = (p: string): boolean => /(^|\/)scripts\/mutation\/specs[^/]*\.ts$/.test(p);

/** An applied migration is history — see the module doc. */
const isAppliedMigration = (p: string): boolean => p.includes("services/gateway/migrations/");

/**
 * The ten tables this phase drops whole. Keyed by the name they stop reading under.
 */
const DROPPED_TABLES = [
  "eval_subject_version",
  "eval_evidence_snapshot",
  "eval_protocol",
  "eval_evaluator",
  "rubric",
  "rubric_dimension",
  "eval",
  "eval_subject",
  "eval_score",
  "skill_asset",
];

/**
 * The columns the phase retired, keyed by the table's name after the migration, because that is
 * the table whose columns these were. Every one is a name whose reader has to move to a relation,
 * a derived value or a reshaped column; a column whose name survives (`plugin.owner_team` →
 * `owner_team_id`) is not here, and neither is a column a later phase retires.
 */
const RETIRED: Record<string, string[]> = {
  skill: ["ordinal", "kind"],
  plugin: ["evolvable", "release_owners"],
  plugin_version: ["rubric_id"],
  eval_run: ["evidence_snapshot_id", "run_status", "dimension_scores", "subject_version_id"],
  eval_assessment: ["evaluator_version_id", "subject_ref", "evidence_ref", "answer", "policy_version", "resulting_action"],
};


/** A statement with the text after a `--` on each of its lines removed — an SQL comment inside a
 *  template literal is prose, and prose is not a statement. */
const withoutSqlComments = (sql: string): string => sql.replace(/--[^\n]*/g, "");

const canonical = (table: string): string => table.replace(/^zz\./i, "").toLowerCase();

function carries(table: string, column: string): boolean {
  return (SCHEMA_TARGET.tables[table]?.columns ?? []).some((c) => c[0] === column);
}

/** Whether `table` carries `column` before this phase: what the target has, plus what the phase
 *  retires from it. */
function carried(table: string, column: string): boolean {
  return carries(table, column) || (RETIRED[table] ?? []).includes(column);
}

function importsOf(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) out.set(name, m[2]);
    }
  }
  return out;
}

/** Where an interpolated callee is declared: this file, or the module it was imported from. */
type Region = { kind: "code" | "literal" | "comment"; start: number; end: number };
const HOME = (callee: string, fromPath: string, fromSrc: string): { src: string; rs: Region[] } | null => {
  const spec = importsOf(fromSrc).get(callee);
  if (!spec || !spec.startsWith(".")) return null;
  const target = join(dirname(fromPath), spec.replace(/\.js$/, ".ts"));
  if (!existsSync(target)) return null;
  const home = readFileSync(target, "utf8");
  return { src: home, rs: regions(home) };
};

const fail: string[] = [];
let scanned = 0;
const files = new Set<string>();

for (const { path, src } of ROOTS.flatMap((r) => (existsSync(r) ? sourceFiles(r, KEEP) : []))) {
  const rs = regions(src);
  for (const statement of statementsOf(path, src)) {
    const sql = withoutSqlComments(foldInterpolations(statement.sql, src, rs, path, HOME));
    scanned++;
    files.add(path);
    const found = new Set<string>();
    const binds: { table: string; alias: string | null }[] = bindings(sql);
    const bound = [...new Set(binds.map((b: { table: string }) => canonical(b.table)))];

    for (const b of binds) {
      const t = canonical(b.table);
      if (DROPPED_TABLES.includes(t)) {
        found.add(`zz.${t} is dropped whole by this phase`);
      }
    }
    // A statement can name a dropped table without binding it — a `select` whose only `from` is
    // elsewhere, or a fragment inside a concatenation that did not join. Read on every literal,
    // prose included: a message naming a table this phase removes is wrong in the message too.
    for (const m of sql.matchAll(/\bzz\.([a-z_]\w*)\b/gi)) {
      const t = m[1].toLowerCase();
      if (DROPPED_TABLES.includes(t)) found.add(`zz.${t} is dropped whole by this phase`);
    }

    // Everything below asks what a statement *reads*, so prose is not read at all.
    if (opensStatement(sql)) {
      for (const b of binds) {
        const t = canonical(b.table);
        const quals = [b.alias, t, `zz.${t}`].filter((q): q is string => !!q);
        for (const column of RETIRED[t] ?? []) {
          for (const q of new Set(quals)) {
            if (new RegExp(`\\b${q}\\.${column}\\b`, "i").test(sql)) {
              found.add(`${t}.${column} is retired by this phase (through \`${q}\`)`);
            }
          }
        }
      }

      // Bare columns. Postgres resolves a bare name to the one table that carries it, so the
      // question is what it resolves to now and whether that table still has it. A name none of
      // the bound tables carries is not a column reference at all; one two of them carry is one
      // this check cannot read — reported, never passed.
      const post = [...new Set(bound)];
      const ctes: Set<string> = cteNames(sql);
      for (const column of ctes.size ? [] : new Set(post.flatMap((t) => RETIRED[t] ?? []))) {
        if (!bareMention(sql, column)) continue;
        const before = post.filter((t) => carried(t, column));
        if (before.length === 0) continue;
        if (before.length > 1) {
          found.add(`this check cannot read which table's \`${column}\` is meant: this statement ` +
                    `binds ${post.join(", ")}, and ${before.join(" and ")} carried it before this phase`);
          continue;
        }
        if ((RETIRED[before[0]] ?? []).includes(column)) {
          found.add(`${before[0]}.${column} is retired by this phase (bare, and it is the only ` +
                    `table this statement binds that carries it)`);
        }
      }
    }

    if (found.size > 0) {
      fail.push(`FAIL: ${statement.path}:${statement.line} — ${[...found].sort().join("; ")}`);
    }
  }
}

if (fail.length) {
  console.error(fail.join("\n"));
  process.exit(1);
}
console.log(`catalog and evaluation columns: ${scanned} statement(s) in ${files.size} file(s) under ` +
            `${ROOTS.join(", ")} name no table or column the phase-3 migration retires`);
