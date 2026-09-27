/**
 * One live token per purpose, on every writer of a platform access token.
 *
 * `001_init.sql` declares a partial unique index — `(principal_id, label)` where
 * `revoked_at is null and label <> ''`. It is the database saying a label names one purpose, and
 * a purpose has one current credential. A writer that inserts without first revoking the live
 * token of the same purpose therefore does not fail where anyone is looking: the insert raises a
 * unique violation on a write path, it lands inside a catch, and "issuing a token stopped
 * working" is the whole symptom. What the index wants is the revoke, never a delete — the row it
 * replaces is the provenance of what that token obtained, and its `last_used_at` is how anyone
 * finds out whether it was still in use when it was taken away.
 *
 * Read, not run: this finds every `insert into (zz.)pat` under the trees that write to a
 * database, and requires — earlier in the same enclosing block, the same function body or the
 * whole script where there is no block — a revoke of the same principal and the same label.
 *
 * "The same" is decided on the expression each side takes its value from: a `$N` is read back
 * through the argument array of the call that carries it, a literal is itself, and a `select`-form
 * insert's principal is the row its `from … where …` chooses. The two expressions must be equal.
 * DELIBERATE: a value this cannot resolve is reported rather than passed — a statement this check
 * cannot read is not evidence that the writer is correct.
 *
 * DELIBERATE: an empty label is exempt, as the index is, and so is an insert with no `label`
 * column at all (the column defaults to ''). A revoke whose label is not a non-empty literal
 * must also guard the exempt case (`label <> ''`), or the revoke ends every unlabelled token its
 * principal holds — and unlabelled tokens are exactly the ones nobody meant to replace.
 *
 * COUPLED: `checks/insert-arity.ts` reads a statement's columns against its values; this asks
 * what the code around the statement does. The two read the same files and neither runs them.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The trees that write to a database. `testing/` holds the mutation report — recorded runs of
 *  planted defects rather than call sites — and `checks/` reads files instead of writing rows. */
const ROOTS = ["services", "packages", "scripts", "deploy"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** A mutation spec quotes a statement in order to plant a defect in it. Its `find`/`replace` text
 *  is the subject of the check that owns the spec, and reading it as a call site would report the
 *  defect the spec exists to plant. */
const isMutationSpec = (p: string): boolean => /(^|\/)scripts\/mutation\/specs[^/]*\.ts$/.test(p);

interface Source { path: string; src: string }

function sources(dir: string, out: Source[] = []): Source[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { sources(p, out); continue; }
    if (!/\.(ts|sh)$/.test(name) || isMutationSpec(p)) continue;
    out.push({ path: p, src: readFileSync(p, "utf8") });
  }
  return out;
}

/** The end of the string, template or regex-free literal that opens at `i` — the index just past
 *  its closing delimiter, or the end of the file for one that never closes. */
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

/** The source with the inside of every literal and comment blanked to spaces, delimiters kept.
 *  Length is preserved, so a position here is the same position in the original, and the braces
 *  that are left are the ones that belong to the code. */
function blanked(src: string): string {
  const out = src.split("");
  const hide = (from: number, to: number): void => {
    for (let k = Math.max(from, 0); k < Math.min(to, out.length); k++) out[k] = " ";
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? src.length : e;
      hide(i, end); i = end - 1;
    } else if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? src.length : e + 2;
      hide(i, end); i = end - 1;
    } else if (c === '"' || c === "'" || c === "`") {
      const end = literalEnd(src, i);
      hide(i + 1, end - 1); i = end - 1;
    }
  }
  return out.join("");
}

interface Block { open: number; close: number }

function blocks(masked: string): Block[] {
  const stack: number[] = [];
  const out: Block[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "{") stack.push(i);
    else if (masked[i] === "}") {
      const open = stack.pop();
      if (open !== undefined) out.push({ open, close: i });
    }
  }
  return out;
}

/** Where the scope containing `at` begins: the innermost brace pair around it, or the file. */
function scopeStart(bs: Block[], at: number): number {
  let best = -1;
  for (const b of bs) if (b.open < at && b.close > at && b.open > best) best = b.open;
  return best < 0 ? 0 : best;
}

/** The text between the `(`/`[` at `i` and its match, and the index of that match. */
function delimited(src: string, i: number, open: string, close: string): { body: string; close: number } | null {
  if (src[i] !== open) return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return { body: src.slice(i + 1, j), close: j }; }
    else if (c === '"' || c === "'" || c === "`") j = literalEnd(src, j) - 1;
  }
  return null;
}

/** A list's items, split on the commas that are not inside brackets, a call or a string. */
function items(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === '"' || c === "'" || c === "`") i = literalEnd(s, i) - 1;
    else if (c === "," && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

/** The opening delimiter of the literal containing `at`, or -1. */
function literalStart(masked: string, at: number): number {
  for (let i = at; i >= 0; i--) {
    if ('"\'`'.includes(masked[i]) && literalEnd(masked, i) > at) return i;
  }
  return -1;
}

/** The end of the string expression opening at `q`: a concatenation keeps going past a `+`, and
 *  the SQL of one statement is often several literals joined that way. */
function expressionEnd(src: string, q: number): number {
  let j = literalEnd(src, q);
  for (;;) {
    let k = j;
    while (k < src.length && /\s/.test(src[k])) k++;
    if (src[k] !== "+") return j;
    let m = k + 1;
    while (m < src.length && /\s/.test(src[m])) m++;
    if (m >= src.length || !'"\'`'.includes(src[m])) return j;
    j = literalEnd(src, m);
  }
}

/** What a call binds its placeholders to, as the expressions they are written as, or null when
 *  the call carries none — a `psql -c` string, or a statement with no parameters. */
function bindings(src: string, statementEnd: number): string[] | null {
  let k = statementEnd;
  while (k < src.length && /\s/.test(src[k])) k++;
  if (src[k] !== ",") return null;
  k++;
  while (k < src.length && /\s/.test(src[k])) k++;
  if (src[k] !== "[") return null;
  const p = delimited(src, k, "[", "]");
  return p ? items(p.body) : null;
}

/** The expression after `principal_id =` / `label =` in a revoke — a placeholder, a literal, or
 *  the parenthesised subquery that names the principal without knowing its id. */
function rightHand(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] === "(") {
    const p = delimited(text, i, "(", ")");
    return p ? `(${p.body})`.replace(/\s+/g, " ") : null;
  }
  if (text[i] === "'") {
    const e = text.indexOf("'", i + 1);
    return text.slice(i, e < 0 ? text.length : e + 1);
  }
  const rest = /^[^\s,;)]+/.exec(text.slice(i));
  return rest ? rest[0] : null;
}

/** One expression reads as another: whitespace collapsed, the schema qualifier dropped, a
 *  redundant `select` dropped, and the `?? ""` a caller guards an optional label with removed —
 *  so `(select id from zz.principal where email = X)` and the `from zz.principal where email = X`
 *  of a `select`-form insert are the same row. */
function same(a: string, b: string): boolean {
  const norm = (s: string): string => {
    let t = s.replace(/\s+/g, " ").trim();
    t = t.replace(/\bzz\./g, "");
    t = t.replace(/\s*\?\?\s*(""|'')/g, "");
    if (t.startsWith("(") && t.endsWith(")")) t = t.slice(1, -1).trim();
    t = t.replace(/^select\s+\S+\s+from\s+/i, "from ");
    return t;
  };
  return norm(a) === norm(b) && norm(a).length > 0;
}

/** The value a statement's item holds: the expression its placeholder is bound to, or itself. */
function bound(expr: string, bind: string[] | null): string {
  const m = /^\$(\d+)$/.exec(expr);
  if (!m || !bind) return expr;
  const at = Number(m[1]) - 1;
  return at < bind.length ? bind[at] : expr;
}

const fail: string[] = [];
let seen = 0;
let exempt = 0;

for (const { path, src } of ROOTS.flatMap((r) => sources(r))) {
  // A shell script is scoped whole: `${…}` and an awk program are the braces it has, both
  // balanced, and blanking shell quoting is a guess this does not need to make.
  const masked = path.endsWith(".sh") ? src : blanked(src);
  const bs = blocks(masked);
  for (const m of src.matchAll(/insert\s+into\s+(?:zz\.)?pat\b\s*\(/gi)) {
    const at = m.index;
    const where = `${path}:${src.slice(0, at).split("\n").length}`;
    seen++;
    const cols = delimited(src, at + m[0].length - 1, "(", ")");
    if (!cols) { fail.push(`FAIL: ${where} — this check cannot read the columns this insert names`); continue; }
    const names = items(cols.body);
    const pi = names.indexOf("principal_id");
    const li = names.indexOf("label");
    if (pi < 0) { fail.push(`FAIL: ${where} — this check cannot find the principal_id this insert writes`); continue; }

    // The values the statement writes: a `values` list, or a `select` list whose principal is
    // whatever the row its `from …` chooses carries.
    const rest = src.slice(cols.close + 1);
    const values = /^\s*values\s*\(/i.exec(rest);
    const select = /^\s*select\b/i.exec(rest);
    let expr: string[] | null = null;
    let kind: "values" | "select" = "values";
    let tail = "";
    if (values) {
      const p = delimited(src, cols.close + 1 + values[0].length - 1, "(", ")");
      expr = p ? items(p.body) : null;
    } else if (select) {
      const afterSelect = cols.close + 1 + select[0].length;
      const from = /(^|[\s)])from\s+/i.exec(src.slice(afterSelect));
      if (from) {
        const fromAt = afterSelect + from.index + from[0].search(/from/i);
        const stop = src.indexOf(";", fromAt);
        tail = src.slice(fromAt, stop < 0 ? src.length : stop);
        expr = items(src.slice(afterSelect, fromAt));
        kind = "select";
      }
    }
    if (!expr) { fail.push(`FAIL: ${where} — this check cannot read the values this insert writes`); continue; }

    const bind = ((): string[] | null => {
      const q = literalStart(masked, at);
      return q < 0 ? null : bindings(src, expressionEnd(src, q));
    })();
    const principal = kind === "select"
      ? `select ${expr[pi] ?? ""} ${tail}`
      : bound(expr[pi] ?? "", bind);
    // A missing label column writes the column's default, which is '' — not a purpose, so
    // nothing is being replaced. Same for a label bound to the empty literal.
    const label = li < 0 ? "" : bound(expr[li] ?? "", bind).trim();
    if (label === "" || label === `""` || label === "''") { exempt++; continue; }

    const start = scopeStart(bs, at);
    let revoke = -1;
    for (const r of src.matchAll(/update\s+(?:zz\.)?pat\s+set\b/gi)) {
      if (r.index < start) continue;
      if (r.index >= at) break;
      revoke = r.index;
    }
    if (revoke < 0) {
      const erased = /delete\s+from\s+(?:zz\.)?pat\b/i.test(src.slice(start, at))
        ? " the only statement before it that names a (principal, label) erases the row instead " +
          "(a delete loses its provenance and its last_used_at; the row is revoked, never deleted)"
        : "";
      fail.push(`FAIL: ${where} — inserts into zz.pat with no revoke of the live token of the same ` +
                `(principal, label) in the same scope:${erased || " none found."}`);
      continue;
    }
    // From the revoke up to the insert: the revoke's own predicates come first in it, and a
    // guard written anywhere between the two is a guard this writer wrote.
    const text = src.slice(revoke, at);
    if (!/revoked_at\s*=\s*now\s*\(\s*\)/i.test(text) || !/revoked_at\s+is\s+null/i.test(text)) {
      fail.push(`FAIL: ${where} — the revoke before it does not set revoked_at on the live rows ` +
                `(revoked_at = now() … where revoked_at is null)`);
      continue;
    }
    const rq = literalStart(masked, revoke);
    const rbind = rq < 0 ? null : bindings(src, expressionEnd(src, rq));
    const rp = rightHand(text, /principal_id\s*(?:=|in)\s*/i);
    const rl = rightHand(text, /\blabel\s*=\s*/i);
    if (rp === null || rl === null) {
      fail.push(`FAIL: ${where} — this check cannot read the principal and label the revoke before it matches on`);
      continue;
    }
    if (!/^'(?:[^']*)'$/.test(rl.trim()) && !/label\s*(?:<>|!=)\s*''/i.test(text)) {
      fail.push(`FAIL: ${where} — the revoke's label (${rl}) is not a literal, so it must guard the ` +
                `exempt empty label (label <> '') or it ends every unlabelled token its principal holds`);
      continue;
    }
    if (!same(bound(rp, rbind), principal)) {
      fail.push(`FAIL: ${where} — the revoke names principal ${bound(rp, rbind)}, the insert writes ${principal}`);
      continue;
    }
    if (!same(bound(rl, rbind), label)) {
      fail.push(`FAIL: ${where} — the revoke names label ${bound(rl, rbind)}, the insert writes ${label}`);
    }
  }
}

if (fail.length) {
  console.error(fail.join("\n"));
  process.exit(1);
}
console.log(`one live token per purpose: ${seen - exempt} writer(s) of zz.pat revoke the live token ` +
            `of their own (principal, label) before inserting${exempt ? `, ${exempt} exempt (no purpose named)` : ""}`);
