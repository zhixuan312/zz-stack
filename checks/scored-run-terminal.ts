#!/usr/bin/env node
// A scored eval_run's published result is terminal. `scored_at` is the marker: the run carries a
// `score_status` exactly when it has one, its score columns are written once, and the
// per-dimension results live in `zz.eval_run_dimension`, inserted once and never updated.
//
// FR-29, Rule 4. The live door let a scored run be scored a second time under a new idempotency
// key, overwriting a published result (2 of 15 production runs were), and the jsonb array it
// stored meant a dimension could be re-rendered without the row it was scored from changing.
// Nothing in the database enforces "this row is finished" — an `update` on a score column
// compiles, runs, and rewrites the number every finding already cites. This is the static half.
//
// Read, not run. A statement is the text of a string or template literal — adjacent literals that
// a `+` joins read as one, so an update spread across four of them is still a single statement —
// with the text after a `--` on each of its lines stripped, the way
// `checks/catalog-eval-columns.ts:232` strips it; or, in a shell script, one line.
//
// Three write shapes are reported on `zz.eval_run`, and they are one fact spelled three ways:
//
//   `update zz.eval_run … set <score column> …` without `scored_at is null` in the same
//                                   statement — a published result rewritten. An update that
//                                   carries the guard only ever lands on a run with no result
//                                   yet, which is the one write the door is allowed to make.
//   `delete from zz.eval_run …`     — the row a finding cites, erased.
//   `alter table zz.eval_run …`     — the table gaining a shape a scored run must not have.
//   `insert into zz.eval_run … on conflict … do update set <score column>` — the "upsert"
//                                   spelling of a rewrite, which no guard can reach.
//
// On `zz.eval_run_dimension` only `insert into` is a write: the rows are inserted exactly once
// when the parent run is scored (FR-29) and are never updated, so an `update`, `delete from`,
// `alter table` or an upsert is reported.
//
// DELIBERATE: the score columns are the ones a published result IS. `team_id`, `initiative_id`,
// `observation_snapshot_id`, `protocol_version_id`, `started_by` and `created_at` are not here —
// they say which run this is, not what it found.
//
// DELIBERATE: the second half reads `evaluate.ts`'s own `scoreEvaluation`. The static scan above
// proves no statement rewrites a result; it cannot tell whether the door that writes the one
// permitted update still refuses a scored run first. Both halves are asserted by exact text,
// because a check whose pattern stops matching passes while testing nothing.
//
// EXEMPT, each with the reason it is:
//
//   `services/gateway/migrations/` — an applied migration is history. `001_init.sql` creates
//   this table and `002_catalog_evaluation.sql` gives it its phase-3 shape; the files that write
//   its DDL are exactly the files that must still spell it. `checks/dropped-columns.ts`,
//   `checks/catalog-eval-columns.ts` and `checks/plugin-version-immutable.ts` carry this
//   exemption for the same reason.
//
//   `checks/` — deliberately not a scan root, for the reason `checks/catalog-eval-columns.ts`
//   gives: this file spells `update zz.eval_run` to explain the rule it applies, and read as a
//   call site that is a finding that reads nothing.
//
// DELIBERATE: the roots are relative to `process.cwd()`, not to this file's own location, so the
// check can be pointed at a scratch tree that plants a violation. Run it from the repository root
// and it reads the repository.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
/** The trees that write to a database, the same four `checks/catalog-eval-columns.ts` scans. */
const ROOTS = ["services", "packages", "scripts", "deploy"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** Every column a published result is: what the run found, never which run it is. */
const SCORE_COLUMNS = [
  "score_status", "overall_score", "score_lower", "score_upper", "measure_coverage",
  "establishment_blocked_by", "guardrail_status", "scorer_version", "scored_at",
];

/** A mutation spec quotes a statement in order to plant a defect in it. Its `find`/`replace` text
 *  is the subject of the check that owns the spec, and reading it as a call site would report the
 *  defect the spec exists to plant. */
const isMutationSpec = (p: string): boolean => /(^|\/)scripts\/mutation\/specs[^/]*\.ts$/.test(p);

/** An applied migration is history — see the module doc. */
const isAppliedMigration = (p: string): boolean => p.includes("services/gateway/migrations/");

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
 *  after an operator, a delimiter or a keyword, never after a name or a closing bracket. Without
 *  this, a check's own `/update zz.eval_run/` regex reads as code, the quotes inside it start a
 *  literal that never closes, and every statement after it is read from the wrong place. */
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

/** The verb that writes `table`, or null: `update` and `delete from` rewrite or erase a row;
 *  `insert into` is the one permitted writer and is reported only when its own `on conflict`
 *  clause turns it into an update; `alter table` is the row gaining a shape it must not have. A
 *  subquery's `from <table>` is not a write, so the verb has to be the table's own. */
function writeShape(sql: string, table: string): string | null {
  const t = `${table}(?!\\w)`;
  if (new RegExp(`\\bupdate\\s+(?:only\\s+)?(?:zz\\.)?${t}`, "i").test(sql)) return "updates";
  if (new RegExp(`\\bdelete\\s+from\\s+(?:only\\s+)?(?:zz\\.)?${t}`, "i").test(sql)) return "deletes from";
  if (new RegExp(`\\balter\\s+table\\s+(?:only\\s+)?(?:zz\\.)?${t}`, "i").test(sql)) return "alters";
  if (new RegExp(`\\binsert\\s+into\\s+(?:zz\\.)?${t}[\\s\\S]*?\\bon\\s+conflict\\b[\\s\\S]*?\\bdo\\s+update\\s+set\\b`, "i").test(sql)) {
    return "inserts into, then updates on conflict";
  }
  return null;
}

/** Whether the statement's `set` clause assigns any of `columns`. The clause is read apart from
 *  the `where`, so a guard that merely NAMES a score column (`scored_at is null`) is not read as
 *  an assignment to it. */
function assigns(sql: string, columns: readonly string[]): string | null {
  const set = /\bset\b([\s\S]*?)(?:\bwhere\b|\breturning\b|$)/i.exec(sql);
  if (!set) return null;
  return columns.find((c) => new RegExp(`\\b${c}\\s*=`, "i").test(set[1])) ?? null;
}

const fail: string[] = [];
let scanned = 0;
const files = new Set<string>();

for (const { path, src } of ROOTS.flatMap((r) => (existsSync(r) ? sources(r) : []))) {
  for (const statement of statementsOf(path, src)) {
    const sql = withoutSqlComments(statement.sql);
    scanned++;
    files.add(path);

    const runWrite = writeShape(sql, "eval_run");
    if (runWrite) {
      if (runWrite === "updates") {
        const column = assigns(sql, SCORE_COLUMNS);
        // The one permitted update: the door's own score write, guarded so it can only land on a
        // run that has published nothing yet.
        if (column && !/\bscored_at\s+is\s+null\b/i.test(sql)) {
          fail.push(`FAIL: ${statement.path}:${statement.line} — this statement ${runWrite} ` +
            `zz.eval_run and assigns \`${column}\` with no \`scored_at is null\` guard: a scored ` +
            "run's published result is terminal (FR-29) and a re-score is a new eval_run");
        }
      } else {
        fail.push(`FAIL: ${statement.path}:${statement.line} — this statement ${runWrite} ` +
          "zz.eval_run, which is a published result erased or reshaped: a scored run is terminal " +
          "(FR-29), and every later fact about one is a new run");
      }
    }

    const dimWrite = writeShape(sql, "eval_run_dimension");
    if (dimWrite) {
      fail.push(`FAIL: ${statement.path}:${statement.line} — this statement ${dimWrite} ` +
        "zz.eval_run_dimension, whose rows are inserted exactly once when the parent run is " +
        "scored and never updated (FR-29)");
    }
  }
}

if (!scanned || !files.size) {
  fail.push("FAIL: this check read no statement under " + ROOTS.join(", ") +
    " — a rule that reaches nothing passes for the wrong reason");
}

// ---- the door half: evaluation_score refuses a scored run before it does any scoring work -----
const EVALUATE = "services/zz-core/src/eval/evaluate.ts";
assert.ok(existsSync(EVALUATE), `${EVALUATE} exists`);
const src = readFileSync(EVALUATE, "utf8");
const at = src.indexOf("export async function scoreEvaluation");
assert.ok(at > 0, "scoreEvaluation is exported from evaluate.ts and is where the score is written");
const rest = src.slice(at);
const next = rest.indexOf("\nexport ", 1);
const fn = next > 0 ? rest.slice(0, next) : rest;

const gate = fn.indexOf("run.scored_at !== null");
assert.ok(gate > 0, "a scored run is recognised by its own terminal marker");
assert.ok(gate < fn.indexOf("loadDimensions("), "the refusal comes before any scoring work");
assert.match(fn.slice(gate, gate + 400),
  /decideBeforeWork\(principal, "evaluation_score", idempotency_key, \{ eval_run_id \}\)\)\.replayed/,
  "a retry under the key that scored the run is recognised as a replay first, with the same ledger " +
  "args withIdempotency digests");
assert.match(fn, /withIdempotency\(\s*principal, "evaluation_score", idempotency_key, \{ eval_run_id \}/,
  "the ledger args the replay check digests are the ones the write records");
assert.match(fn, /is already scored and its score is ` \+\s*"published[\s\S]*?A re-score is a new eval_run/,
  "the refusal names the run and says a re-score is a new eval_run");

// Guarded at the write as well: a concurrent score under another key cannot overwrite either, and
// the per-dimension results are written in the same transaction as the score they belong to.
assert.match(fn, /where id = \$1::uuid and scored_at is null`/,
  "the score write only lands on a run that has published no result");
assert.match(fn, /if \(written\.rowCount !== 1\) throw new Refusal\(alreadyScored\)/,
  "a write that found the run already scored refuses and rolls back, leaving no ledger row");
assert.match(fn, /insert into zz\.eval_run_dimension \(eval_run_id, protocol_version_id, dimension_id, score, coverage\)/,
  "the per-dimension published results are written with the score they belong to");

if (fail.length) {
  console.error(fail.join("\n"));
  process.exit(1);
}
console.log(`scored run terminal: ${scanned} statement(s) in ${files.size} file(s) under ` +
            `${ROOTS.join(", ")} never rewrite a scored run's result, and evaluation_score refuses ` +
            "a run already scored before it scores it");
