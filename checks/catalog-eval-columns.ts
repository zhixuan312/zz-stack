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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { SCHEMA_TARGET } from "../schema-target.ts";

/** The trees that write to a database. `testing/` holds the mutation report — recorded runs of
 *  planted defects rather than call sites — and `checks/` reads files instead of writing rows. */
const ROOTS = ["services", "packages", "scripts", "deploy"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

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

/** The end of the string or template literal that opens at `i` — the index just past its closing
 *  delimiter, or the end of the file for one that never closes. */
function literalEnd(src: string, i: number): number {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") { j += 2; continue; }
    if (src[j] === q) return j + 1;
    j++;
  }
  return src.length;
}

/** The end of the regex literal that opens at `i`, or the end of its line for a `/` that turned
 *  out to be division after all. */
function regexEnd(src: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return j + 1;
    else if (c === "\n") return j;
    j++;
  }
  return src.length;
}

/** Whether a `/` opens a regex rather than dividing: a regex can only start where a value can —
 *  after an operator, a delimiter or a keyword, never after a name or a closing bracket. */
function opensRegex(src: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  if (k < 0) return true;
  if ("(,=:[!&|?{};+-*%~^<>".includes(src[k])) return true;
  const word = /([A-Za-z_$][\w$]*)$/.exec(src.slice(0, k + 1))?.[1];
  return word !== undefined &&
    /^(return|typeof|case|in|of|do|else|yield|await|delete|void|instanceof|new)$/.test(word);
}

interface Region { kind: "code" | "literal" | "comment"; start: number; end: number }

/** The source split into code, literal and comment — one pass, so a quote inside a comment, a
 *  `//` inside a literal or a `'` inside a regex is read for what it is rather than guessed at. */
function regions(src: string): Region[] {
  const out: Region[] = [];
  const push = (kind: Region["kind"], start: number, end: number): void => {
    const last = out[out.length - 1];
    if (last && last.kind === kind && last.end === start) last.end = end;
    else out.push({ kind, start, end });
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      push("comment", i, end); i = end;
    } else if (c === "/" && src[i + 1] === "*") {
      const nl = src.indexOf("*/", i + 2);
      const end = nl < 0 ? src.length : nl + 2;
      push("comment", i, end); i = end;
    } else if (c === "/" && opensRegex(src, i)) {
      const end = regexEnd(src, i);
      push("code", i, end); i = end;
    } else if (c === '"' || c === "'" || c === "`") {
      const end = literalEnd(src, i);
      push("literal", i, end); i = end;
    } else {
      let end = i + 1;
      while (end < src.length && !"\"'`/".includes(src[end])) end++;
      push("code", i, end); i = end;
    }
  }
  return out;
}

interface Statement { path: string; line: number; sql: string }

/** One statement per string or template literal, adjacent literals a `+` joins read as one. */
function statementsOf(path: string, src: string): Statement[] {
  const lines = (at: number): number => src.slice(0, at).split("\n").length;
  if (path.endsWith(".sh")) {
    return src.split("\n").flatMap((text, i) => {
      const sql = text.replace(/(^|\s)#.*$/, "");
      return sql.trim().length > 0 ? [{ path, line: i + 1, sql }] : [];
    });
  }
  const out: Statement[] = [];
  const rs = regions(src);
  let start = -1;
  let text = "";
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i];
    if (r.kind === "literal") {
      const next = rs[i + 1];
      const plus = next?.kind === "code" && src.slice(next.start, next.end).trim() === "+";
      if (start < 0) { start = r.start; text = ""; }
      text += src.slice(r.start, r.end);
      if (plus) continue;
      out.push({ path, line: lines(start), sql: text });
      start = -1;
    }
  }
  return out;
}

/** A statement with the text after a `--` on each of its lines removed — an SQL comment inside a
 *  template literal is prose, and prose is not a statement. */
const withoutSqlComments = (sql: string): string => sql.replace(/--[^\n]*/g, "");

/**
 * Whether the literal reads as a statement rather than as prose about one. A statement opens with
 * the verb that makes it one, allowing the quote the literal opens with, the `(` a subquery is
 * wrapped in, the `?` a ternary puts before it and the `${…}` a template puts first; `from` and
 * `join` are verbs here too, because a fragment the code assembles into a statement elsewhere is
 * one this has to read.
 */
function opensStatement(sql: string): boolean {
  let t = sql;
  for (;;) {
    const before = t;
    t = t.replace(/^\s+/, "").replace(/^[`"'(?]/, "").replace(/^\$\{[^}]*\}/, "");
    if (t === before) break;
  }
  return /^(select|insert|update|delete|with|from|join|exists)\b/i.test(t);
}

interface Binding { table: string; alias: string | null }

/** A word that never follows a table as its alias, so an optional alias group does not swallow
 *  the clause keyword that comes next. */
const STOP = new Set([
  "where", "group", "order", "limit", "offset", "having", "union", "join", "left", "right",
  "inner", "outer", "full", "cross", "on", "using", "set", "values", "returning", "and", "or",
  "as", "select", "from", "natural", "window", "fetch", "for", "lateral", "only", "with",
  "distinct", "filter", "when",
]);

const canonical = (table: string): string => table.replace(/^zz\./i, "").toLowerCase();

/** Every table the statement binds, with the alias it binds it under: `insert into`, `update …
 *  set`, and every `from` and `join`. */
function bindings(sql: string): Binding[] {
  const out: Binding[] = [];
  const alias = (name: string | undefined): string | null => {
    const n = (name ?? "").toLowerCase();
    return n.length === 0 || STOP.has(n) ? null : n;
  };
  const patterns = [
    /\binsert\s+into\s+((?:zz\.)?[a-z_]\w*)(?:\s+(?:as\s+)?([a-z_]\w*))?/gi,
    /\bupdate\s+((?:zz\.)?[a-z_]\w*)(?:\s+(?:as\s+)?([a-z_]\w*))?\s+set\b/gi,
    /\b(?:from|join)\s+((?:zz\.)?[a-z_]\w*)(?:\s+(?:as\s+)?([a-z_]\w*))?/gi,
  ];
  for (const re of patterns) {
    for (const m of sql.matchAll(re)) out.push({ table: m[1], alias: alias(m[2]) });
  }
  return out;
}

/** Whether `table` still carries `column` after this phase — read from the target, which is the
 *  shape the migration leaves behind, so a name it does not carry is one the phase retired. */
function carries(table: string, column: string): boolean {
  return (SCHEMA_TARGET.tables[table]?.columns ?? []).some((c) => c[0] === column);
}

/** Whether `table` carries `column` before this phase: what the target has, plus what the phase
 *  retires from it. */
function carried(table: string, column: string): boolean {
  return carries(table, column) || (RETIRED[table] ?? []).includes(column);
}

/** The names a statement declares as a CTE — `with touched as (…), live as (…)`. A CTE is not a
 *  table, and a column it exposes is no table's, which is what makes a bare name inside a
 *  statement that declares one unreadable rather than wrong. */
function cteNames(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/(?:\bwith\b|,)\s*([a-z_]\w*)\s*(?:\([^)]*\)\s*)?as\s*\(/gi)) {
    out.add(m[1].toLowerCase());
  }
  return out;
}

const FOLD_DEPTH = 3;

/** For a file, the names it imports and where each came from. */
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

/** Where a declaration of `name` ends: its balanced block, or the statement before the `;` for a
 *  declaration whose value is a single literal. */
function declarationEnd(src: string, rs: Region[], from: number): number {
  let depth = 0;
  let paren = 0;
  let opened = false;
  for (const r of rs) {
    if (r.end <= from || r.kind !== "code") continue;
    for (let k = Math.max(r.start, from); k < r.end; k++) {
      const c = src[k];
      if (c === "(") paren++;
      else if (c === ")") paren--;
      else if (c === "{" && paren === 0) { depth++; opened = true; }
      else if (c === "}") { depth--; if (opened && depth <= 0) return k + 1; }
      else if (c === ";" && !opened && depth === 0) return k + 1;
    }
  }
  return src.length;
}

/** Every string or template literal a file's declaration of `name` returns, unquoted. */
function literalsOf(src: string, rs: Region[], name: string): string[] {
  const decl = new RegExp(`\\b(?:function|const|let|var)\\s+${name}\\b`).exec(src);
  if (!decl) return [];
  const insideCode = rs.some((r) => r.kind === "code" && r.start <= decl.index && decl.index < r.end);
  if (!insideCode) return [];
  const end = declarationEnd(src, rs, decl.index + decl[0].length);
  return rs.filter((r) => r.kind === "literal" && r.start > decl.index && r.start < end)
           .map((r) => src.slice(r.start + 1, r.end - 1));
}

/** The statement with every `${callee(…)}` it interpolates replaced by what that callee returns. */
function foldInterpolations(sql: string, src: string, rs: Region[], path: string,
                            depth = FOLD_DEPTH, seen = new Set<string>()): string {
  if (depth <= 0) return sql;
  return sql.replace(/\$\{(\w+)\([^)]*\)\}/g, (whole, callee: string) => {
    if (seen.has(callee)) return whole;
    let texts = literalsOf(src, rs, callee);
    let home = src;
    let homeRs = rs;
    if (!texts.length) {
      const spec = importsOf(src).get(callee);
      if (!spec || !spec.startsWith(".")) return whole;
      const target = join(dirname(path), spec.replace(/\.js$/, ".ts"));
      if (!existsSync(target)) return whole;
      home = readFileSync(target, "utf8");
      homeRs = regions(home);
      texts = literalsOf(home, homeRs, callee);
    }
    if (!texts.length) return whole;
    const next = new Set(seen).add(callee);
    return " " + texts.map((t) => foldInterpolations(t, home, homeRs, path, depth - 1, next)).join(" ");
  });
}

/** Whether the statement names `column` bare — not after a `.` that qualifies it, not inside a
 *  quoted literal, and not as the output alias of the expression before it. */
function bareMention(sql: string, column: string): boolean {
  const re = new RegExp(`(?<![.\\w'":])${column}\\b`, "gi");
  for (const m of sql.matchAll(re)) {
    if (/\bas\s+$/i.test(sql.slice(0, m.index))) continue;
    return true;
  }
  return false;
}

const fail: string[] = [];
let scanned = 0;
const files = new Set<string>();

for (const { path, src } of ROOTS.flatMap((r) => sources(r))) {
  const rs = regions(src);
  for (const statement of statementsOf(path, src)) {
    const sql = withoutSqlComments(foldInterpolations(statement.sql, src, rs, path));
    scanned++;
    files.add(path);
    const found = new Set<string>();
    const binds = bindings(sql);
    const bound = [...new Set(binds.map((b) => canonical(b.table)))];

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
console.log(`catalog and evaluation columns: ${scanned} statement(s) in ${files.size} file(s) under ` +
            `${ROOTS.join(", ")} name no table or column the phase-3 migration retires`);
