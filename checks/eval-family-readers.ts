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
 *   migration. This one carries the migration's OWN list — read off it while it was pending, and
 *   frozen beside this check below — of every `drop table`, every `drop column` and every
 *   `rename column` it performed, so a reader that kept `eval_run.coverage`,
 *   `eval_run.score_interval`, `eval_run.guardrails` or
 *   `eval_observation_snapshot.subject_version_id` is reported here even though that check's list
 *   stops short of them — `score_interval` and `coverage` among them are exactly what
 *   `findings-doc.ts` was still reading when this task began, and the column the migration
 *   dropped and put back (`eval_protocol_version.observable_surfaces`) is NOT reported: the
 *   target the migration left still carries it.
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
 * DELIBERATE: the roots are relative to `process.cwd()`, not to this file's own location, so the
 * check can be pointed at a scratch tree that plants a violation. The retired names are declared
 * in this file, so there is nothing else for a caller to point anywhere.
 *
 * EXEMPT, each with the reason it is:
 *
 *   `services/gateway/migrations/` — an applied migration is history, and it states a schema
 *   rather than reading one: the names it spells are a declaration, not a call site. The phase-3
 *   file folded back into `001_init.sql` once release 0.84.0 was verified in production; the
 *   exemption stays because the next phase's pending migration spells ITS retired names there for
 *   as long as it is pending. `checks/dropped-columns.ts:47-51` carries it for the same reason.
 *
 *   `checks/` — deliberately not a scan root. This check reads files; `checks/` plants defects in
 *   them and quotes them in its own messages, this file's own doc included.
 *
 *   A mutation spec quotes a statement in order to plant a defect in it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** The trees that write to a database — the same four `checks/catalog-eval-columns.ts` scans. */
const ROOTS = ["services", "packages", "scripts", "deploy"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
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

// The names the phase-3 migration retires, declared here rather than read from a file.

/** Every table the phase dropped whole, and every column it dropped from a table that survives —
 * keyed by the table's name with `zz.` stripped, because that is the name a statement binds.
 *
 * READ OFF A FILE THAT IS GONE, SO FROZEN. This was taken from `002_catalog_evaluation.sql`'s own
 * `drop table`, `drop column` and `rename column` statements while that file was pending, and the
 * file folded back into `001_init.sql` once release 0.84.0 was verified in production.
 * `001_init.sql` drops nothing — it declares the shape the phase left — so a reader that went on
 * parsing it would find an empty list and report every statement clean without reading one.
 *
 * SCOPED TO THIS CHECK, NOT THE RECORD OF WHAT PHASES RETIRE. What is here is what the statements
 * this check scans can name: the evaluation family, the catalog names they bind, and the telemetry
 * and artifact tables those columns also live on. `checks/dropped-columns.ts` keeps the wider
 * record, phase by phase, and it is the file a later phase extends; the two overlap for phase 3's
 * columns by construction — both say what one migration retired — and the overlap is left standing
 * rather than reconciled, so neither file is the place the other's list has to be read from.
 *
 * IF A LATER PHASE RETIRES NAMES UNDER THE TREES THIS CHECK READS, THIS LIST MUST BE EXTENDED WITH
 * THEM. Nothing derives it any more, so a phase that does not extend it leaves this check scanning
 * a smaller past than the schema has, and reporting it green.
 *
 * A name the phase dropped and then put back is NOT retired: `observable_surfaces` was dropped
 * only so it could be re-added as a `text[]` under a scratch name and renamed into place, and the
 * readers of it are correct — which is why `observable_surfaces` is absent here and its scratch
 * name `observable_surfaces_text` is not. `SCHEMA_TARGET` is still the shape the phase LEAVES, and
 * `checks/schema-inventory.ts` is what holds `001_init.sql` to it.
 */
const RETIRED_TABLES = new Set<string>([
  "eval", "eval_evaluator", "eval_evidence_snapshot", "eval_failure_mode_candidate",
  "eval_protocol", "eval_score", "eval_subject", "eval_subject_version", "rubric",
  "rubric_dimension", "skill_asset",
]);

/** The columns the phase retired, keyed by the table they were retired from — the name a
 *  statement binds, which for a renamed column is the NEW name. Read off the same file, frozen for
 *  the same reason, scoped and extended the same way as the tables above. */
const RETIRED_COLUMNS = new Map<string, string[]>([
  ["eval_assessment", ["evaluator_version_id", "subject_ref", "evidence_ref", "answer", "policy_version", "resulting_action"]],
  ["eval_dimension", ["name"]],
  ["eval_evaluator_qualification", ["evaluator_version_id", "protocol_version_id", "subject_scope"]],
  ["eval_evaluator_version", ["evaluator_id", "model_policy", "polarity"]],
  ["eval_idempotency", ["principal"]],
  ["eval_measure", ["suite"]],
  ["eval_observation_snapshot", ["production_window", "coverage", "runtime_identity", "environment_digest", "subject_version_id"]],
  ["eval_protocol_version", ["protocol_id", "subject_compatibility", "suites", "approved_document_path", "failure_taxonomy", "observable_surfaces_text"]],
  ["eval_run", ["subject_version_id", "evidence_snapshot_id", "run_status", "score_interval", "guardrails", "coverage", "dimension_scores"]],
  ["plugin", ["owner_team", "evolvable", "release_owners"]],
  ["plugin_version", ["rubric_id"]],
  ["skill", ["kind", "ordinal"]],
]);

/** Every pre-phase table that carried one of the retired column names, keyed by the column.
 *
 * The one fact about the pre-state this check still needs: a bare mention resolves to the one
 * bound table that carried it, so "which tables carried it" is what decides whether the statement
 * still reads — and `001_init.sql` is the state AFTER the phase, which cannot answer it. Taken
 * from the phase-2 baseline the same way the list above was taken, and for the same reason.
 *
 * EXTEND IT WITH THE LIST ABOVE, name for name. A retired column with no entry here is a bare
 * mention this check stops reporting: it cannot say which bound table carried the name before the
 * phase, so it cannot tell that only one did.
 */
const CARRIED_BEFORE = new Map<string, string[]>([
  ["answer", ["eval_assessment"]],
  ["approved_document_path", ["eval_protocol_version"]],
  ["coverage", ["eval_evidence_snapshot", "eval_observation_snapshot", "eval_run"]],
  ["dimension_scores", ["eval_run"]],
  ["environment_digest", ["eval_observation_snapshot"]],
  ["evaluator_id", ["eval_evaluator_version"]],
  ["evaluator_version_id", ["assessment", "eval_assessment", "eval_evaluator_qualification", "eval_measure"]],
  ["evidence_ref", ["eval_assessment"]],
  ["evidence_snapshot_id", ["eval_run"]],
  ["evolvable", ["plugin"]],
  ["failure_taxonomy", ["eval_protocol_version"]],
  ["guardrails", ["eval_run"]],
  ["kind", ["artifact_edge", "artifact_event", "control_evidence", "control_waiver", "eval_evaluator", "eval_finding", "event", "knowledge_node", "passkey_challenge", "rubric_dimension", "skill", "skill_asset"]],
  ["model_policy", ["eval_evaluator_version"]],
  ["name", ["eval_dimension", "mcp_oauth_client", "plugin", "plugin_tool", "rubric_dimension", "skill", "team"]],
  ["ordinal", ["artifact_passage", "rubric_dimension", "skill"]],
  ["owner_team", ["plugin"]],
  ["polarity", ["eval_evaluator_version"]],
  ["policy_version", ["eval_assessment"]],
  ["principal", ["eval_idempotency"]],
  ["production_window", ["eval_observation_snapshot"]],
  ["protocol_id", ["eval_protocol_version"]],
  ["protocol_version_id", ["eval_dimension", "eval_evaluator_qualification", "eval_evidence_snapshot", "eval_run"]],
  ["release_owners", ["plugin"]],
  ["resulting_action", ["eval_assessment"]],
  ["rubric_id", ["eval", "plugin_version", "rubric_dimension"]],
  ["run_status", ["eval_run"]],
  ["runtime_identity", ["eval_observation_snapshot"]],
  ["score_interval", ["eval_run"]],
  ["subject_compatibility", ["eval_protocol_version"]],
  ["subject_ref", ["eval_assessment"]],
  ["subject_scope", ["eval_evaluator_qualification"]],
  ["subject_version_id", ["eval_evidence_snapshot", "eval_observation_snapshot", "eval_run"]],
  ["suite", ["eval_measure"]],
  ["suites", ["eval_protocol_version"]],
]);

// -------------------------------------------------------------------------------------------
// The two halves.

const root = process.cwd();
const fail: string[] = [];

// The retired-name record is declared data now, so nothing in the tree proves it is still there —
// and an emptied record is the one failure this check cannot see from its output, because every
// statement it reads would be reported clean. Named here rather than left to whoever reads the
// list next, which is the same reason the record carries the paragraph above it.
if (RETIRED_TABLES.size === 0 || RETIRED_COLUMNS.size === 0 || CARRIED_BEFORE.size === 0) {
  fail.push("FAIL: the retired-name record beside this check is empty — every statement would be " +
            "reported clean, which is what it looked like the last time this list was right");
}

/** What a statement reads that the phase removes, or nothing. */
function retiredNames(sql: string, bound: readonly string[]): string[] {
  const found = new Set<string>();
  for (const t of bound) {
    if (RETIRED_TABLES.has(t)) found.add(`zz.${t} is dropped whole by this phase`);
  }
  for (const m of sql.matchAll(/\bzz\.([a-z_]\w*)\b/gi)) {
    const t = m[1].toLowerCase();
    if (RETIRED_TABLES.has(t)) found.add(`zz.${t} is dropped whole by this phase`);
  }
  const binds = bindings(sql);
  // A qualified column, through the alias it was bound under, the table's own name or `zz.<t>`.
  for (const b of binds) {
    const t = canonical(b.table);
    const quals = new Set([b.alias, t, `zz.${t}`].filter((q): q is string => !!q));
    for (const column of RETIRED_COLUMNS.get(t) ?? []) {
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
  for (const column of ctes.size ? [] : new Set([...bound].flatMap((t) => RETIRED_COLUMNS.get(t) ?? []))) {
    if (!bareMention(sql, column)) continue;
    // A bare column resolves to the one bound table that carried it BEFORE the phase, which is
    // the fact `CARRIED_BEFORE` is frozen from — `001_init.sql` is the state after it.
    const carried = bound.filter((t) => (CARRIED_BEFORE.get(column) ?? []).includes(t));
    if (carried.length === 1 && (RETIRED_COLUMNS.get(carried[0]) ?? []).includes(column)) {
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
        if (RETIRED_TABLES.has(m[1].toLowerCase())) {
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
