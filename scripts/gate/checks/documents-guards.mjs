/**
 * The write guards: that every write runs them, that none of their answers is discarded, and
 * that nothing lands before the guard that would have refused it.
 *
 * A guard whose return value is computed and dropped is the failure mode this module exists
 * for. It typechecks, it reads as protection, and it protects nothing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { between, firstOf, gateOwnSource, root, scan, sourceFiles, toolsIn, unbuilt, zzCoreSource, zzCoreTools } from "../read.mjs";
import { check } from "../run.mjs";
import { envelopeFields } from "../facts.mjs";

/* ── 5. one implementation per rule, and the code says what it does ────────
 *
 * The long section: guards that must be universal, rules that must exist once, documents
 * that must match the code they describe, and the packaging and deployment that carry both.
 *
 * This banner read "no service exists only as build output" and carried that check's whole
 * explanation — for a check that sits a thousand lines below, at the very END of the run
 * that follows. Checks were added under the heading for months and the heading stayed
 * pinned to its original occupant, so a reader here met a paragraph about services/ops-core
 * above twenty-nine checks about something else, and the check itself had no reason at all
 * beside it. The paragraph moved to where it belongs. */

check("every store mutation goes through the shared guard and persist", () => {
  // patch_file had the activity-log guard and not the _versions/ one, so a model could
  // rewrite the frozen copy of what was approved — the record snapshotOnApproval exists to
  // make un-writable. Two write paths, a guard added to one, and nothing to notice.
  //
  // Only writeGuard is demanded of everything. persistDocument is right for a CHAIN
  // document and wrong for a source or a revision, which legitimately skip the approval
  // snapshot and the ledger — so requiring it everywhere would push tools into doing
  // something incorrect to satisfy a check.
  const src = zzCoreSource();
  const bad = [];
  for (const { name, body } of zzCoreTools()) {
    // A tool that writes the artifact store calls safePath and then writes.
    const mutates = /writeFileSync\(|persistDocument\(/.test(body) && /safePath\(/.test(body);
    if (!mutates) continue;
    // writeGuard is universal: it costs two regexes and it is what stops a tool added
    // later from being the one that can rewrite a frozen approval.
    if (!body.includes("writeGuard(")) bad.push(`${name}: writes the store without writeGuard`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("every tool that writes a file also indexes it", () => {
  // knowledge_supersede wrote the node and index.md and stopped. zz.doc — what
  // search_knowledge actually reads — kept status: adopted until the next boot, so the
  // "we tried this and moved on" signal was invisible to search for as long as the
  // service stayed up. Nothing failed; the index simply disagreed with the file.
  const src = zzCoreSource();
  const bad = [];
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
  // persistDocument is "everything that happens once a mutation is allowed"; documentGuards
  // is "everything that must be true before one is". Both exist because the steps were
  // listed at each call site and each new path got whichever ones its author remembered —
  // patch_file skipped the envelope stamp for months, and revise_document ran no check at
  // all, so a required section could be deleted in a revision without a refusal.
  //
  // The pairing is the check: a tool that persists a document must have asked first. This
  // does not verify WHICH guards ran, only that the two halves stay together, which is the
  // part that drifted.
  const src = zzCoreSource();
  const persists = [...src.matchAll(/persistDocument\(/g)].length - 1;   // less its definition
  const guards = [...src.matchAll(/documentGuards\(/g)].length - 1;
  if (persists < 1 || guards < 1) return "persistDocument or documentGuards has no call sites";
  return persists === guards ? null
    : `${persists} call sites persist a document and ${guards} run documentGuards — a write ` +
      "path that persists without asking is how revise_document came to check nothing";
});

check("no asymmetric fork in the document guards", () => {
  // Two paths to the same effect must cost the same. Three times now the platform has
  // shipped a rule where one route demanded a name or a signature and an equivalent route
  // demanded nothing — and every time, the model took the cheaper one. That is not the
  // model misbehaving; it is a design that offered a cheaper road.
  //
  //   outcome: accepted requires accepted_by;  outcome: delivered requires nothing.
  //   approved_by is enforced;                 accepted_by only inside one branch.
  //   revise_document clears the approval;     patch_file leaves it standing.
  //
  // The mechanisable half of that principle is narrow and worth having: a REQUIRED-ness
  // that is itself conditional on another envelope field's value. Written to match the
  // shape — a guard returning an ERROR about a missing field, from inside a branch keyed
  // to some other field — not opinions about which fields matter.
  const src = zzCoreSource();
  // From the schema. This named eight of the eighteen envelope fields, so an asymmetric fork
  // keyed on any of the other ten was invisible to it.
  const ENVELOPE = `(${envelopeFields().join("|")})`;
  const bad = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // a branch that tests one envelope field against a literal value
    const guard = new RegExp(`\\benv(elope)?[.\\[]"?${ENVELOPE}"?\\]?\\s*===\\s*"`).exec(lines[i]);
    if (!guard) continue;
    // ...and, within the next few lines, refuses because a DIFFERENT envelope field is absent
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
  // The gateway redacted a refusal at WRITE time (to keep an address out of the table) and
  // the report redacted it again at READ time (to group a hundred classes of one), with the
  // same patterns in a different ORDER. Order decides the answer: measured on four real
  // refusals, three came out differently, and `24-08-2026-enquiries` collapsed to
  // `<initiative>` in one and `<date>-enquiries` in the other — so in the report every
  // initiative made its own class, which is the exact failure the redaction exists to
  // prevent.
  //
  // It is one function in @zz/contracts now. A file that writes its own placeholder
  // vocabulary is building a second one.
  const bad = [];
  for (const f of sourceFiles(["."], [".ts", ".mjs"])) {
    if (f === join("packages", "contracts", "src", "index.ts")
        || gateOwnSource(f)) continue;
    const src = readFileSync(join(root, f), "utf8");
    if (/["'`]<(email|initiative|date)>["'`]/.test(src)) {
      bad.push(`${f} writes its own redaction placeholders — import refusalClass instead`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

// A GUARD'S ANSWER IS THE GUARD. Calling one and discarding what it says is the same as not
// calling it, and it compiles: `writeGuard(path);` on its own line is a legal statement, and
// with it write_file accepts a write to `_ledger.md` — the mechanical record the platform
// owns and refuses by hand. Every guard here returns `string | null` precisely so a caller
// must decide, and every call site follows the same two lines:
//
//   const blocked = writeGuard(path);
//   if (blocked) return text(blocked);
//
// "every store mutation goes through the shared guard" asks whether the guard is CALLED. It
// was satisfied by a call whose answer went nowhere, and so was the rest of this file: the
// whole gate passed with the refusal thrown away. Only tsc noticed, and only because the
// variable was left unused — write it without the variable and nothing objects at all.
//
// The guards are found by their type, not by name: `string | null` is the signature of "a
// reason to refuse, or nothing", and a guard added tomorrow is covered without an edit.
check("a guard's answer is never discarded", () => {
  const files = sourceFiles(["services", "packages"], [".ts"]);
  const guards = new Set();
  for (const f of files) {
    for (const m of readFileSync(join(root, f), "utf8")
                      .matchAll(/function ([a-zA-Z_]\w*)\s*\([\s\S]{0,300}?\)\s*:\s*string \| null/g)) {
      guards.add(m[1]);
    }
  }
  if (guards.size === 0) return "found no `string | null` guard at all — the extraction is broken";
  const bad = [];
  for (const f of files) {
    readFileSync(join(root, f), "utf8").split("\n").forEach((raw, i) => {
      const line = raw.trim();
      if (line.startsWith("//") || line.startsWith("*")) return;
      // A bare call statement: the line IS `guard(...)` and nothing takes the result.
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
  // revise_document wrote the source document that explains a revision FORTY LINES before
  // documentGuards ran. So a revision the platform then refused left that source on disk,
  // indexed into zz.doc and logged to activity, while the caller was told the write had
  // failed and reasonably believed nothing had happened — and it sat uncommitted until some
  // later act swept it into a commit under that act's name. The store kept a source document
  // for a revision that never occurred.
  //
  // The rule is only for handlers that DO validate: knowledge_add and okr_set write things
  // that are not chain documents and have no documentGuards to run, and requiring one of
  // them would be inventing a rule rather than enforcing one. Where a guard exists, nothing
  // may precede it — computing a NAME is free, and that is all a document needs to link to
  // something it has not written yet.
  const src = zzCoreSource();
  const bad = [];
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
  // A generic precedence sniff was tried and abandoned: close() has no `??` between its
  // pair, so the detector short-circuited and could never fail; and reconcile()'s
  // pre-existing NEITHER-supplied refusal already names both parameters, so a substring
  // scan for "an ERROR mentioning both" passed on the unfixed defect. The pairs are
  // enumerated instead — adding one is a visible diff, which is the point.
  //
  // ONE LINE PER REFUSAL, and that is a real constraint on the code this reads. Every
  // refusal in server.ts is a concatenation of quoted literals with backticked identifiers,
  // so a class excluding the backtick — which is what the plan this check came from
  // specified — extracts `"ERROR: "` and dies seven characters in, failing on correct code
  // and failing identically whether a guard is present or not. Backticks are allowed
  // through and the NEWLINE is the bound instead: a fragment cannot run past its own line.
  //
  // The newline bound is not tidiness. reconcile()'s body carries a comment reading
  // "tool answers 200 with `ERROR:` in its text", and a fragment starting there could
  // otherwise absorb `initiative` and `block` out of the code below it and pass a tool
  // whose guard had been deleted.
  //
  // WHAT THIS DEPENDS ON: both refusals name their pair inside their FIRST source line. A
  // future refusal that wrapped its pair across two lines would be reported as missing when
  // it is merely formatted differently. That is the safe direction — loud, not silent — but
  // the fix is to keep the pair on one line, not to widen the bound back out.
  const PAIRS = [
    { tool: "close", a: "accepted_by", b: "no_signoff_reason", neither: "needs `no_signoff_reason`" },
    { tool: "reconcile", a: "initiative", b: "block", neither: "ask by" },
  ];
  const src = zzCoreSource();
  const bad = [];
  for (const p of PAIRS) {
    const at = src.indexOf(`registerTool(\n    "${p.tool}"`);
    if (at < 0) { bad.push(`${p.tool} is no longer registered — remove it from this check or restore it`); continue; }
    const body = src.slice(at, src.indexOf("\n  );", at));
    const refusals = [...body.matchAll(/ERROR:[^"'\n]{0,400}/g)].map((m) => m[0]);
    const both = refusals.filter((r) => r.includes(p.a) && r.includes(p.b) && !r.includes(p.neither));
    if (!both.length) {
      bad.push(`${p.tool} has no both-supplied refusal naming ${p.a} and ${p.b} that is distinct from its neither-supplied one`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("the claim reader reads a criterion written as a checklist item", () => {
  // ops-flow writes `**AC-1.1** ...` at line start and is read; sdlc-flow writes
  // `- [ ] **AC-6.1** ...` and is not. So a spec's REQUIREMENTS were indexed as its
  // criteria while its actual CRITERIA were indexed not at all — and the console then
  // displayed the result under the heading "acceptance criteria".
  //
  // THE REGION IS READ FROM THE ANCHOR COMMENT FORWARD, so the prose that explains the
  // widening sits ABOVE that sentence in server.ts and the regex sits immediately below it.
  // The lesson is I-4's: a check reading a window either side of an anchor can be satisfied
  // by a COMMENT that names what the code is supposed to do, and then it keeps passing after
  // the code is reverted. Neither the anchor sentence nor anything after it may spell the
  // shapes below in prose — the regex source is the only thing here that carries them, so
  // reverting the regex and keeping every comment fails this check.
  const src = zzCoreSource();
  const at = src.indexOf("An acceptance criterion as the spec states it");
  if (at < 0) return "the fourth claim reader is gone or was renamed";
  const region = src.slice(at, at + 900);
  if (!/\[-\*\]|checkbox|\[ x\]/.test(region)) {
    return "the claim reader still anchors at ^** — a checkbox-prefixed criterion is not indexed";
  }
  return null;
});

check("a tool that builds a path from an initiative name checks it first", () => {
  // safeName's docstring records why it exists: "Several tools instead did
  // `join(root, initiative, ...)` directly, and an initiative of '../other-team/x' resolved
  // outside the caller's store — proven on the live gateway, where a member of one team
  // listed the sources of a directory belonging to another."
  //
  // Four of the five tools taking an `initiative` applied it. add_source did not, and built
  // `${initiative}/sources/…` from the raw argument. safePath still stopped it leaving the
  // store, which is why the gap read as harmless — but being inside the store and being an
  // initiative are different questions, and a name like `a/b` passed the first and is refused
  // as an initiative by every other tool.
  //
  // A tool that only FILTERS on the name (search_knowledge) builds no path and is not asked.
  // EVERY FILE ZZ-CORE REGISTERS A TOOL IN, not the one that holds them today. This is a
  // rule about what a TOOL must do, and a tool does not stop being a tool by moving module.
  const bad = [];
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
  // flowDeclarationCheck sat in the guard chain of BOTH write_file and patch_file, and its
  // refusal said "pass `flow` as an argument to this call". write_file has that argument;
  // patch_file does not. So an agent that hit the refusal while patching was told to do
  // something the tool it was using cannot do — and the refusal that exists to unblock an
  // ungoverned initiative was the one giving the impossible instruction.
  //
  // That guard names write_file outright now, which is the better fix. The rule survives it:
  // a guard reachable from more than one tool must not tell the caller to pass something
  // only some of them take. frontmatterRefusal says exactly that about `stakeholder`, `tags`
  // and `title` — correctly today, because both its callers declare all three.
  //
  // THE PHRASE IS THE SUBJECT, not a named guard. This used to test one guard by name and
  // match a sentence nobody writes any more, so it had quietly stopped looking at anything:
  // its pattern found no message at all, in either shape, and reported a pass. A second
  // guard giving this instruction would have been unchecked, which is the whole failure.
  const SAYS_IT = "argument to this call";
  const src = zzCoreSource();
  const bad = [];

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
  // exempts a status code because for a bare refusal the code is the whole message. The
  // exemption named `code ` and `status ` — the two shapes a BLOCK happens to use — and the
  // platform's own transport refusal is written `http ${res.statusCode}`, so `http 404`,
  // `http 502` and `http 503` all became `http <n>`: a caller asking for a door that is not
  // there and an upstream dying mid-response, counted as one class in the same table
  // watch-results reads to alert when a refusal class gets worse.
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
  const bad = [];
  if (c422 === c500) bad.push("status code 422 and 500 collapse to one class");
  if (h404 === h502) bad.push(`http 404 and http 502 collapse to one class (${h404})`);
  if (!/<n>/.test(counted)) bad.push(`a plain count survives redaction: ${counted}`);
  if (!/<initiative>/.test(counted)) bad.push(`an initiative survives redaction: ${counted}`);
  if (!/<date>/.test(dated)) bad.push(`a date survives redaction: ${dated}`);
  return bad.length ? bad.join("; ") : null;
});

check("a path is resolved before the document at it is judged", () => {
  // write_file was the one write path that called safePath LAST — after eight guards, a chain
  // lookup and an envelope stamp. So `.zz/spec.md` came back complaining about the sections
  // this flow requires, and only after the author had rewritten the document to satisfy that
  // did the next attempt say the path form was wrong and always had been. approve, close,
  // patch_file and revise_document all resolved first; one of five did not, which is the shape
  // a rule takes when it is spelled at each call site instead of held in one place.
  //
  // pathShapeRefusal is the message that teaches the path form, and it teaches nothing from
  // behind a guard. Anything that JUDGES a document — stamps its envelope, renames its
  // headings, runs its guards — is downstream of knowing the path is one the store will accept.
  // BOUNDED HANDLER BODIES, which this check used to do itself and got wrong in two ways.
  // It read server.ts alone, because the whole service concatenated let the last handler run
  // past the end of the file and list_sources was reported for a defect belonging to whatever
  // sorted next. And it split on `server.registerTool(` and kept `parts.slice(1)`, so every
  // handler's "body" also contained every handler after it — a safePath in a LATER tool
  // satisfied an earlier one. zzCoreTools bounds each body inside its own file, which fixes
  // both and is what lets the registrations live in more than one module.
  const JUDGES = ["documentGuards(", "normalizeSections(", "envelopeFor("];
  const bad = [];
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
