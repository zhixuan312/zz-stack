#!/usr/bin/env node
/**
 * An authorization code is stored as its hash, and spent exactly once.
 *
 * `001_init.sql` replaces `mcp_oauth_authz.id` (the raw code) with a `code_hash`
 * primary key, because a code is a bearer credential for ten minutes: a reader of the table —
 * a backup, a slow-query log, anybody with a psql prompt — could otherwise replay a grant as
 * the person it was issued for. The hash is the same proof and none of the exposure.
 *
 * The consumption has to be one statement. A read that decides the code is unused and a write
 * that marks it used are two statements, and two clients racing one code both pass the read;
 * the `update … where code_hash = $1 and used_at is null` is what makes exactly one of them
 * win. The same statement joins the client, so a code a client was handed before its
 * revocation cannot be exchanged after it — and the row count has to be compared to one, or a
 * statement that matched nothing reads as a success.
 *
 * Read, not run: this reads `mcp-oauth.ts` and asks what its statements do. The behaviour on a
 * real database is the acceptance criteria's; this is the source half of it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { root } from "../scripts/gate/read.ts";

const REL = "services/gateway/src/mcp-oauth.ts";
const FILE = join(root, REL);
const fail: string[] = [];

if (!existsSync(FILE)) {
  console.error(`FAIL: ${REL} does not exist — the OAuth exchange cannot be checked`);
  process.exit(1);
}
const raw = readFileSync(FILE, "utf8");

/** The source with every comment blanked to spaces, and — when `literals` — the inside of every
 *  string blanked too, the delimiters kept. Length is preserved, so a position here is the same
 *  position in `raw`.
 *
 *  Two views of one source, because the two questions are opposite: what a statement *says* is
 *  inside a string and has to be read (`codelike`), while what a call *passes* it is punctuation
 *  around strings and has to be parsed without a comma in a comment counting as a separator
 *  (`mask`). A trailing `// …` between a statement and its argument array is exactly the case
 *  that separates them. */
function blanked(src: string, literals: boolean): string {
  const out = src.split("");
  const hide = (from: number, to: number): void => {
    for (let k = Math.max(from, 0); k < Math.min(to, out.length); k++) out[k] = " ";
  };
  const literalEnd = (q: number): number => {
    let j = q + 1;
    while (j < src.length) {
      if (src[j] === "\\") { j += 2; continue; }
      if (src[j] === src[q]) return j;
      j++;
    }
    return src.length - 1;
  };
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "/" && src[i + 1] === "/") {
      const e = src.indexOf("\n", i);
      const stop = e < 0 ? src.length : e;
      hide(i, stop); i = stop - 1;
    } else if (src[i] === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      const stop = e < 0 ? src.length : e + 2;
      hide(i, stop); i = stop - 1;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const e = literalEnd(i);
      if (literals) hide(i + 1, e);
      i = e;
    }
  }
  return out.join("");
}
const codelike = blanked(raw, false);
const mask = blanked(raw, true);

/** The delimiter pair around `at`, as the positions of its two delimiters. */
function literalAround(at: number): { open: number; close: number } | null {
  for (let i = at; i >= 0; i--) {
    const q = mask[i];
    if (q !== '"' && q !== "'" && q !== "`") continue;
    let j = i + 1;
    while (j < mask.length) {
      if (mask[j] === "\\") { j += 2; continue; }
      if (mask[j] === q) break;
      j++;
    }
    if (j > at) return { open: i, close: Math.min(j, mask.length - 1) };
  }
  return null;
}

/** The `[…]` a call passes after its statement, as the raw expressions it holds. */
function boundArgs(after: number): string[] | null {
  let k = after;
  while (k < mask.length && /\s/.test(mask[k])) k++;
  if (mask[k] !== ",") return null;
  k++;
  while (k < mask.length && /\s/.test(mask[k])) k++;
  if (mask[k] !== "[") return null;
  const out: string[] = [];
  let depth = 0;
  let start = k + 1;
  for (let i = k; i < mask.length; i++) {
    const c = mask[i];
    if (c === "[" || c === "(" || c === "{") depth++;
    else if (c === "]" || c === ")" || c === "}") {
      depth--;
      if (depth === 0) { out.push(raw.slice(start, i).trim()); return out; }
    } else if (c === "," && depth === 1) { out.push(raw.slice(start, i).trim()); start = i + 1; }
  }
  return null;
}

/** Every statement naming `zz.mcp_oauth_authz` that `re` selects, with its bindings. Matched on
 *  `codelike`, so the statement's own text is readable; `literalAround` then accepts only a match
 *  that sits inside a string, which is what keeps a statement named in a comment out. */
function statements(re: RegExp): { sql: string; args: string[] | null; at: number }[] {
  const found: { sql: string; args: string[] | null; at: number }[] = [];
  for (const m of codelike.matchAll(re)) {
    const at = m.index ?? 0;
    const lit = literalAround(at);
    if (!lit || at <= lit.open) continue;
    found.push({ sql: raw.slice(lit.open + 1, lit.close), args: boundArgs(lit.close + 1), at });
  }
  return found;
}

/** The items of a comma-separated SQL list, split where the brackets balance. */
function sqlItems(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "'") { const e = s.indexOf("'", i + 1); i = e < 0 ? s.length : e; }
    else if (c === "," && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
  }
  out.push(s.slice(start).trim());
  return out.filter((x) => x.length > 0);
}

/** What a statement binds its `$N` to, or the expression itself for anything else. */
const binding = (s: { args: string[] | null }, expr: string): string | null => {
  const m = /^\$(\d+)$/.exec(expr);
  if (!m) return expr;
  const i = Number(m[1]) - 1;
  return s.args && i < s.args.length ? s.args[i] : null;
};

// Names in this file that hold a hash of the presented code, so `codeHash` counts as the hash
// and a bare `code` never does.
const hashedNames = new Set(
  [...mask.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*sha256\s*\(/g)].map((m) => m[1]));
const isHash = (expr: string | null): boolean =>
  !!expr && (/sha256\s*\(/.test(expr) || hashedNames.has(expr.trim()));

// ── 1. The code is stored as its hash, and the raw code is stored nowhere ───────────────────
const inserts = statements(/insert\s+into\s+zz\.mcp_oauth_authz\b/gi);
if (inserts.length === 0) {
  fail.push(`FAIL: ${REL} inserts no authorization code at all — either the authorize endpoint no ` +
            "longer issues one, or this check can no longer read it");
}
for (const s of inserts) {
  const cols = /\(\s*([a-z_,\s]+?)\s*\)\s*values\s*\(/i.exec(s.sql);
  if (!cols) {
    fail.push(`FAIL: ${REL} — this check cannot read the columns of an insert into zz.mcp_oauth_authz`);
    continue;
  }
  const names = sqlItems(cols[1]);
  if (!names.includes("code_hash")) {
    fail.push(`FAIL: ${REL} — the insert does not name \`code_hash\`, so whatever it writes as the ` +
              "code is what the table holds; the spec's key is the code's own sha256");
    continue;
  }
  for (const gone of ["id", "state", "used"]) {
    if (names.includes(gone)) {
      fail.push(`FAIL: ${REL} — the insert still names \`${gone}\`, which 001_init.sql dropped`);
    }
  }
  const values = /values\s*\(([\s\S]*)\)\s*$/i.exec(s.sql.replace(/\s+/g, " ").trim());
  const list = values ? sqlItems(values[1]) : [];
  const expr = binding(s, list[names.indexOf("code_hash")] ?? "");
  if (!isHash(expr)) {
    fail.push(`FAIL: ${REL} — \`code_hash\` is bound to ${expr === null ? "nothing this can read" : `\`${expr}\``}, ` +
              "which is not the sha256 of the code. The raw code is the credential; the table " +
              "holds its hash and nothing else.");
  }
  for (const arg of s.args ?? []) {
    if (/^code$/.test(arg)) {
      fail.push(`FAIL: ${REL} — an insert into zz.mcp_oauth_authz binds \`code\` directly, so the raw ` +
                "code is being stored and the hash is decoration");
    }
  }
  if (!/interval\s*'10 minutes'/i.test(s.sql)) {
    fail.push(`FAIL: ${REL} — the insert sets no ten-minute expiry, so a code it writes is good for ` +
              "ever — `expires_at` is not null in the new shape and is what bounds the row");
  }
}

// ── 2. One statement spends it, against a live client, and only once ────────────────────────
const consumes = statements(/update\s+zz\.mcp_oauth_authz\b/gi);
if (consumes.length !== 1) {
  fail.push(`FAIL: ${REL} — ${consumes.length} statements update zz.mcp_oauth_authz; the exchange ` +
            "spends a code in exactly one, or two clients racing one code both pass");
}
for (const s of consumes) {
  const sql = s.sql.replace(/\s+/g, " ");
  for (const [what, re] of [
    ["`code_hash = $1`", /code_hash\s*=\s*\$\d+/i],
    ["`used_at is null`", /used_at\s+is\s+null/i],
    ["`expires_at > now()`", /expires_at\s*>\s*now\s*\(\s*\)/i],
    ["a join to `zz.mcp_oauth_client`", /from\s+zz\.mcp_oauth_client\b/i],
    ["`revoked_at is null` on the client", /revoked_at\s+is\s+null/i],
    ["`set used_at = now()`", /set\s+used_at\s*=\s*now\s*\(\s*\)/i],
  ] as [string, RegExp][]) {
    if (!re.test(sql)) {
      fail.push(`FAIL: ${REL} — the statement that spends a code has no ${what}. Without it the ` +
                "exchange succeeds for something it must refuse.");
    }
  }
  const place = /code_hash\s*=\s*(\$\d+)/i.exec(sql);
  const expr = place ? binding(s, place[1]) : null;
  if (!isHash(expr)) {
    fail.push(`FAIL: ${REL} — the consume statement compares code_hash against ` +
              `${expr === null ? "nothing this can read" : `\`${expr}\``}, not the sha256 of the ` +
              "presented code");
  }
  // Exactly one row, and a refusal when there is not. The window is the statement's own call
  // and what follows it: an update that matched nothing must not be answered as a success.
  const after = codelike.slice(s.at, s.at + 3000);
  if (!/rowCount\s*(?:!==|===|!=|==)\s*1\b/.test(after)) {
    fail.push(`FAIL: ${REL} — the exchange never compares the consumed row count to 1, so an update ` +
              "that matched nothing — a spent, expired or unknown code — is answered as a success");
  }
  if (!/invalid_grant/.test(after)) {
    fail.push(`FAIL: ${REL} — a failed consumption is not answered with invalid_grant`);
  }
}

if (fail.length) {
  console.error(fail.join("\n"));
  process.exit(1);
}
console.log(`oauth code consumed: ${inserts.length} insert stores sha256(code) with a ten-minute ` +
            `expiry, ${consumes.length} statement spends it once against a live client and refuses ` +
            "unless exactly one row came back");
