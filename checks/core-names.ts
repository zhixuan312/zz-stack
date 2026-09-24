// Every core rename is applied at the door, and no caller still names an old one.
//
// COUPLED: `TOOL_ALIAS` in `packages/contracts/src/alias.ts` is the old → new map and this
// file reads it rather than re-deriving it. A `<verb>_<noun>` → `<noun>_<verb>` rule would produce `whoami` for
// `get_my_info` and would rename `block_skills` instead of merging it.
//
// The tool count and the description contract are `checks/core-surface.ts`'s question, not
// this file's.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TOOL_ALIAS } from "../packages/contracts/dist/index.js";

const fail: string[] = [];
const NOUNS = ["session", "skill", "initiative", "document", "source", "knowledge"];

// DELIBERATE: `block_skills` is excluded by name. It has an alias entry so its telemetry
// history resolves, but it is a merge into `skill_list` rather than a rename,
// and nothing in the map's shape distinguishes the two. core-surface.ts asserts it is gone.
const MERGED = "block_skills";
const RENAMES = Object.entries(TOOL_ALIAS).filter(([old]) => old !== MERGED);

// 1. The door
//
// Every service, not just `services/zz-core/src/tools`: this asserts only that the name exists
// somewhere a client can reach. Where it lives is core-surface.ts's question.
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
  // The control: without it this check passes on a door that registers nothing at all, which
  // is precisely the state a broken extraction produces.
  if (!registered.has(neu)) fail.push(`${neu} is registered nowhere — ${old} was renamed to it`);
  if (!NOUNS.some((n) => neu.startsWith(`${n}_`))) {
    fail.push(`${neu} does not start with a core noun (${NOUNS.join(", ")})`);
  }
}

// 2. The callers, which is the half that fails silently
//
// A skill telling a model to call `document_write` when the door says `write_file` gets
// "unknown tool" mid-stage and the model improvises around a step the flow declared mandatory.
// Nothing is red and nothing is logged as a defect.
//
// A reference has a shape, and a bare word boundary is not it: `close`, `approve` and
// `reconcile` are ordinary English and `res.on("close")` is an HTTP event. So: backticked,
// quoted, or in call form with no space before the paren — the same convention
// `skill-tools.ts` uses for "a skill names a TOOL".
//
// The escaped paren counts too. A tool name inside a regex — `/^(write_file|…)$/` in
// tool-telemetry.ts, `approve\(` in an eval grader's `pattern:`, `/close\(\s*(initiative/` in
// the gate's own knowledge.ts — is a live matcher against a name a client sends, and it goes
// stale silently: the regex still compiles, still runs, and matches nothing.
const SHAPE = (old: string) =>
  new RegExp(`(^|[^A-Za-z0-9_.])(?:(["'\`])${old}\\2|\`${old}\\(|${old}\\\\?\\()`);

// The files whose subject is the rename. Each one exists to state the old names, so matching
// them is the check reading its own homework back.
const EXEMPT = new Set([
  "packages/contracts/src/alias.ts", "checks/alias-maps.ts", "checks/alias-applied.ts",
  "checks/pre-rename-literals.ts", "checks/core-surface.ts", "checks/core-names.ts",
]);

// A word that is not the tool declares itself, the way `pre-rename-literals.ts` makes a
// deliberate pre-rename literal declare itself with `RAW NAME:`. A marker forces the author to
// write down why, where a central allowlist would be a list nobody prunes and nobody reads.
const MARKER = /NOT A TOOL:/;

// Two files cannot carry the marker, named here rather than folded into EXEMPT because EXEMPT
// means "this file's subject is the rename" and neither file's subject is.
//
// `checks/tenant-lifecycle-matrix.ts` is a plan-authored check whose bytes are frozen before
// execution and hash-verified before and after every task, so nobody — including this
// repository's own conventions — may edit it afterwards. It writes `operation:'approve'`, the
// kernel's mutation verb, which `alias.ts` also knows as the renamed MCP tool
// `document_approve`.
//
// `scripts/gate/checks/commit-result-reconciliation.ts` is frozen the same way. It imports
// `reconcile` from `@zz/contracts` — a pure function that settles what a mutation kernel's
// reply means about the operation that produced it — and reaches no door. The renamed MCP tool
// `knowledge_reconcile` is a different thing sharing an English verb, and the source module it
// imports from carries the `NOT A TOOL:` marker in full.
//
// Named paths rather than a pattern: a third frozen check needing this should have to write
// down why.
const FROZEN_WITHOUT_MARKERS = new Set([
  "checks/tenant-lifecycle-matrix.ts",
  "scripts/gate/checks/commit-result-reconciliation.ts",
]);

const TREES = ["services", "packages", "scripts", "checks", "catalog", "marketplace", "skills",
               "testing"];
const CODE = /\.(ts|tsx|mjs|js)$/;
const YAML = /\.ya?ml$/;

for (const p of TREES.flatMap((t) => walk(t))) {
  if (!/\.(ts|tsx|mjs|js|json|md|ya?ml|sh)$/.test(p) || EXEMPT.has(p) || FROZEN_WITHOUT_MARKERS.has(p)) continue;
  const lines = readFileSync(p, "utf8").split("\n");
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let code = raw;
    // Prose in a markdown file is the instruction, so nothing is stripped there. In a source
    // file a comment recording what a name used to be is history.
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
    // the same call written inside a regex literal.
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
