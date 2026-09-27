/**
 * checks/plugin-version-immutable.ts — no statement in the write trees updates `zz.plugin_version`.
 *
 * `plugin_version` is immutable history (FR-24, AC-6.2). A release has ONE identity, its `digest`
 * is written once at insert — by `register-plugins.ts` at a release, by `plugin_register` at a
 * third-party capture — and every later fact about that release is a new version rather than an
 * update. The table carries no lifecycle column for the same reason: there is no state for a
 * `set` to move. `plugin_locate` is what used to violate this, recomputing a whole-plugin content
 * digest and upserting a second row per released thing (`zz.eval_subject_version`, folded onto
 * this table by `002_catalog_evaluation.sql`); it resolves the row now and writes nothing to it.
 *
 * Why a check and not a constraint: nothing enforces "this table's rows never change" — a `set`
 * on it compiles, runs, and silently rewrites the digest every earlier evaluation of that release
 * was judged against. The failure is invisible until two evaluations of one version disagree
 * about what they scored. This is the static half of that.
 *
 * Read, not run. A statement is the text of a string or template literal — adjacent literals that
 * a `+` joins read as one, so an insert list spread across four of them is still a single
 * statement — with the text after a `--` on each of its lines stripped, the way
 * `checks/catalog-eval-columns.ts:232` strips it; or, in a shell script, one line. A
 * `${callee(…)}` the statement interpolates is replaced by the literals that callee returns before
 * the statement is read, so a `set` a caller cannot see is one this reads.
 *
 * Four write shapes are reported, and they are the same fact spelled four ways:
 *
 *   `update zz.plugin_version … set …`       — a row rewritten.
 *   `delete from zz.plugin_version …`        — a release erased, which no rollback does: a
 *                                              rollback retracts a version, it never deletes the
 *                                              row an exact-version locate still resolves.
 *   `insert into zz.plugin_version … on conflict … do update set …` — the "upsert" spelling of an
 *                                              update. `on conflict … do nothing` is the shape
 *                                              that keeps the promise and is not reported.
 *   `alter table zz.plugin_version …`        — the row gaining a lifecycle column, which is the
 *                                              thing the clause forbids: it is immutable history,
 *                                              so there is nothing about a release to move.
 *
 * DELIBERATE: a `zz.plugin_version` only READ inside another table's statement (`update zz.candidate
 * set … = (select … from zz.plugin_version …)`) is not a finding. The verb has to be the table's
 * own for the statement to be one that writes it.
 *
 * EXEMPT, each with the reason it is:
 *
 *   `services/gateway/migrations/` — an applied migration is history. `001_init.sql` creates this
 *   table and `002_catalog_evaluation.sql` gives it its phase-3 shape; the files that write its
 *   DDL are exactly the files that must still spell it. `checks/dropped-columns.ts` and
 *   `checks/catalog-eval-columns.ts` carry this exemption for the same reason.
 *
 *   `checks/` — deliberately not a scan root, for the reason `checks/catalog-eval-columns.ts`
 *   gives: this file spells `update zz.plugin_version` to explain the rule it applies, and read as
 *   a call site that is a finding that reads nothing.
 *
 * DELIBERATE: the roots are relative to `process.cwd()`, not to this file's own location, so the
 * check can be pointed at a scratch tree that plants a violation. Run it from the repository root
 * and it reads the repository.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

/** The trees that write to a database, the same four `checks/catalog-eval-columns.ts` scans. */
const ROOTS = ["services", "packages", "scripts", "deploy"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

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
 *  this, a check's own `/select … from zz.event/` regex reads as code, the quotes inside it start
 *  a literal that never closes, and every statement after it is read from the wrong place. */
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
 *  declaration whose value is a single literal. Braces are counted in code only, and only once the
 *  parameter list has closed, so a destructured parameter does not end the body early. */
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

const FOLD_DEPTH = 3;

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

/** The verb that writes `plugin_version`, or null: `update` and `delete from` rewrite or erase a
 *  row; `insert into` is the one permitted writer and is reported only when its own `on conflict`
 *  clause turns it into an update; `alter table` is the row gaining a shape it must not have. A
 *  subquery's `from zz.plugin_version` is not a write, so the verb has to be the table's own. */
function writeShape(sql: string): string | null {
  const table = "plugin_version(?!\\w)";
  if (new RegExp(`\\bupdate\\s+(?:only\\s+)?(?:zz\\.)?${table}`, "i").test(sql)) return "updates";
  if (new RegExp(`\\bdelete\\s+from\\s+(?:only\\s+)?(?:zz\\.)?${table}`, "i").test(sql)) return "deletes from";
  if (new RegExp(`\\balter\\s+table\\s+(?:only\\s+)?(?:zz\\.)?${table}`, "i").test(sql)) return "alters";
  if (new RegExp(`\\binsert\\s+into\\s+(?:zz\\.)?${table}[\\s\\S]*?\\bon\\s+conflict\\b[\\s\\S]*?\\bdo\\s+update\\s+set\\b`, "i").test(sql)) {
    return "inserts into, then updates on conflict";
  }
  return null;
}

const fail: string[] = [];
let scanned = 0;
const files = new Set<string>();

for (const { path, src } of ROOTS.flatMap((r) => (existsSync(r) ? sources(r) : []))) {
  const rs = regions(src);
  for (const statement of statementsOf(path, src)) {
    const sql = withoutSqlComments(foldInterpolations(statement.sql, src, rs, path));
    scanned++;
    files.add(path);
    const shape = writeShape(sql);
    if (shape) {
      fail.push(`FAIL: ${statement.path}:${statement.line} — this statement ${shape} zz.plugin_version, ` +
                "which is immutable history: its digest is written once at insert and every later " +
                "fact about a release is a new version, never an update");
    }
  }
}

if (fail.length) {
  console.error(fail.join("\n"));
  process.exit(1);
}
console.log(`plugin_version is immutable: ${scanned} statement(s) in ${files.size} file(s) under ` +
            `${ROOTS.join(", ")} never update it — an insert is the only write.`);
