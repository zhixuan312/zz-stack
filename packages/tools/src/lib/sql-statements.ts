/**
 * The statement reader the gate's SQL checks share: every string or template literal that is a
 * statement, and the split of a source into code, literal and comment that makes that possible.
 *
 * Five checks under `checks/` carried their own copy of this — `catalog-eval-columns`,
 * `dropped-columns`, `eval-family-readers`, `plugin-version-immutable` and `scored-run-terminal` —
 * six identical functions each, about a thousand lines in all. `lib/sql-scan.ts` was extracted for
 * two of the consumers (`check:sql` and the gate's console check) and says outright that "both must
 * agree exactly on where a statement starts and ends"; five private copies are five more that
 * nothing holds to that, and a scanner fixed in one place and not another makes a check that misses
 * the statement it exists to find. This is that scanner, once, for all of them.
 *
 * What stays with the caller is its POLICY: which files it walks, and what it does with a
 * statement once it has one. `sourceFiles` takes that as a predicate rather than guessing, because
 * the skip rules ARE the check's judgement — `scored-run-terminal` skips an applied migration and a
 * mutation spec, and a reader that decided that for it would be deciding it wrongly for the next
 * check that shares this.
 *
 * Moved verbatim from `checks/scored-run-terminal.ts`, whose copies had been identical to the other
 * four's byte for byte.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The shape `sourceFiles` accumulates. Not exported: it is this module's own parameter type, and
 *  an export nothing imports is dead surface — the gate refuses one. */
interface ScanSource { path: string; src: string }

export const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** Every file under `dir` that `keep` accepts, walked depth-first, skipping the trees no check
 *  reads. `keep` sees the path, not the name: a rule about `services/gateway/migrations/` needs the
 *  whole of it. */
export function sourceFiles(dir: string, keep: (path: string) => boolean, out: ScanSource[] = []): ScanSource[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { sourceFiles(p, keep, out); continue; }
    if (keep(p)) out.push({ path: p, src: readFileSync(p, "utf8") });
  }
  return out;
}

/** The end of the string or template literal that opens at `i` — the index just past its closing
 *  delimiter, or the end of the file for one that never closes. */
export function literalEnd(src: string, i: number): number {
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
export function regexEnd(src: string, i: number): number {
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
export function opensRegex(src: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  if (k < 0) return true;
  if ("(,=:[!&|?{};+-*%~^<>".includes(src[k])) return true;
  const word = /([A-Za-z_$][\w$]*)$/.exec(src.slice(0, k + 1))?.[1];
  return word !== undefined &&
    /^(return|typeof|case|in|of|do|else|yield|await|delete|void|instanceof|new)$/.test(word);
}

export interface Region { kind: "code" | "literal" | "comment"; start: number; end: number }

/** The source split into code, literal and comment — one pass, so a quote inside a comment, a
 *  `//` inside a literal or a `'` inside a regex is read for what it is rather than guessed at. */
export function regions(src: string): Region[] {
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

export interface Statement { path: string; line: number; sql: string }

/** One statement per string or template literal, adjacent literals a `+` joins read as one. */
export function statementsOf(path: string, src: string): Statement[] {
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
