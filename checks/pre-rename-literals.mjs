// A file that resolves old names onto new ones must not then match against an old one.
//
// THE DEFECT THIS EXISTS FOR, found by reading and not by any check. `tool-report.ts` grouped
// subjects through `resolveToolKey`, which folds `skill_view` onto `skill_read` — and then
// filtered those resolved values with `.includes("skill_view")`. It matched no row, ever: the
// "skills this run loaded" section silently stopped rendering. `alias-applied`,
// `telemetry-columns` and `tsc` all stayed green, because each task was individually correct.
// It was an interaction BETWEEN two tasks' work, which is the class no single task's check can
// see.
//
// The rule writes itself from the frozen maps, so it needs no list anybody maintains and grows
// the moment a map entry is added.
//
// A RAW NAME IS SOMETIMES RIGHT, and this must not punish it. `tool-telemetry.ts` compares the
// MCP tool name as the CLIENT sent it — a pre-resolution value, where the old spelling is the
// correct one and `resolveToolKey` would be wrong. Such a site declares itself with a
// `RAW NAME:` marker on the line or the line above, which forces the author to say why rather
// than leaving the next reader to guess. A marker is used instead of a central allowlist
// because an allowlist is a list nobody prunes.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TOOL_ALIAS, MANAGE_ALIAS, EVAL_ALIAS, SKILL_ALIAS }
  from "../packages/contracts/dist/index.js";

const fail = [];
const OLD = new Set([...Object.keys(TOOL_ALIAS), ...Object.keys(MANAGE_ALIAS),
                     ...Object.keys(EVAL_ALIAS), ...Object.keys(SKILL_ALIAS)]);

// The maps' own home defines these names; it is not a consumer of them.
const EXEMPT = new Set(["packages/contracts/src/alias.ts", "packages/contracts/src/index.ts"]);

const walk = (d, out = []) => {
  for (const e of readdirSync(d)) {
    if (["node_modules", "dist", ".git"].includes(e)) continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
};

for (const f of [...walk("packages"), ...walk("services")]) {
  if (EXEMPT.has(f)) continue;
  const src = readFileSync(f, "utf8");
  if (!/\bresolveToolKey\b|\bresolveStep\b/.test(src)) continue;   // not a resolving file

  const lines = src.split("\n");
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Strip comments before looking for a literal: prose recording an old name is history,
    // not a comparison, and every one of these files legitimately carries some.
    let code = raw;
    if (inBlock) { const end = code.indexOf("*/"); if (end < 0) continue; code = code.slice(end + 2); inBlock = false; }
    const open = code.indexOf("/*");
    if (open >= 0) { const close = code.indexOf("*/", open); if (close < 0) { inBlock = true; code = code.slice(0, open); } }
    code = code.replace(/\/\/.*$/, "");
    if (!code.trim()) continue;

    // An EVENT NAME is categorically not a tool name. `res.on("close", …)` is an HTTP
    // response event and collides with the `close` tool purely as a word; several alias keys
    // are ordinary English (`close`, `approve`, `reconcile`) and will collide again. Skipping
    // the listener call sites is narrower and more honest than exempting those words, which
    // would blind the check to a real misuse of them.
    if (/\.(on|once|off|emit|addEventListener|removeEventListener)\s*\(/.test(code)) continue;

    // The marker may sit anywhere in the contiguous comment block directly above, not only on
    // the previous line: this repo explains itself in paragraphs, and a rule that only reads
    // one line up would force the reason to be crammed onto it.
    let marked = /RAW NAME:/.test(raw);
    for (let j = i - 1; j >= 0 && !marked; j--) {
      const t = lines[j].trim();
      if (!t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")) break;
      if (/RAW NAME:/.test(t)) marked = true;
    }
    // QUOTED STRINGS AND REGEX ALTERNATIONS. The first spelling was quoted-only, and
    // `tool-telemetry.ts` turned out to hold a SECOND raw-name site the check could not see:
    // `/^(document_write|document_revise|document_patch)$/`, comparing the same client-sent
    // field as the quoted one fifteen lines above it. A name inside a regex literal is as much
    // a comparison as a name inside quotes; only the delimiters differ. Matching the regex
    // metacharacters that fence an alternation or an anchor covers it without trying to parse
    // JavaScript's regex-versus-division ambiguity, which is not worth the false positives.
    const TOKENS = [/["'`]([a-z0-9_]+)["'`]/g, /[/(|^]([a-z0-9_]+)[/)|$]/g];
    for (const m of [...code.matchAll(TOKENS[0]), ...code.matchAll(TOKENS[1])]) {
      if (!OLD.has(m[1]) || marked) continue;
      fail.push(`${f}:${i + 1} matches the pre-rename name "${m[1]}" in a file that resolves ` +
                `names through the alias maps — resolved values never carry it, so this ` +
                `matches nothing. Use "${{ ...TOOL_ALIAS, ...MANAGE_ALIAS, ...EVAL_ALIAS,
                ...SKILL_ALIAS }[m[1]]}", or mark the line \`RAW NAME:\` and say why it is raw.`);
    }
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("pre-rename literals: ok");
