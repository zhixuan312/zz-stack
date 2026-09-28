/**
 * checks/dropped-columns.ts — no statement in the write trees names a table or a column
 * the migrations retire.
 *
 * The migrations renamed `zz.run` to `zz.skill_run`, dropped `decision` and `discussion_message`
 * whole, and left six columns of `event`, four of `model_call`, two of `assessment`, three of
 * `initiative_fact` and two of `bug` behind. Phase 3 retired a further forty-odd columns of the
 * eval tables, listed below with where each list came from. Every one of those names is gone from
 * the schema — and nothing compiles a SQL statement, so a statement that still names one fails as
 * a runtime error on the first path somebody happens to exercise. This is
 * the static half of that: read every statement under the trees that write to a database, and
 * report the ones naming a retired name.
 *
 * Read, not run. A statement is the text of a string or template literal — adjacent literals
 * that a `+` joins read as one, so a select list spread across four of them is still a single
 * statement — with the text after a `--` on each of its lines stripped, the way
 * `checks/telemetry-columns.ts:29-31` strips it; or, in a shell script, one line. A `${callee(…)}`
 * the statement interpolates is replaced by the literals that callee returns before the statement
 * is read, so the `from` a caller cannot see is one this reads (`foldInterpolations` below). A
 * retired column is read through an alias bound to its table (`from zz.event e … e.team_slug`), a
 * qualified name (`zz.event.team_slug`), or — where the statement binds one table that retires
 * the name and none that still carries it — bare (`insert into event (actor, team_slug, …)`).
 * The two dropped tables and the renamed `zz.run` are matched wherever the statement names them.
 *
 * DELIBERATE: a name this cannot attribute is reported rather than passed. A bare column whose
 * statement binds a table that retires it beside one that still carries it is a statement this
 * check cannot read — and a statement it cannot read is not evidence that the writer is correct.
 *
 * Two rules exist because the alternative reported a writer that is correct:
 *
 *   A statement declaring a CTE is not read for bare columns at all. `services/zz-core/src/eval/
 *   observe-facts.ts` declares `touched`, `live` and `closes` in one statement and selects a bare
 *   `team_slug, initiative … from live`; read against the statement's own tables those attributed
 *   to `event` and `doc`, neither of which is where they come from. The qualified names in that
 *   statement are still read — which is how it was reported while it read the two `zz.event`
 *   columns through `e` directly: a read that was invisible until the fold below was added.
 *
 *   The removed table names are matched in every literal, prose included. A diagnosis naming
 *   `zz.run` mid-sentence, or a failure message naming a table this phase drops, stops being true
 *   once the migration landed, and a check that skipped prose would pass a tree still telling its
 *   user about a table that is gone. Nothing under the scan roots names one in prose today — the
 *   messages that motivated this rule were updated with the migration — so the rule stands as the
 *   guard rather than as a finding anything currently earns.
 *
 * EXEMPT, each with the reason it is:
 *
 *   `services/gateway/migrations/` — an applied migration is history. `001_init.sql:551` and
 *   `:571` create both tables this phase drops, and `:165`, `:1082` and `:1694` define `actor`,
 *   `step_version` and `caller_session`; the file that retires them is exactly the file that must
 *   still spell them. `checks/telemetry-columns.ts:14-15` carries this exemption for the same
 *   reason.
 *
 *   `checks/` — deliberately not a scan root. This check reads files; `checks/` plants defects in
 *   them and quotes them in its own messages. This file's module doc is the standing example: it
 *   spells `decision`, `discussion_message` and `caller_session` to explain the rule it applies,
 *   and read as call sites every one of those is a finding that reads nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { pathToFileURL } from "node:url";

import { SCHEMA_TARGET } from "../schema-target.ts";

// The statement reader, once — `packages/tools/src/lib/sql-statements.ts`. This check carried its own
// copy of it, byte for byte with four others.
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
 * The columns the phases retired, and the one table renamed. Keyed by the table's name after
 * the migration, because that is the table whose columns these were.
 *
 * `caller_session` is `session` after it and `note` is `error`; both are here under the name that
 * stops reading. A column dropped and re-added under its own name — `assessment.asked_by`,
 * `bug.reported_by`, which changes from an email to a principal id — is deliberately not: the
 * name survives, and what the writer has to change is the value it hands over, which no reading
 * of the statement can see.
 */
const RETIRED: Record<string, string[]> = {
  // Phase 2's migration.
  event: ["actor", "team_slug", "initiative", "flow", "step", "step_version"],
  skill_run: ["turns", "caller_session"],
  model_call: ["event_id", "plugin", "confidence", "note"],
  assessment: ["requested_model", "initiative"],
  initiative_fact: ["id", "team", "initiative"],
  bug: ["team_slug", "initiative"],
  // Phase 3's migration. This is that migration's NET effect, read
  // off the target against the folded baseline — not off its `drop column` statements, which is a
  // list that lies: `observable_surfaces` is dropped, re-added as `observable_surfaces_text` and
  // renamed back, so a list built from the drops alone reports a live column as retired.
  // `polarity` is the mirror case, retired by a rename the drops never name.
  //
  // Why this list exists at all: the plan gave this phase a check for the names its own statements
  // had to stop using (`catalog-eval-columns.ts`, I-20) and no check for the rest of its drops, so
  // every other retired column was silent until a path happened to exercise it —
  // `zz.eval_run.guardrails` reached a live 500 exactly that way, and widening this list to the
  // rest of phase 3's drops found `protocol-record.ts` and `protocol-triggers.ts` naming a
  // `zz.eval_protocol_version` column the migration had retired.
  eval_run: ["coverage", "dimension_scores", "evidence_snapshot_id", "guardrails", "run_status",
             "score_interval", "subject_version_id"],
  eval_assessment: ["answer", "evaluator_version_id", "evidence_ref", "policy_version",
                    "resulting_action", "subject_ref"],
  eval_dimension: ["name"],
  eval_evaluator_qualification: ["evaluator_version_id", "protocol_version_id", "subject_scope"],
  eval_evaluator_version: ["evaluator_id", "model_policy", "polarity"],
  eval_idempotency: ["principal"],
  eval_measure: ["suite"],
  eval_observation_snapshot: ["coverage", "environment_digest", "production_window",
                              "runtime_identity", "subject_version_id"],
  eval_protocol_version: ["approved_document_path", "failure_taxonomy", "protocol_id",
                          "subject_compatibility", "suites"],
  plugin: ["evolvable", "owner_team", "release_owners"],
  plugin_version: ["rubric_id"],
  skill: ["kind", "ordinal"],
  // Phase 4's migration, read off the target against the folded baseline the same way. It folded
  // back into `001_init.sql` once release 0.85.0 was verified in production, and this is the set it
  // retired: `improve-control-shape.ts` asserts the target, and this is what asks whether a
  // STATEMENT still names one. It is the general net, for files no task owns —
  // `eval/candidate-build.ts` read two of these in no Phase 4 task's Owns, and stayed
  // invisible until `checks/eval-family-readers.ts` planned its statement against the database.
  eval_finding: ["docs_affected", "eval_id", "proposed_change", "scope", "resulted_in_skill_version_id"],
  improvement_run: ["finding_ids"],
  candidate: ["base_subject_version_id", "patchset", "proposer_identity", "touched_owners"],
  release_attempt: ["approval_refs", "approved_patch_digest", "base_subject_version_id",
                    "released_subject_version_id", "required_owners", "rolled_back"],
  control_run: ["initiative", "module_id", "profile", "subject", "team_slug"],
  control_evidence: ["note"],
};

/** The name a table goes by before the migration. A statement binding it is naming a table this
 *  phase renames, which is why `run` is not a key of `RETIRED`. */
const RENAMED: Record<string, string> = { run: "skill_run" };

/** The two tables this phase drops, which no statement may name at all. */
const DROPPED_TABLES = ["decision", "discussion_message"];


/** A statement with the text after a `--` on each of its lines removed — an SQL comment inside a
 *  template literal is prose, and prose is not a statement. */
const withoutSqlComments = (sql: string): string => sql.replace(/--[^\n]*/g, "");

const canonical = (table: string): string => table.replace(/^zz\./i, "").toLowerCase();

function carries(table: string, column: string): boolean {
  return (SCHEMA_TARGET.tables[table]?.columns ?? []).some((c) => c[0] === column);
}

/** Whether `table` carries `column` before this phase: what the target has, plus what the phase
 *  retires from it. The two together are the shape the read statement was written against — how
 *  many of a statement's tables a bare name could mean, then and now. */
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

for (const { path, src } of ROOTS.flatMap((r) => sourceFiles(r, KEEP))) {
  const rs = regions(src);
  for (const statement of statementsOf(path, src)) {
    const sql = withoutSqlComments(foldInterpolations(statement.sql, src, rs, path, HOME));
    scanned++;
    files.add(path);
    const found = new Set<string>();
    const binds: { table: string; alias: string | null }[] = bindings(sql);
    const bound = [...new Set(binds.map((b: { table: string; alias: string | null }) => canonical(b.table)))];

    for (const b of binds) {
      const t = canonical(b.table);
      if (DROPPED_TABLES.includes(t)) {
        found.add(`zz.${t} is dropped whole by this phase`);
      } else if (RENAMED[t]) {
        found.add(`zz.${t} is renamed to zz.${RENAMED[t]} by this phase`);
      }
    }
    // A statement can name a dropped table without binding it — a `select` whose only `from` is
    // elsewhere, or a fragment inside a concatenation that did not join. Named here rather than
    // left to the binding scan, which would pass it. Read on every literal, prose included: a
    // message naming a table this phase removes is wrong in the message too.
    for (const m of sql.matchAll(/\bzz\.([a-z_]\w*)\b/gi)) {
      const t = m[1].toLowerCase();
      if (DROPPED_TABLES.includes(t)) found.add(`zz.${t} is dropped whole by this phase`);
      else if (RENAMED[t]) found.add(`zz.${t} is renamed to zz.${RENAMED[t]} by this phase`);
    }

    // Everything below asks what a statement *reads*, so prose is not read at all.
    if (opensStatement(sql)) {
      for (const b of binds) {
        const t = canonical(b.table);
        const after = RENAMED[t] ?? t;
        const quals = [b.alias, t, `zz.${t}`, after, `zz.${after}`].filter((q): q is string => !!q);
        for (const column of RETIRED[after] ?? []) {
          for (const q of new Set(quals)) {
            if (new RegExp(`\\b${q}\\.${column}\\b`, "i").test(sql)) {
              found.add(`${after}.${column} is retired by this phase (through \`${q}\`)`);
            }
          }
        }
      }

      // Bare columns. Postgres resolves a bare name to the one table that carries it, so the
      // question is what it resolves to now and whether that table still has it. A name none of the
      // bound tables carries is not a column reference at all; one two of them carry is one this
      // check cannot read — reported, never passed. `as <word>` is skipped: that is a name the
      // statement is giving, not one it is reading.
      const post = [...new Set(bound.map((t) => RENAMED[t] ?? t))];
      const ctes = cteNames(sql);
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
console.log(`dropped columns: ${scanned} statement(s) in ${files.size} file(s) under ` +
            `${ROOTS.join(", ")} name no table or column the migrations retire`);
