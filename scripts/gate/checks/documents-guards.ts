/**
 * The write guards: that every write runs them, that none of their answers is discarded, and
 * that nothing lands before the guard that would have refused it. A guard whose return value
 * is computed and dropped typechecks and protects nothing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { between, firstOf, gateOwnSource, root, sourceFiles, unbuilt, zzCoreSource, zzCoreTools, withoutComments} from "../read.ts";
import { check } from "../run.ts";
import { envelopeFields } from "../facts.ts";

/* One implementation per rule, and the code says what it does
 *
 * Guards that must be universal, rules that must exist once, documents that must match the
 * code they describe, and the packaging and deployment that carry both. */

check("every store mutation goes through the shared guard and persist", () => {
  // Only writeGuard is demanded of everything. persistDocument is right for a chain document
  // and wrong for a source or a revision, which legitimately skip the approval snapshot and the
  // ledger, so requiring it everywhere would push tools into doing something incorrect to
  // satisfy this check.
  const bad: string[] = [];
  for (const { name, body } of zzCoreTools()) {
    // A tool that writes the artifact store calls safePath and then writes.
    const mutates = /writeFileSync\(|persistDocument\(/.test(body) && /safePath\(/.test(body);
    if (!mutates) continue;
    // writeGuard is universal: it stops a tool added later from rewriting a frozen approval.
    if (!body.includes("writeGuard(")) bad.push(`${name}: writes the store without writeGuard`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("every tool that writes a file also indexes it", () => {
  const bad: string[] = [];
  for (const { name, body } of zzCoreTools()) {
    // Writing a .md into the store means the derived index must be told.
    const writesDoc = /writeFileSync\(|persistDocument\(/.test(body);
    if (!writesDoc) continue;
    if (!/indexDoc\(|persistDocument\(/.test(body)) {
      bad.push(`${name}: writes a file without indexDoc — the index will disagree with it`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("every document write runs the guards", () => {
  // persistDocument is everything that happens once a mutation is allowed; documentGuards is
  // everything that must be true before one is. The pairing is the check: a tool that persists
  // a document must have asked first. It does not verify which guards ran, only that the two
  // halves stay together.
  const src = zzCoreSource();
  const persists = [...src.matchAll(/persistDocument\(/g)].length - 1;   // less its definition
  const guards = [...src.matchAll(/documentGuards\(/g)].length - 1;
  if (persists < 1 || guards < 1) return "persistDocument or documentGuards has no call sites";
  return persists === guards ? null
    : `${persists} call sites persist a document and ${guards} run documentGuards — a write ` +
      "path that persists without asking is how document_revise came to check nothing";
});

check("no asymmetric fork in the document guards", () => {
  // Two paths to the same effect must cost the same; the cheaper one is what gets taken. The
  // mechanisable half is narrow: a required-ness conditional on another envelope field's value.
  // Matched by shape — a guard returning an ERROR about a missing field, from inside a branch
  // keyed to some other field — not by opinions about which fields matter.
  const src = zzCoreSource();
  // From the schema, so a fork keyed on any envelope field is visible to this.
  const ENVELOPE = `(${envelopeFields().join("|")})`;
  const bad: string[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // a branch that tests one envelope field against a literal value
    const guard = new RegExp(`\\benv(elope)?[.\\[]"?${ENVELOPE}"?\\]?\\s*===\\s*"`).exec(lines[i]);
    if (!guard) continue;
    // ...and, within the next few lines, refuses because a different envelope field is absent
    const window = lines.slice(i, i + 6).join(" ");
    const refusal = new RegExp(`ERROR[^"]*\\b${ENVELOPE}\\b`).exec(window);
    if (refusal && refusal[1] !== guard[2] && /\b(no|missing|and no)\b/i.test(window)) {
      bad.push(`server.ts:${i + 1} — \`${guard[2]}\` gates whether \`${refusal[1]}\` is required`);
    }
  }
  return bad.length
    ? `${bad.join("; ")} — a field required only on one branch is a cheaper route to the ` +
      "same close; make both branches cost the same, or make the requirement unconditional"
    : null;
});

check("a refusal is classified in one place", () => {
  // Redaction happens once, in @zz/contracts. Two implementations with the same patterns in a
  // different order give different answers, because order decides which placeholder wins:
  // `24-08-2026-sample-intake` collapses to `<initiative>` under one and `<date>-sample-intake`
  // under the other, so every initiative makes its own class. A file writing its own
  // placeholder vocabulary is a second implementation.
  const bad: string[] = [];
  for (const f of sourceFiles(["."], [".ts"])) {
    if (f === join("packages", "contracts", "src", "index.ts")
        || gateOwnSource(f)) continue;
    const src = readFileSync(join(root, f), "utf8");
    if (/["'`]<(email|initiative|date)>["'`]/.test(src)) {
      bad.push(`${f} writes its own redaction placeholders — import refusalClass instead`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

// A guard's answer is the guard. Calling one and discarding what it says compiles —
// `writeGuard(path);` on its own line is a legal statement — and with it document_write accepts
// a write to `_ledger.md`. Every guard returns `string | null` so a caller must decide, and
// every call site is the same two lines:
//
//   const blocked = writeGuard(path);
//   if (blocked) return text(blocked);
//
// Guards are found by their type, not by name, so one added tomorrow is covered without an edit.
//
// DELIBERATE: the parameter list is matched with `(?:[^()]|\([^()]*\))*`, which cannot cross
// the closing paren it is looking for. It admits one level of nesting, which a parameter type
// like `(x: string) => string` needs, and nothing beyond. A bounded-span pattern such as
// `[\s\S]{0,300}?` attributes a later function's `): string | null` to an earlier one, and a
// global match then swallows the real guards in between.
check("a guard's answer is never discarded", () => {
  const files = sourceFiles(["services", "packages"], [".ts"]);
  const guards = new Set();
  for (const f of files) {
    for (const m of readFileSync(join(root, f), "utf8")
                      .matchAll(/function ([a-zA-Z_]\w*)\s*\((?:[^()]|\([^()]*\))*\)\s*:\s*string \| null/g)) {
      guards.add(m[1]);
    }
  }
  if (guards.size === 0) return "found no `string | null` guard at all — the extraction is broken";
  const bad: string[] = [];
  for (const f of files) {
    readFileSync(join(root, f), "utf8").split("\n").forEach((raw, i) => {
      const line = raw.trim();
      if (line.startsWith("//") || line.startsWith("*")) return;
      // A bare call statement: the line is `guard(...)` and nothing takes the result.
      const m = /^([a-zA-Z_]\w*)\s*\(/.exec(line);
      if (!m || !guards.has(m[1])) return;
      if (!/;\s*$/.test(line)) return;             // still an expression, e.g. a ?? chain
      bad.push(`${f}:${i + 1} calls ${m[1]}() and throws away what it says — a guard that ` +
               "cannot refuse is not a guard");
    });
  }
  return bad.join("\n");
});

check("nothing is written before the guards that would refuse it", () => {
  // A refused call must leave the store as it found it: anything written before documentGuards
  // stays on disk, indexed and logged, while the caller is told the write failed.
  //
  // Only for handlers that do validate — knowledge_add writes things that are not chain
  // documents and has no documentGuards to run. Where a guard exists, nothing may
  // precede it; computing a name is free, and that is all a document needs to link forward.
  const src = zzCoreSource();
  const bad: string[] = [];
  for (const { name, from, body } of zzCoreTools()) {
    const guard = body.search(/\bdocumentGuards\(/);
    if (guard < 0) continue;
    // persistDocument's own write is downstream of the guard by construction.
    for (const w of body.matchAll(/\b(writeFileSync|appendFileSync)\(/g)) {
      if (w.index < guard) {
        const line = src.slice(0, from + w.index).split("\n").length;
        bad.push(`${name} writes at line ${line}, before its documentGuards`);
      }
    }
  }
  return bad.length
    ? `${bad.join("; ")} — a refused call must leave the store as it found it`
    : null;
});

check("every exclusive input pair refuses both-supplied, distinctly", () => {
  // The pairs are enumerated rather than sniffed. initiative_close() has no `??` between its
  // pair, so a precedence detector short-circuits and can never fail; and a substring scan for
  // "an ERROR mentioning both" passes on an unfixed defect, because a neither-supplied refusal
  // already names both parameters.
  //
  // Every refusal in server.ts concatenates quoted literals with backticked identifiers, so the
  // extraction allows backticks through and bounds a fragment at the newline. Without that
  // bound a fragment starting in a comment absorbs identifiers out of the code below it and
  // passes a tool whose guard was deleted.
  //
  // This depends on both refusals naming their pair inside their first source line. One
  // wrapping its pair across two lines is reported as missing — loud, not silent.
  const PAIRS = [
    { tool: "initiative_close", a: "accepted_by", b: "no_signoff_reason", neither: "needs `no_signoff_reason`" },
  ];
  const src = zzCoreSource();
  const bad: string[] = [];
  for (const p of PAIRS) {
    const at = src.indexOf(`registerTool(\n    "${p.tool}"`);
    if (at < 0) { bad.push(`${p.tool} is no longer registered — remove it from this check or restore it`); continue; }
    const body = withoutComments(src.slice(at, src.indexOf("\n  );", at)));
    const refusals = [...body.matchAll(/ERROR:[^"'\n]{0,400}/g)].map((m) => m[0]);
    const both = refusals.filter((r) => r.includes(p.a) && r.includes(p.b) && !r.includes(p.neither));
    if (!both.length) {
      bad.push(`${p.tool} has no both-supplied refusal naming ${p.a} and ${p.b} that is distinct from its neither-supplied one`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("the claim reader reads a criterion written as a checklist item", () => {
  // ops-flow writes `**AC-1.1** …` at line start and sdlc-flow writes `- [ ] **AC-6.1** …`.
  // Both shapes must be indexed as criteria, and a key mentioned mid-sentence must not be: that
  // is a reference to a claim, not a statement of one.
  //
  // COUPLED: the reader is `decisionRows` in packages/indexing/src/rules.ts, not zz-core.
  const dist = join(root, "packages/indexing/dist/index.js");
  if (!existsSync(dist)) {
    return "packages/indexing/dist does not exist — this check runs the compiled reader rather " +
           "than reading it, and `tsc -b` above says why there is none";
  }
  const out = execFileSync("node", ["--input-type=module", "-e",
    `import { decisionRows } from ${JSON.stringify(dist)};` +
    "const keys = (b) => decisionRows(b).map((r) => r.key);" +
    "process.stdout.write(JSON.stringify([" +
    "  keys('**AC-1.1** `[qa]` — the endpoint answers')," +
    "  keys('- [ ] **AC-6.1** `[qa]` — the endpoint answers')," +
    "  keys('* [x] **FR-3** `[qa]` — the endpoint answers')," +
    "  keys('see **AC-9.9** for the rest')," +
    "]));"], { cwd: root, encoding: "utf8" });
  const [plain, box, ticked, midSentence] = JSON.parse(out) as string[][];
  const bad: string[] = [];
  if (plain[0] !== "AC-1.1") bad.push(`a criterion at line start is not indexed (${JSON.stringify(plain)})`);
  if (box[0] !== "AC-6.1") bad.push(`a criterion written \`- [ ] **AC-6.1**\` is not indexed (${JSON.stringify(box)})`);
  if (ticked[0] !== "FR-3") bad.push(`a ticked criterion is not indexed (${JSON.stringify(ticked)})`);
  if (midSentence.length) bad.push(`a key mentioned mid-sentence was indexed as a claim (${JSON.stringify(midSentence)})`);
  return bad.length ? bad.join("; ") : null;
});

check("a tool that builds a path from an initiative name checks it first", () => {
  // An initiative of '../other-team/x' joined into a path resolves outside the caller's store,
  // which is what safeName refuses. safePath alone is not enough: it keeps a path inside the
  // store, but being inside the store and being an initiative are different questions, and a
  // name like `a/b` passes the first while every other tool refuses it as an initiative.
  //
  // A tool that only filters on the name (knowledge_search) builds no path and is not asked.
  // Every file zz-core registers a tool in, not the one that holds them today: the rule is about
  // what a tool must do, and a tool does not stop being one by moving module.
  const bad: string[] = [];
  let asked = 0;
  for (const { name, body } of zzCoreTools()) {
    if (!/\binitiative\b/.test(between(body, "inputSchema:", "async (").text ?? "")) continue;
    // Builds a path from it: joined, or interpolated into one.
    if (!/join\([^)]*\binitiative\b|`\$\{initiative\}\//.test(body)) continue;
    asked += 1;
    if (!/safeName\(\s*initiative\b/.test(body)) {
      bad.push(`${name} builds a path from 'initiative' without safeName`);
    }
  }
  if (!asked) return "no tool builds a path from an initiative — this check reads nothing";
  return bad.length
    ? `${firstOf(bad)} — inside the store and being an initiative are different questions`
    : null;
});

check("a refusal names a way out the tool it came from actually has", () => {
  // A guard reachable from more than one tool must not tell the caller to pass something only
  // some of them take: an agent told to pass an argument its tool does not have cannot follow
  // the refusal. frontmatterRefusal gives that instruction about `stakeholder`, `tags` and
  // `title`, and both its callers declare all three.
  //
  // DELIBERATE: the subject is the phrase, not a named guard. Keyed to one guard's name, this
  // finds nothing the day a second guard gives the same instruction, and reports a pass.
  const SAYS_IT = "argument to this call";
  const src = zzCoreSource();
  const bad: string[] = [];

  // Every function whose text gives that instruction, and the arguments it names.
  const demands = new Map();
  // `export ` too — a function that moved into its own module is exported by definition,
  // and an extraction keyed to the unexported form finds nothing and reports a pass.
  for (const m of src.matchAll(/^(?:export )?(?:async )?function ([a-zA-Z_]\w*)\(/gm)) {
    const fn = between(src, m[0], "\n}");
    if (!fn.text || !fn.text.includes(SAYS_IT)) continue;
    const at = fn.text.indexOf(SAYS_IT);
    // The clause that names them, immediately before the phrase.
    const clause = fn.text.slice(Math.max(0, at - 140), at);
    const names = [...clause.matchAll(/`([a-z_]+)`/g)].map((x) => x[1]);
    if (names.length) demands.set(m[1], [...new Set(names)]);
  }
  if (demands.size === 0) return `no guard says "${SAYS_IT}" — the extraction is broken`;

  // Every tool that calls one of them must declare what it names.
  for (const m of src.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)",\s*\{([\s\S]{0,2500}?)\n    \},\n    async \(\{([^}]*)\}/g)) {
    const [, tool, , args] = m;
    const declared = new Set(args.split(",").map((a) => a.trim().split(":")[0].trim()).filter(Boolean));
    const body = zzCoreTools().find((t) => t.name === tool)?.body ?? "";
    for (const [guard, names] of demands) {
      if (!body.includes(`${guard}(`)) continue;
      for (const nm of names) {
        if (!declared.has(nm)) {
          bad.push(`${guard} tells the caller to pass \`${nm}\` "${SAYS_IT}", and ${tool} has no such argument`);
        }
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a refusal class keeps the number that IS the refusal", () => {
  // refusalClass collapses varying nouns so a hundred refusals group into a few classes, and
  // exempts a status code because for a bare refusal the code is the whole message. That
  // covers `http ${res.statusCode}`, the platform's own transport refusal, as well as `code `
  // and `status `: collapsed to `http <n>`, a door that is not there and an upstream dying
  // mid-response would be one class in the table watch-results alerts on.
  //
  // Run against the real function, both directions — a number that carries the meaning is
  // kept, and one that is just a count is still redacted. An exemption that keeps everything
  // would pass the first half and destroy the grouping the function exists for.
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  const out = execFileSync("node", ["--input-type=module", "-e",
    `import { refusalClass } from ${JSON.stringify(join(root, "packages/contracts/dist/index.js"))};` +
    "const c = (s) => refusalClass(s);" +
    "process.stdout.write(JSON.stringify([" +
    "  c('Request failed with status code 422'), c('Request failed with status code 500')," +
    "  c('http 404'), c('http 502')," +
    "  c('evidence entry 24-08-2026-x has 3 problems'), c('approved on 2026-08-29 by 5 people')," +
    "]));"], { cwd: root, encoding: "utf8" });
  const [c422, c500, h404, h502, counted, dated] = JSON.parse(out);
  const bad: string[] = [];
  if (c422 === c500) bad.push("status code 422 and 500 collapse to one class");
  if (h404 === h502) bad.push(`http 404 and http 502 collapse to one class (${h404})`);
  if (!/<n>/.test(counted)) bad.push(`a plain count survives redaction: ${counted}`);
  if (!/<initiative>/.test(counted)) bad.push(`an initiative survives redaction: ${counted}`);
  if (!/<date>/.test(dated)) bad.push(`a date survives redaction: ${dated}`);
  return bad.length ? bad.join("; ") : null;
});

check("a path is resolved before the document at it is judged", () => {
  // Anything that judges a document — stamps its envelope, renames its headings, runs its
  // guards — is downstream of knowing the path is one the store will accept. pathShapeRefusal
  // teaches the path form, and it teaches nothing from behind a guard.
  //
  // COUPLED: handler bodies come from zzCoreTools, which bounds each body inside its own file.
  // Splitting server.ts on `server.registerTool(` gives every handler a body containing every
  // handler after it, so a safePath in a later tool satisfies an earlier one.
  const JUDGES = ["documentGuards(", "normalizeSections(", "envelopeFor("];
  const bad: string[] = [];
  for (const { name, body } of zzCoreTools()) {
    const judged = JUDGES.map((j) => body.indexOf(j)).filter((i) => i >= 0);
    if (!judged.length) continue;
    const resolved = body.indexOf("safePath(");
    if (resolved < 0) {
      bad.push(`${name} judges a document and never resolves its path with safePath`);
      continue;
    }
    if (resolved > Math.min(...judged)) {
      const first = JUDGES.find((j) => body.indexOf(j) === Math.min(...judged));
      bad.push(`${name} calls ${first} before safePath — a caller who wrote a path the store ` +
               "cannot accept is answered about the document instead of about the path");
    }
  }
  return bad.join("\n");
});
