#!/usr/bin/env node
/**
 * checks/eval-family-readers.ts — the evaluation family's readers answer from the family this
 * phase leaves, on a database built from this tree's own migrations.
 *
 * Two halves, because the failure this catches has two forms.
 *
 *   The static half: no statement that reads the evaluation family names a table or a column the
 *   phase-3 migration drops. `checks/catalog-eval-columns.ts` asks that question of a NAMED list
 *   of names — the phase's own technical acceptance criterion, deliberately narrower than the
 *   migration. This one reads the migration itself (`services/gateway/migrations/`) and takes
 *   every `drop table`, every `drop column` and every `rename column` it performs, so a reader
 *   that kept `eval_run.coverage`, `eval_run.score_interval`, `eval_run.guardrails` or
 *   `eval_observation_snapshot.subject_version_id` is reported here even though that check's list
 *   stops short of them — `score_interval` and `coverage` among them are exactly what
 *   `findings-doc.ts` was still reading when this task began, and the column the migration drops
 *   and puts back (`eval_protocol_version.observable_surfaces`) is NOT reported: the target the
 *   migration leaves still carries it.
 *
 *   The live half: the statement is EXECUTED — planned, never run — against a throwaway
 *   PostgreSQL migrated from this tree's own migrations (`scripts/schema/throwaway.ts`), the
 *   database `checks/schema-inventory.ts` already builds. Nothing compiles a SQL statement, so the
 *   static half reads text; the database is what decides whether the statement resolves. `EXPLAIN`
 *   plans a statement without running it and needs no parameter types, which is what makes it the
 *   probe: every `$n` is replaced by `null` first, so a statement Postgres cannot type is not a
 *   false finding. A statement whose plan FAILS on a relation or a column that does not exist is
 *   reported; one that fails for any other reason is counted as unreadable rather than passed or
 *   reported, because a fragment assembled elsewhere is not evidence about the schema.
 *
 * The readers the phase's criterion names are asserted one by one: `round_scores`,
 * `plugin_profile`, `plugin_conform`, `finding_record` and `improvement_start` each live in a file
 * this check reads, and each is either planned against the database (so it demonstrably reads the
 * reshaped family) or — `round_scores` alone — is a reader with no statement at all, which is the
 * contract it answers to: a round row was archived and dropped, so it refuses by name rather than
 * answering from a column that outlived the row.
 *
 * Read, not run, for the static half. A statement is the text of a string or template literal —
 * adjacent literals that a `+` joins read as one, so a select list spread across four of them is
 * still a single statement — with each literal's own delimiters dropped, so the text handed to the
 * database is the SQL itself, and with the text after a `--` on each of its lines stripped, the way
 * `checks/catalog-eval-columns.ts:232` strips it; or, in a shell script, one line. A `${…}` the
 * statement interpolates — a call (`${clause(x)}`) or a bare const holding a fragment
 * (`${STORED_ANSWERS_SQL}`) — is replaced by the literals that declaration returns before the
 * statement is read, so the `from` a caller cannot see is one this reads. Every literal under the
 * reader tree is also read for a `zz.<dropped table>` mention, prose included: a tool description
 * or a failure message that tells its reader about a table this phase drops is wrong in the message
 * too, and that is the only way `round_scores` — which issues no statement — can be reached.
 *
 * DELIBERATE: the roots and the migration are relative to `process.cwd()`, not to this file's own
 * location, so the check can be pointed at a scratch tree that plants a violation.
 *
 * EXEMPT, each with the reason it is:
 *
 *   `services/gateway/migrations/` — an applied migration is history. `001_init.sql` creates every
 *   table this phase drops and every column it retires; the file that retires them is exactly the
 *   file that must still spell them. `checks/dropped-columns.ts:47-51` carries this exemption for
 *   the same reason, and the migration is ALSO read below for the names it drops.
 *
 *   `checks/` — deliberately not a scan root. This check reads files; `checks/` plants defects in
 *   them and quotes them in its own messages, this file's own doc included.
 *
 *   A mutation spec quotes a statement in order to plant a defect in it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { SCHEMA_TARGET } from "../schema-target.ts";

/** The trees that write to a database — the same four `checks/catalog-eval-columns.ts` scans. */
const ROOTS = ["services", "packages", "scripts", "deploy"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
/** The migration that drops the legacy evaluation family. Read for the names it drops, and exempt
 *  from the scan for the same reason `checks/dropped-columns.ts` exempts it. */
const MIGRATION = "services/gateway/migrations/002_catalog_evaluation.sql";
/** The tree the evaluation family's own readers live in — the half of the live pass that is
 *  EXECUTED. Every module that reads `zz.eval_*`, `zz.plugin_version`, `zz.plugin_release_owner`,
 *  `zz.candidate`, `zz.improvement_run` or `zz.release_attempt` is a file under it, and a
 *  statement outside it that named a dropped name is the static half's finding. */
const READERS = "services/zz-core/src/eval";

const isMutationSpec = (p: string): boolean => /(^|\/)scripts\/mutation\/specs[^/]*\.ts$/.test(p);
const isAppliedMigration = (p: string): boolean => p.includes("services/gateway/migrations/");

/** The tables the evaluation family is read through, by their name with `zz.` stripped. A
 *  statement naming none of them is not this check's subject: the rest of the write trees read
 *  the identity, catalog and telemetry families, which `checks/dropped-columns.ts` covers. */
const FAMILY = new Set([
  "eval_run", "eval_run_dimension", "eval_assessment", "eval_finding", "eval_observation_snapshot",
  "eval_protocol_version", "eval_dimension", "eval_measure", "eval_evaluator_version",
  "eval_evaluator_qualification", "eval_failure_mode", "eval_failure_mode_sighting",
  "eval_protocol_failure_mode", "eval_idempotency", "eval_score", "eval_subject", "eval",
  "eval_subject_version", "eval_evidence_snapshot", "eval_protocol", "eval_evaluator",
  "rubric", "rubric_dimension", "plugin", "plugin_version", "plugin_release_owner",
  "plugin_version_skill", "candidate", "improvement_run", "release_attempt",
]);

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

// -------------------------------------------------------------------------------------------
// The scanner — the shape `checks/catalog-eval-columns.ts:110-260` reads statements with.

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

/** One statement per string or template literal, adjacent literals a `+` joins read as one.
 *
 *  `unquoted` drops each literal's own delimiters as it joins them, so the text handed back is
 *  the SQL itself: a statement assembled from four literals arrives as one readable statement
 *  rather than as five quoted fragments, which is what the database has to be given. */
function statementsOf(path: string, src: string, unquoted = false): Statement[] {
  const lines = (at: number): number => src.slice(0, at).split("\n").length;
  const body = (r: Region): string => unquoted ? src.slice(r.start + 1, r.end - 1) : src.slice(r.start, r.end);
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
      text += body(r);
      if (plus) continue;
      out.push({ path, line: lines(start), sql: text });
      start = -1;
    }
  }
  return out;
}

const withoutSqlComments = (sql: string): string => sql.replace(/--[^\n]*/g, "");

const VERBS = /^(select|insert|update|delete|with)\b/i;
const ANY_VERB = /^(select|insert|update|delete|with|from|join|exists)\b/i;

function opensStatement(sql: string, verbs: RegExp): boolean {
  let t = sql;
  for (;;) {
    const before = t;
    t = t.replace(/^\s+/, "").replace(/^[`"'(?]/, "").replace(/^\$\{[^}]*\}/, "");
    if (t === before) break;
  }
  return verbs.test(t);
}

const STOP = new Set([
  "where", "group", "order", "limit", "offset", "having", "union", "join", "left", "right",
  "inner", "outer", "full", "cross", "on", "using", "set", "values", "returning", "and", "or",
  "as", "select", "from", "natural", "window", "fetch", "for", "lateral", "only", "with",
  "distinct", "filter", "when",
]);

const canonical = (table: string): string => table.replace(/^zz\./i, "").toLowerCase();

interface Binding { table: string; alias: string | null }

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

function cteNames(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/(?:\bwith\b|,)\s*([a-z_]\w*)\s*(?:\([^)]*\)\s*)?as\s*\(/gi)) {
    out.add(m[1].toLowerCase());
  }
  return out;
}

const FOLD_DEPTH = 3;

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

function literalsOf(src: string, rs: Region[], name: string): string[] {
  const decl = new RegExp(`\\b(?:function|const|let|var)\\s+${name}\\b`).exec(src);
  if (!decl) return [];
  const insideCode = rs.some((r) => r.kind === "code" && r.start <= decl.index && decl.index < r.end);
  if (!insideCode) return [];
  const end = declarationEnd(src, rs, decl.index + decl[0].length);
  return rs.filter((r) => r.kind === "literal" && r.start > decl.index && r.start < end)
           .map((r) => src.slice(r.start + 1, r.end - 1));
}

/** The statement with every `${…}` it interpolates replaced by what that name returns — a call
 *  (`${clause(x)}`) or a bare const holding a fragment (`${STORED_ANSWERS_SQL}`). A name whose
 *  declaration is not itself literal text has nothing to substitute and is left alone, so a
 *  value known only at runtime is never guessed at. */
function foldInterpolations(sql: string, src: string, rs: Region[], path: string,
                            depth = FOLD_DEPTH, seen = new Set<string>()): string {
  if (depth <= 0) return sql;
  return sql.replace(/\$\{(\w+)(?:\([^)]*\))?\}/g, (whole, callee: string) => {
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

// -------------------------------------------------------------------------------------------
// The names the phase drops, read from the migration itself.

/** Every table the migration drops whole, and every column it drops from a table that survives —
 *  keyed by the table's name with `zz.` stripped, because that is the name a statement binds.
 *
 *  A name the migration drops and then puts back is NOT retired: `observable_surfaces` is dropped
 *  only so it can be re-added as a `text[]` under a scratch name and renamed into place, and the
 *  readers of it are correct. `SCHEMA_TARGET` is the shape the migration LEAVES — the same target
 *  `checks/schema-inventory.ts` holds the migration to — so a name the target still carries was
 *  re-added, and a table the target still carries was recreated. */
function droppedBy(migration: string): { tables: Set<string>; columns: Map<string, string[]> } {
  const tables = new Set<string>();
  const columns = new Map<string, string[]>();
  const kept = (table: string, column: string): boolean =>
    (SCHEMA_TARGET.tables[canonical(table)]?.columns ?? []).some((c) => c[0].toLowerCase() === column);
  const add = (table: string, column: string): void => {
    const t = canonical(table);
    if (kept(t, column.toLowerCase())) return;
    columns.set(t, [...(columns.get(t) ?? []), column.toLowerCase()]);
  };
  for (const m of migration.matchAll(
    /alter\s+table\s+(?:only\s+)?((?:zz\.)?[a-z_]\w*)\s+drop\s+column\s+(?:if\s+exists\s+)?([a-z_]\w*)/gi)) {
    add(m[1], m[2]);
  }
  // A rename is a drop of the old name and an addition of the new one: a reader still naming the
  // old name reads a column that is gone.
  for (const m of migration.matchAll(
    /alter\s+table\s+(?:only\s+)?((?:zz\.)?[a-z_]\w*)\s+rename\s+column\s+([a-z_]\w*)\s+to\s+([a-z_]\w*)/gi)) {
    add(m[1], m[2]);
  }
  for (const m of migration.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?((?:zz\.)?[a-z_]\w*)\s*(?:cascade)?;/gi)) {
    const t = canonical(m[1]);
    if (!SCHEMA_TARGET.tables[t]) tables.add(t);
  }
  return { tables, columns };
}

/** Every table's columns BEFORE this phase, from `001_init.sql` — the file that creates them.
 *  A dropped name is a name that was a column, so the pre-state is what tells a retired name
 *  apart from a name that was never one. */
function columnsBefore(init: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of init.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?((?:zz\.)?[a-z_]\w*)\s*\(([\s\S]*?)\n\);/gi)) {
    const table = canonical(m[1]);
    const cols = new Set<string>();
    for (const line of m[2].split("\n")) {
      const col = /^\s*([a-z_]\w*)\s+/.exec(line)?.[1];
      if (col && !/^(constraint|primary|unique|foreign|check|exclude|like|inherits)$/i.test(col)) {
        cols.add(col.toLowerCase());
      }
    }
    out.set(table, cols);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// The two halves.

const root = process.cwd();
let migration: string;
let init: string;
try {
  migration = readFileSync(join(root, MIGRATION), "utf8");
  init = readFileSync(join(root, "services/gateway/migrations/001_init.sql"), "utf8");
} catch (err) {
  console.error(`FAIL: the migrations cannot be read from ${root} — this check reads the names ` +
    `the phase drops out of them: ${(err as Error).message}`);
  process.exit(1);
}

const dropped = droppedBy(migration);
const before = columnsBefore(init);
const fail: string[] = [];

/** What a statement reads that the migration removes, or nothing. */
function retiredNames(sql: string, bound: readonly string[]): string[] {
  const found = new Set<string>();
  for (const t of bound) {
    if (dropped.tables.has(t)) found.add(`zz.${t} is dropped whole by this phase`);
  }
  for (const m of sql.matchAll(/\bzz\.([a-z_]\w*)\b/gi)) {
    const t = m[1].toLowerCase();
    if (dropped.tables.has(t)) found.add(`zz.${t} is dropped whole by this phase`);
  }
  const binds = bindings(sql);
  // A qualified column, through the alias it was bound under, the table's own name or `zz.<t>`.
  for (const b of binds) {
    const t = canonical(b.table);
    const quals = new Set([b.alias, t, `zz.${t}`].filter((q): q is string => !!q));
    for (const column of dropped.columns.get(t) ?? []) {
      for (const q of quals) {
        if (new RegExp(`\\b${q}\\.${column}\\b`, "i").test(sql)) {
          found.add(`${t}.${column} is retired by this phase (through \`${q}\`)`);
        }
      }
    }
  }
  // A bare column: Postgres resolves it to the one bound table that carried it before this phase,
  // so what it resolves to now is what decides whether the statement still reads.
  const ctes = cteNames(sql);
  for (const column of ctes.size ? [] : new Set([...bound].flatMap((t) => dropped.columns.get(t) ?? []))) {
    if (!bareMention(sql, column)) continue;
    const carried = bound.filter((t) => (before.get(t) ?? new Set()).has(column));
    if (carried.length === 1 && (dropped.columns.get(carried[0]) ?? []).includes(column)) {
      found.add(`${carried[0]}.${column} is retired by this phase (bare, and it is the only ` +
                `table this statement binds that carried it)`);
    }
  }
  return [...found].sort();
}

/** The statement's text with every `$n` replaced by `null`: `EXPLAIN` needs no parameter types,
 *  and a `null` where a figure goes plans exactly the same tables and columns. */
const withoutParameters = (sql: string): string => sql.trim().replace(/\$\d+/g, "null");

/** A statement the migrated database planned: the check's evidence that this reader answers
 *  from the family this phase leaves. */
interface Planned { path: string; line: number }

function statementsUnder(): Statement[] {
  return ROOTS.flatMap((r) => sources(r)).flatMap(({ path, src }) => {
    const rs = regions(src);
    return statementsOf(path, src, true).map((s) => ({
      ...s,
      sql: withoutSqlComments(foldInterpolations(s.sql, src, rs, s.path)),
    }));
  });
}

/** The family statements of the whole tree, split into those the live pass can plan and those it
 *  cannot. A statement this check cannot read is counted and named in the summary, never passed
 *  silently and never reported as a defect it is not. */
function familyStatements(all: Statement[]): { statically: { s: Statement; bound: string[] }[]; unreadable: Statement[] } {
  const statically: { s: Statement; bound: string[] }[] = [];
  const unreadable: Statement[] = [];
  for (const s of all) {
    const bound = [...new Set(bindings(s.sql).map((b) => canonical(b.table)))];
    const mentionsFamily = bound.some((t) => FAMILY.has(t))
      || [...s.sql.matchAll(/\bzz\.([a-z_]\w*)\b/gi)].some((m) => FAMILY.has(m[1].toLowerCase()));
    if (!mentionsFamily) continue;
    statically.push({ s, bound });
    // Only a self-contained statement can be planned: one that opens with a verb and whose every
    // `${…}` was folded away by the scanner above.
    if (!opensStatement(s.sql, VERBS) || /\$\{/.test(s.sql) || !bound.length) unreadable.push(s);
  }
  return { statically, unreadable };
}

/** A plan that failed because a RELATION or a COLUMN is not there is the phase's finding; one
 *  that failed for any other reason — a syntax error in a fragment the scanner glued together, a
 *  type mismatch, a function nobody wrote — says nothing about the names this phase drops, and is
 *  counted as unreadable rather than reported or passed. */
const missing = (message: string): boolean =>
  /\b(relation|column)\s+"?[\w.]*"?\s+does not exist/i.test(message)
  || /missing FROM-clause entry/i.test(message);

async function main(): Promise<void> {
  const { statically, unreadable } = familyStatements(statementsUnder());
  const files = new Set(statically.map(({ s }) => s.path));

  // ---- the static half
  for (const { s, bound } of statically) {
    if (!opensStatement(s.sql, ANY_VERB)) continue;
    const found = retiredNames(s.sql, bound);
    if (found.length) fail.push(`FAIL: ${s.path}:${s.line} — ${found.join("; ")}`);
  }
  // The reader tree, every literal, prose included. A tool description or a failure message that
  // tells its reader about a table this phase drops is wrong in the message too — and for
  // `round_scores`, which issues no statement at all, this is the only way it can be reached.
  for (const { path, src } of sources(READERS)) {
    for (const r of regions(src)) {
      if (r.kind !== "literal") continue;
      const line = src.slice(0, r.start).split("\n").length;
      for (const m of src.slice(r.start + 1, r.end - 1).matchAll(/\bzz\.([a-z_]\w*)\b/gi)) {
        if (dropped.tables.has(m[1].toLowerCase())) {
          fail.push(`FAIL: ${path}:${line} — a literal under the reader tree names zz.${m[1]}, ` +
            "which this phase drops whole");
        }
      }
    }
  }

  // ---- the readers the criterion names. Each is registered somewhere and answers through the
  // statements of the module that owns its reads — `plugin_profile` is registered in `observe.ts`
  // and reads through `plugin-profile.ts`, which is why the two are named apart.
  const READERS_BY_TOOL: Record<string, { registeredIn: string; readsThrough: string[] }> = {
    round_scores: { registeredIn: `${READERS}/plugin-judge.ts`, readsThrough: [] },
    plugin_profile: {
      registeredIn: `${READERS}/observe.ts`,
      readsThrough: [`${READERS}/plugin-profile.ts`, `${READERS}/observe.ts`, `${READERS}/observe-facts.ts`],
    },
    plugin_conform: { registeredIn: `${READERS}/plugin-eval.ts`, readsThrough: [`${READERS}/plugin-eval.ts`] },
    finding_record: { registeredIn: `${READERS}/plugin-record.ts`, readsThrough: [`${READERS}/plugin-record.ts`, `${READERS}/findings-doc.ts`] },
    improvement_start: { registeredIn: `${READERS}/candidates.ts`, readsThrough: [`${READERS}/candidates.ts`, `${READERS}/proposer-bundle.ts`] },
  };
  for (const [tool, where] of Object.entries(READERS_BY_TOOL)) {
    if (!existsSync(join(root, where.registeredIn))) {
      fail.push(`FAIL: ${where.registeredIn} is gone — it is where \`${tool}\` is registered, and ` +
                "this check reads that file for the statements the tool answers through");
      continue;
    }
    const src = readFileSync(join(root, where.registeredIn), "utf8");
    if (!new RegExp(`registerTool\\(\\s*\\n?\\s*"${tool}"`).test(src)) {
      fail.push(`FAIL: ${where.registeredIn} no longer registers \`${tool}\``);
    }
  }

  // ---- the live half: a throwaway database migrated from this tree's own migrations
  let planned: Planned[] = [];
  let unreadableLive: { path: string; line: number; why: string }[] = [];
  try {
    const { withThrowawayDb } = await import(
      pathToFileURL(join(root, "scripts/schema/throwaway.ts")).href) as typeof import("../scripts/schema/throwaway.ts");
    ({ planned, unreadable: unreadableLive } = await withThrowawayDb(async (client) => {
      // The throwaway client carries an empty search_path; a statement that names its tables
      // unqualified is still a statement about `zz`, which is where the family lives.
      await client.query("set search_path = zz, public");
      const done: Planned[] = [];
      const skipped: { path: string; line: number; why: string }[] = [];
      for (const { s } of statically) {
        if (unreadable.includes(s)) continue;
        try {
          await client.query(`explain ${withoutParameters(s.sql)}`);
          done.push({ path: s.path, line: s.line });
        } catch (err) {
          const why = (err as Error).message;
          if (missing(why)) {
            fail.push(`FAIL: ${s.path}:${s.line} — the migrated database refuses this statement: ` +
              `${why.split("\n")[0]} — it reads a name this phase's schema does not carry`);
          } else {
            skipped.push({ path: s.path, line: s.line, why: why.split("\n")[0] });
          }
        }
      }
      return { planned: done, unreadable: skipped };
    }));
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error("eval family readers: Docker is not available — the gate requires Docker to run this check");
      process.exit(2);
    }
    throw err;
  }

  // Each named reader must ANSWER from the reshaped family — planned against the migrated
  // database — except `round_scores`, which is the one reader with no statement at all: the round
  // it reads was archived and dropped, so it refuses by name rather than reading a stale column.
  // The prose rule above is what holds its text to that, which is why it is exempt here and only
  // here.
  for (const [tool, where] of Object.entries(READERS_BY_TOOL)) {
    if (planned.some((p) => where.readsThrough.includes(p.path))) continue;
    if (tool === "round_scores") continue;
    fail.push(`FAIL: ${where.registeredIn} registers \`${tool}\` and answers through no statement ` +
      `this database can plan (${where.readsThrough.join(", ")}) — a reader with nothing to read ` +
      "is not the reader the criterion names");
  }

  if (fail.length) {
    console.error(fail.join("\n"));
    process.exit(1);
  }
  const readerFiles = [...new Set(planned.map((p) => p.path))]
    .filter((p) => p.startsWith(READERS)).length;
  console.log(`eval family readers: ${statically.length} statement(s) in ${files.size} file(s) name ` +
    `no table or column the phase-3 migration drops, and ${planned.length} of them plan against a ` +
    `throwaway database migrated from this tree (${readerFiles} reader file(s) under ${READERS}). ` +
    `Unread by either half, and counted rather than passed: ${unreadable.length} statement(s) the ` +
    `scanner cannot extract on its own and ${unreadableLive.length} the database cannot plan for a ` +
    "reason other than a missing name.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
