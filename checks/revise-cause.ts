// A revision names the MATERIAL behind it, and there is no other route.
//
// WHY THIS IS NOT THE PLAN'S CHECK. The plan-authored form asked whether the words "both"
// and "neither" appear somewhere in the tool's source. Every comment in that handler is
// prose about causes, so both patterns matched before a line of the feature existed — and
// the two assertions the plan wrote as its own controls were the only ones that ever went
// red. A check an explanatory comment can satisfy is a check that reads nothing.
//
// So the guard conditions are EXECUTED here rather than read. The `if (…)` expressions that
// return a refusal are lifted out of the comment-stripped handler and evaluated over each
// combination of the cause fields. A revision citing nothing is refused; one citing a source
// or carrying `source_content` is accepted — the second half is what a refusal-only check
// cannot see, since an implementation that refuses everything satisfies the first.
//
// `self_edit` USED TO BE THE OTHER ROUTE and this check kept it deliberately: "without it a
// wording fix would have to invent a source". That is now the rule rather than the exception —
// a content change names its material, and one line saying what was wrong IS the material — so
// the field is gone and this check asserts its absence.
import { readFileSync } from "node:fs";

const fail = [];
const src = readFileSync("services/zz-core/src/tools/initiative-acts.ts", "utf8");

// The registration, not the name. "document_revise" also appears in its own comments, in
// its refusals and in the activity payload, so splitting on the bare string lands wherever
// the first mention happens to be.
const at = src.search(/server\.registerTool\(\s*\n?\s*"document_revise"/);
if (at < 0) {
  console.error("document_revise is not registered");
  process.exit(1);
}
const rest = src.slice(at + 20);
const next = rest.search(/\n  server\.registerTool\(/);
const block = next < 0 ? rest : rest.slice(0, next);

// Schema half and handler half. The description and the input names live in the first; the
// executable rule lives in the second.
const cut = block.indexOf("async ({");
if (cut < 0) fail.push("the document_revise handler could not be found");
const head = block.slice(0, cut < 0 ? block.length : cut);
// Every comment in this handler is a full line. Dropping those lines cannot eat a `//`
// inside a string, and it is what makes the assertions below unsatisfiable by prose.
const body = block.slice(cut < 0 ? block.length : cut)
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

// The route that let a version name no material is gone, and stays gone.
if (/self_edit:\s*z\./.test(head)) {
  fail.push("document_revise still takes `self_edit` — a content change names its material");
}
if (!/sources:\s*z\.array/.test(head) || !/source_content:\s*z\.string\(\)/.test(head)) {
  fail.push("document_revise no longer takes both `sources` and `source_content` — " +
            "a revision needs a way to cite what is on the record and a way to add it");
}
// Control: the description must no longer say a cause is optional.
if (/not required|may simply edit/i.test(head)) {
  fail.push('the description still says a cause "is not required"');
}

/** The text between a `(` and its match, starting at the index of the `(`. */
const balanced = (s: string, open: number) => {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === "(") depth += 1;
    else if (s[i] === ")") { depth -= 1; if (!depth) return s.slice(open + 1, i); }
  }
  return null;
};

// Every conditional refusal that turns on the cause fields.
const guards = [];
for (const m of body.matchAll(/\bif\s*\(/g)) {
  const cond = balanced(body, m.index + m[0].length - 1);
  if (cond === null || !/\bcauses\b/.test(cond)) continue;
  const after = body.slice(m.index + m[0].length + cond.length);
  const ret = after.search(/^\s*\)?\s*\{?\s*return text\(/);
  if (ret !== 0) continue; // a conditional that does something other than refuse
  const open = after.indexOf("(", after.indexOf("return text"));
  guards.push({ cond, message: balanced(after, open) ?? "" });
}
if (!guards.length) {
  fail.push("no conditional refusal in document_revise turns on the cause fields — " +
            "either the rule is gone or this check can no longer read it");
}

// Every combination of the cause fields there is now.
const CASES = [
  { name: "no material at all", causes: [], refuse: true },
  { name: "words passed as source_content", causes: ["source_content"], refuse: false },
  { name: "a source already on the record", causes: ["sources"], refuse: false },
  { name: "both a cited source and new words", causes: ["sources", "source_content"], refuse: false },
];

for (const c of CASES) {
  const firing = [];
  for (const g of guards) {
    let fn;
    try {
      fn = new Function("causes", "explained", `return (${g.cond});`);
    } catch {
      fail.push(`a refusal condition cannot be parsed: ${g.cond}`);
      continue;
    }
    try {
      if (fn(c.causes, c.causes.length > 0)) firing.push(g);
    } catch (err) {
      // An honest red. The condition reads something this check cannot bind, so the check
      // no longer knows what the tool does and must not report that it does.
      fail.push(`the refusal condition \`${g.cond}\` reads something this check cannot ` +
                `bind (${err instanceof Error ? err.message : String(err)}) — rewrite it in terms of causes, or teach ` +
                `this check the new name`);
      continue;
    }
  }
  if (c.refuse && !firing.length) fail.push(`a revision with ${c.name} is accepted`);
  if (!c.refuse && firing.length) fail.push(`a revision with ${c.name} is refused`);
  if (c.name.startsWith("no material") && firing.length) {
    // The way out has to exist. A refusal naming a field the tool does not take is a dead
    // end dressed as an instruction, and this one is reached by a caller whose revision is
    // legitimate — the only thing left to tell them is which claim to make.
    const declared = new Set([...head.matchAll(/^\s{8}(\w+):\s*z\./gm)].map((m) => m[1]));
    const named = [...new Set([...firing[0].message.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]))];
    if (!declared.size) fail.push("the inputSchema of document_revise could not be read");
    for (const n of named) {
      if (declared.size && !declared.has(n)) {
        fail.push(`the no-cause refusal tells the caller to send \`${n}\`, ` +
                  `which document_revise does not take`);
      }
    }
    if (named.length < 2) {
      fail.push("the no-cause refusal names fewer than two routes; a caller who reaches it " +
                "has a legitimate revision and needs both");
    }
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("revise cause: ok");
