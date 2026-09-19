// Every core rename the spec froze is applied at the door, and no caller still names an old one.
//
// WHAT THIS IS NOT. An earlier draft of this file also asserted that the core door holds
// exactly 19 tools, and that every description says when/returns/refuses. Neither is this
// task's: `checks/core-surface-19.ts` already owns the count — asserting it twice means two
// files go red for one cause and the second one teaches nothing — and the description contract
// (AC-2.13) is a different change that this rename does not make true. Both were dropped
// rather than left failing, because a check registered in the gate and known to be red is a
// check everybody learns to read past.
//
// THE TABLE IS NOT RE-DERIVED HERE. `TOOL_ALIAS` is the frozen old → new map and this file
// reads it. A `<verb>_<noun>` → `<noun>_<verb>` rule would have produced `whoami` for
// `get_my_info` and would have renamed `block_skills` instead of merging it; alias.ts says so
// in its own header, and a check that re-derived the answer would agree with the bug rather
// than with the spec.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TOOL_ALIAS } from "../packages/contracts/dist/index.js";

const fail: string[] = [];
const NOUNS = ["session", "skill", "initiative", "document", "source", "knowledge"];

// `block_skills` IS THE ONE KEY THAT IS NOT A RENAME. It has an alias entry so its telemetry
// history resolves, but the spec's table counts it as a MERGE into `skill_list` — it keeps its
// own registration until that merge lands, and core-surface-19.ts is the check that asserts
// it is gone. Excluded by name rather than by a rule, because nothing in the map's shape
// distinguishes a merge from a rename.
const MERGED = "block_skills";
const RENAMES = Object.entries(TOOL_ALIAS).filter(([old]) => old !== MERGED);

// ── 1. The door ──────────────────────────────────────────────────────────────────────────
//
// EVERY SERVICE, not just `services/zz-core/src/tools`. `knowledge_reindex` is renamed here
// and MOVED to `/manage` by a later task, so a check that demanded it on the core door would
// go red the day that move lands and would be reporting a success. What this asserts is that
// the name exists somewhere a client can reach; where it lives is core-surface-19.ts's
// question.
const walk = (d: string, out: string[] = []) => {
  for (const e of readdirSync(d)) {
    if (["node_modules", "dist", "_versions", "results"].includes(e)) continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
const registered = new Set<string>();
for (const p of walk("services").filter((p) => p.endsWith(".ts"))) {
  for (const m of readFileSync(p, "utf8").matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)) {
    registered.add(m[1]);
  }
}
if (registered.size === 0) fail.push("found no registerTool calls at all — the scan is broken");

for (const [old, neu] of RENAMES) {
  if (registered.has(old)) fail.push(`${old} is still registered — it was renamed to ${neu}`);
  // THE CONTROL. Without it this check passes on a door that registers nothing at all, which
  // is precisely the state a broken extraction produces.
  if (!registered.has(neu)) fail.push(`${neu} is registered nowhere — ${old} was renamed to it`);
  if (!NOUNS.some((n) => neu.startsWith(`${n}_`))) {
    fail.push(`${neu} does not start with a core noun (${NOUNS.join(", ")})`);
  }
}

// ── 2. The callers, which is the half that fails silently ────────────────────────────────
//
// A skill telling a model to call `document_write` when the door says `write_file` gets
// "unknown tool" mid-stage and the model improvises around a step the flow declared
// mandatory. Nothing is red, nothing is logged as a defect, and the run reads as a bad
// answer rather than a broken tool.
//
// A REFERENCE HAS A SHAPE, and a bare word boundary is not it. `close`, `approve` and
// `reconcile` are ordinary English and `res.on("close")` is an HTTP event; matching the word
// put 69 files under `close` alone, most of them prose and socket teardown. So: backticked,
// quoted, or in call form with no space before the paren — the same convention
// `skill-tools.ts` settled on for "a skill names a TOOL", reused rather than reinvented.
//
// AND THE ESCAPED PAREN, which is the form this task nearly shipped past twice. A tool name
// inside a regex — `/^(write_file|…)$/` in tool-telemetry.ts, `approve\(` in an eval grader's
// `pattern:`, `/close\(\s*(initiative/` in the gate's own knowledge.ts — is a live matcher
// against a name a client sends, and it goes stale silently: the regex still compiles, still
// runs, and matches nothing. Three of those were found by reading rather than by any check.
const SHAPE = (old: string) =>
  new RegExp(`(^|[^A-Za-z0-9_.])(?:(["'\`])${old}\\2|\`${old}\\(|${old}\\\\?\\()`);

// The files whose SUBJECT is the rename. Each one exists to state the old names, so matching
// them is the check reading its own homework back.
const EXEMPT = new Set([
  "packages/contracts/src/alias.ts", "checks/alias-maps.ts", "checks/alias-applied.ts",
  "checks/pre-rename-literals.ts", "checks/core-surface-19.ts", "checks/core-names.ts",
]);

// A WORD THAT IS NOT THE TOOL DECLARES ITSELF, the way `pre-rename-literals.ts` makes a
// deliberate pre-rename literal declare itself with `RAW NAME:`. A marker forces the author to
// write down why — a socket event, a flow stage, a `next_move` verb, a grader's word list —
// where a central allowlist would be a list nobody prunes and nobody reads.
const MARKER = /NOT A TOOL:/;

const TREES = ["services", "packages", "scripts", "checks", "catalog", "marketplace", "skills",
               "testing"];
const CODE = /\.(ts|tsx|mjs|js)$/;
const YAML = /\.ya?ml$/;

for (const p of TREES.flatMap((t) => walk(t))) {
  if (!/\.(ts|tsx|mjs|js|json|md|ya?ml|sh)$/.test(p) || EXEMPT.has(p)) continue;
  const lines = readFileSync(p, "utf8").split("\n");
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let code = raw;
    // PROSE IN A MARKDOWN FILE IS THE INSTRUCTION, so nothing is stripped there. In a source
    // file a comment recording what a name used to be is history, and every one of these
    // files legitimately carries some.
    if (CODE.test(p)) {
      if (inBlock) { const e = code.indexOf("*/"); if (e < 0) continue; code = code.slice(e + 2); inBlock = false; }
      const o = code.indexOf("/*");
      if (o >= 0) { const c = code.indexOf("*/", o); if (c < 0) { inBlock = true; code = code.slice(0, o); } }
      code = code.replace(/\/\/.*$/, "");
    } else if (YAML.test(p)) {
      code = code.replace(/(^|\s)#.*$/, "$1");
    }
    if (!code.trim()) continue;
    // An event name is categorically not a tool name — `res.on("close", …)` collides with the
    // tool purely as a word. Skipping the listener call is narrower than exempting `close`,
    // which would blind this to a real skill naming the tool. The optional backslash catches
    // the same call written inside a regex literal, which is how security-boundary.ts asserts
    // that relayBody wires one.
    if (/\.(on|once|off|emit|addEventListener|removeEventListener)\\?\s*\(/.test(code)) continue;

    let marked = MARKER.test(raw);
    for (let j = i - 1; j >= 0 && !marked; j--) {
      const t = lines[j].trim();
      if (!t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("#")) break;
      if (MARKER.test(t)) marked = true;
    }
    if (marked) continue;

    for (const [old, neu] of RENAMES) {
      if (SHAPE(old).test(code)) {
        fail.push(`${p}:${i + 1} names \`${old}\`, which no door registers — it is \`${neu}\` ` +
                  "now. If this is the English word and not the tool, mark the line " +
                  "`NOT A TOOL:` and say which.");
      }
    }
  }
}

if (fail.length) { console.error([...new Set(fail)].join("\n")); process.exit(1); }
console.log(`core names: ok — ${RENAMES.length} renames applied at the door and in every caller`);
