// A change to an approved document's body names the material behind it, and there is no other
// route.
//
// The guard conditions are executed here rather than read: the `if (…)` expressions that answer a
// refusal and turn on the causes are lifted out of the comment-stripped `planEdit` — the change
// service `document_edit` runs — and evaluated over each combination of body change, approval and
// cause fields. A check that only looked for the word "cause" in the source is satisfied by any
// comment about causes.
//
// A body change to an approved document citing nothing is refused; one citing a source or carrying
// `source_content` is accepted — the second half is what a refusal-only check cannot see, since an
// implementation that refuses everything satisfies the first. A draft's body, and an approved
// document's metadata alone, change with no cause at all: the rule is about a signed body.
//
// The refusal is evaluated too, and must be the fixed `CAUSE_REQUIRED` text, naming the two fields
// a caller sends and that `document_edit`'s schema declares.
//
// `self_edit` is gone: a content change names its material, and one line saying what was wrong is
// the material. This check asserts its absence.
//
// Replaces `revise-cause.ts`, whose subject — `document_revise`, which refused every revision
// without a cause because every revision opened a version — is no longer registered.
import { readFileSync } from "node:fs";

const fail: string[] = [];
const service = readFileSync("services/zz-core/src/document-change.ts", "utf8");
const tool = readFileSync("services/zz-core/src/tools/document-edit.ts", "utf8");

/** The text between a bracket and its match, starting at the index of the opening one. */
const balanced = (s: string, open: number, [l, r] = ["(", ")"]): string | null => {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === l) depth += 1;
    else if (s[i] === r) { depth -= 1; if (!depth) return s.slice(open + 1, i); }
  }
  return null;
};

// The registration: its schema half carries the description and the input names.
const at = tool.search(/server\.registerTool\(\s*\n?\s*"document_edit"/);
if (at < 0) {
  console.error("document_edit is not registered in services/zz-core/src/tools/document-edit.ts");
  process.exit(1);
}
const registration = tool.slice(at);
const cut = registration.indexOf("async (");
if (cut < 0) fail.push("the document_edit handler could not be found");
const head = registration.slice(0, cut < 0 ? registration.length : cut);
const handler = registration.slice(cut < 0 ? registration.length : cut)
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

// The route that let a version name no material is gone, and stays gone.
if (/self_edit:\s*z\./.test(head)) {
  fail.push("document_edit takes `self_edit` — a content change names its material");
}
if (!/sources:\s*z\.array/.test(head) || !/source_content:\s*z\.string\(\)/.test(head)) {
  fail.push("document_edit no longer takes both `sources` and `source_content` — a change to an " +
            "approved body needs a way to cite what is on the record and a way to add it");
}
// Control: the description must not say a cause is optional for an approved body.
if (/not required|may simply edit/i.test(head)) {
  fail.push('the description says a cause "is not required"');
}
// The handler answers what the service decided. A refusal computed and then dropped is no rule.
if (!/const plan = await planEdit\(/.test(handler) || !/if \("reply" in plan\) return text\(plan\.reply\)/.test(handler)) {
  fail.push("the document_edit handler no longer returns planEdit's answer, so a refusal the " +
            "change service computes never reaches the caller");
}

// The service's body, comment lines dropped: every comment in planEdit is a full line, so dropping
// those lines cannot eat a `//` inside a string, and it is what makes the assertions below
// unsatisfiable by prose.
const start = service.indexOf("export async function planEdit(");
if (start < 0) {
  console.error("planEdit is gone from services/zz-core/src/document-change.ts — this check cannot run");
  process.exit(1);
}
const brace = service.indexOf("): Promise<", start);
const open = service.indexOf("{\n", brace);
const body = (balanced(service, open, ["{", "}"]) ?? "")
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
if (!body) fail.push("planEdit's body could not be read");

// Every conditional refusal that turns on the causes.
const guards: { cond: string; message: string }[] = [];
for (const m of body.matchAll(/\bif\s*\(/g)) {
  const cond = balanced(body, m.index + m[0].length - 1);
  if (cond === null || !/\bcauses\b/.test(cond)) continue;
  const after = body.slice(m.index + m[0].length + cond.length);
  if (after.search(/^\s*\)?\s*\{?\s*return \{\s*reply:/) !== 0) continue; // not a refusal
  const obj = balanced(after, after.indexOf("{", after.indexOf("return")), ["{", "}"]) ?? "";
  guards.push({ cond, message: obj.replace(/^\s*reply:\s*/, "").trim() });
}
if (!guards.length) {
  fail.push("no conditional refusal in planEdit turns on the causes — either the rule is gone or " +
            "this check can no longer read it");
}

const PATH = "2026-10-06-x/spec.md";
const CAUSE_REQUIRED = `ERROR: CAUSE_REQUIRED — ${PATH} is approved, so a change to its body opens a new ` +
  "version and needs its cause: name an existing source in `sources` or pass the words as `source_content`";
const cause = (name: string) => ({ path: `2026-10-06-x/sources/${name}.md`, revision: 1, linked_by: "agent" });

// Every combination there is now. `causes` is what the service has gathered by the guard: what the
// caller named, the words it filed, and the sources the platform owes.
const CASES = [
  { name: "an approved body changed with no material at all", bodyChanged: true, approved: true, causes: [], refuse: true },
  { name: "an approved body changed with words passed as source_content", bodyChanged: true, approved: true,
    causes: [cause("captured")], refuse: false },
  { name: "an approved body changed with a source already on the record", bodyChanged: true, approved: true,
    causes: [cause("named")], refuse: false },
  { name: "an approved body changed with both a cited source and new words", bodyChanged: true, approved: true,
    causes: [cause("named"), cause("captured")], refuse: false },
  { name: "an approved document's metadata alone", bodyChanged: false, approved: true, causes: [], refuse: false },
  { name: "a draft's body changed with no material", bodyChanged: true, approved: false, causes: [], refuse: false },
];

for (const c of CASES) {
  const firing: { cond: string; message: string }[] = [];
  for (const g of guards) {
    let fn: (bodyChanged: boolean, approved: boolean, causes: unknown[]) => unknown;
    try {
      fn = new Function("bodyChanged", "approved", "causes", `return (${g.cond});`) as typeof fn;
    } catch {
      fail.push(`a refusal condition cannot be parsed: ${g.cond}`);
      continue;
    }
    try {
      if (fn(c.bodyChanged, c.approved, c.causes)) firing.push(g);
    } catch (err) {
      // An honest red. The condition reads something this check cannot bind, so the check no longer
      // knows what the tool does and must not report that it does.
      fail.push(`the refusal condition \`${g.cond}\` reads something this check cannot ` +
                `bind (${err instanceof Error ? err.message : String(err)}) — rewrite it in terms of ` +
                "bodyChanged, approved and causes, or teach this check the new name");
    }
  }
  if (c.refuse && !firing.length) fail.push(`${c.name} is accepted`);
  if (!c.refuse && firing.length) fail.push(`${c.name} is refused`);
  if (c.refuse && firing.length) {
    // The way out has to exist. A refusal naming a field the tool does not take is a dead end
    // dressed as an instruction, and this one is reached by a caller whose change is legitimate.
    let said: unknown;
    try {
      // Nothing named was dropped as already cited, so the fixed text is what is said.
      said = new Function("path", "recited", "version", `return (${firing[0].message});`)(PATH, [], 1);
    } catch (err) {
      fail.push(`the no-cause refusal cannot be evaluated (${err instanceof Error ? err.message : String(err)}): ` +
                firing[0].message);
    }
    if (said !== undefined && said !== CAUSE_REQUIRED) {
      fail.push(`the no-cause refusal is not the fixed CAUSE_REQUIRED text: ${JSON.stringify(said)}`);
    }
    const declared = new Set([...head.matchAll(/(?:^|[\s,{])(\w+):\s*z\./gm)].map((m) => m[1]));
    const named = [...new Set([...String(said ?? "").matchAll(/`([a-z_]+)`/g)].map((m) => m[1]))];
    if (!declared.size) fail.push("the inputSchema of document_edit could not be read");
    for (const n of named) {
      if (declared.size && !declared.has(n)) {
        fail.push(`the no-cause refusal tells the caller to send \`${n}\`, which document_edit does not take`);
      }
    }
    if (named.length < 2) {
      fail.push("the no-cause refusal names fewer than two routes; a caller who reaches it has a " +
                "legitimate change and needs both");
    }
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("edit cause: ok");
