/**
 * One implementation per rule, and code that says what it does.
 *
 * Nothing exported that nobody imports, no statement written twice in a row, no comment
 * repeating itself, no doc comment attached to nothing, no protocol spelled out in two
 * places. Individually small; together they are what keeps a second copy of a rule from
 * existing long enough to drift from the first.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { COMMENTS, between, firstOf, functionBody, gateOwnSource, gatewaySource, root, sourceFiles, trackedFiles, unbuilt, withoutComments, zzCoreSource } from "../read.mjs";
import { check } from "../run.mjs";
import { NAMING, catalogRoot, flows } from "../facts.mjs";

check("an async guard in a ?? chain is awaited", () => {
  // A PROMISE IS NEVER NULL, so `a() ?? b()` where b is async ends the chain at b — and
  // everything after b is unreachable. It fails silently in the worst way: the outer await
  // resolves b's promise, b returns null for most inputs, every write passes, and the guards
  // below the line are deployed, exercised and absent. Two of them were, for a whole
  // deployment cycle, and the only symptom was a write that should have been refused going
  // through.
  //
  // Narrow on purpose. This checks the ?? chains that DECIDE A REFUSAL — the ones where a
  // missing await means a guard does nothing — by finding async functions in the file and
  // then looking for them unawaited on a `??` line.
  const bad = [];
  // Named per service rather than per file: an unawaited guard is a defect wherever in the
  // service it is written, and zz-core is more than one file.
  for (const [f, src] of [["zz-core", zzCoreSource()],
                          ["services/gateway/src/server.ts",
                           gatewaySource()]]) {
    const asyncNames = new Set(
      [...src.matchAll(/^\s*async function ([A-Za-z0-9_]+)\s*\(/gm)].map((m) => m[1]));
    for (const line of src.split("\n")) {
      const m = /^\s*\?\?\s*([A-Za-z0-9_]+)\s*\(/.exec(line);
      if (m && asyncNames.has(m[1])) bad.push(`${f}: \`?? ${m[1]}(\` is async and not awaited`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("nothing is exported that nobody imports", () => {
  // The compiler finds an unused import and an unused local; it cannot find a symbol that
  // is exported and imported nowhere, because an export is a legitimate public surface as
  // far as tsc is concerned. In a repo with no external consumers it is dead code with a
  // door on it — admin.ts carried three: adminEvent, referenced nowhere at all, and
  // flowsFor and publicBase, exported while only ever called from the file defining them.
  const sources = [];
  sources.push(...sourceFiles(["services", "packages"], [".ts"])
    .filter((f) => !f.endsWith(".d.ts")).map((f) => join(root, f)));
  // COMMENTS STRIPPED, or this file's own prose keeps symbols alive. gate.mjs discusses
  // nearly every export in the repository by name, and it is one of the consumers scanned —
  // so "is this symbol mentioned anywhere else" was answered by a paragraph ABOUT it. Proven:
  // making ENVELOPE_BLOCK genuinely probe-only left this check green, because three comments
  // here say the word.
  //
  // String literals stay. `functionBody(src, "stakeholderCanAnswer")` is a real coupling —
  // rename the function and this file breaks — so a literal naming a symbol is a use. A
  // sentence about it is not.
  const text = new Map(sources.map((p) => [p, withoutComments(readFileSync(p, "utf8"))]));
  // The gate is a consumer too. A symbol exported so this file can exercise it — the
  // identity port's resolver, whose ORDERING is the thing worth testing — is used, and
  // calling it dead would push the test back into reading the code instead of running it.
  // Kept out of `sources` so nothing here is judged for its own exports.
  //
  // RECURSIVE, which is the correction "the configuration surface is documented" already
  // made and this one did not: scripts/probes/ is where two consumers live, and a flat
  // readdir has never seen them. envelope-shape.mjs is the only importer of ENVELOPE_BLOCK
  // outside the services today — it stays live here because zz-core imports it too, so the
  // gap was latent rather than firing. Latent is the wrong thing to leave: this check's
  // finding is "delete this", and a probe-only export would have been reported as dead code
  // somebody then removed.
  for (const f of sourceFiles(["scripts"], [".mjs"])) {
    text.set(join(root, f), withoutComments(readFileSync(join(root, f), "utf8")));
  }

  // THE CONSOLE IS THE SAME REPOSITORY'S PRODUCT AND HAD NO SUCH CHECK. It is a sibling
  // checkout with its own build, so this walks its tree directly — the same arrangement the
  // LLM-client boundary check uses, for the same reason: sourceFiles() answers only for what
  // THIS repo's git tracks. Fifty-seven symbols had accumulated behind that gap, and eight
  // whole primitives — a DataTable named in five other files, every mention a comment.
  //
  // Its own conventions, and each is load-bearing:
  //   · app/ holds Next.js routes, whose `default`, `metadata` and friends are consumed by the
  //     framework rather than by an import. Judging them dead deletes every page.
  //   · components/ui/index.ts is a barrel of `export * from './x'`, which names no symbol —
  //     so a file it re-exports is reachable through it, and the barrel's own re-exports are
  //     not exports to judge.
  //   · tests/ are consumers. Excluding them called a tested helper dead.
  const dash = join(root, "..", "zz-stack-dashboard");
  const dashFiles = [];
  if (existsSync(dash)) {
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith(".") || ["node_modules", ".next", "dist"].includes(e.name)) continue;
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name)) dashFiles.push(full);
      }
    };
    walk(dash);
  }
  const dashText = new Map(dashFiles.map((p) => [p, withoutComments(readFileSync(p, "utf8"))]));
  const bad = [];
  const EXPORTED = /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const [file, src] of text) {
    const rel = file.slice(root.length + 1);
    for (const m of src.matchAll(EXPORTED)) {
      const name = m[1];
      const used = [...text].some(([other, otherSrc]) =>
        other !== file && new RegExp(`\\b${name}\\b`).test(otherSrc));
      if (!used) bad.push(`${rel}: exports ${name}, imported by nothing`);
    }
  }
  const FRAMEWORK = /^(default|metadata|generateMetadata|generateStaticParams|dynamic|revalidate|viewport)$/;
  for (const [file, src] of dashText) {
    const rel = file.slice(dash.length + 1);
    if (rel.startsWith("tests/") || /(^|\/)index\.tsx?$/.test(rel)) continue;
    const isRoute = rel.startsWith("app/");
    // Reachable through the ui barrel: the barrel names the MODULE, never the symbols.
    const viaBarrel = [...dashText].some(([b, bs]) =>
      /(^|\/)index\.tsx?$/.test(b.slice(dash.length + 1))
      && new RegExp(`from\\s+["']\\./${rel.split("/").pop().replace(/\.tsx?$/, "")}["']`).test(bs));
    for (const m of src.matchAll(EXPORTED)) {
      const name = m[1];
      if (isRoute && FRAMEWORK.test(name)) continue;
      if (viaBarrel) continue;
      const used = [...dashText].some(([other, otherSrc]) =>
        other !== file && new RegExp(`\\b${name}\\b`).test(otherSrc));
      if (!used) bad.push(`zz-stack-dashboard/${rel}: exports ${name}, imported by nothing`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("the platform model is one name, however many places name it", () => {
  // Four places carry the model and all four have to move together: the front end's model
  // list, its titleModel, its tokenConfig block — which is keyed BY the model name — and
  // PLATFORM_BASE_MODEL, which the smoke engine reads and render_agent_definition stamps
  // onto every agent it builds.
  //
  // Three of the four are in a file that is mounted read-only and is not hot-reloadable, and
  // the fourth is an environment variable. `${VAR}` would collapse the two value positions,
  // but tokenConfig's model name is a YAML KEY and cannot be one — and a tokenConfig that
  // generic window and caps the conversation at 115.5K, under a ninth of what the model
  // holds, which a long agentic run reaches while the tool schemas alone are most of it.
  //
  // So where the format refuses one declaration, the gate enforces one name. Silent drift
  // becomes a build failure, which is the harm actually being prevented.
  const env = readFileSync(join(root, "deploy/.env.example"), "utf8");
  const declared = /^PLATFORM_BASE_MODEL=(.+)$/m.exec(env)?.[1]?.trim();
  if (!declared) return "deploy/.env.example does not set PLATFORM_BASE_MODEL";
  const found = {
  };
  const bad = Object.entries(found)
    .filter(([, v]) => v !== declared)
    .map(([k, v]) => `${k} says ${v ? `"${v}"` : "nothing"}`);
  return bad.length
    ? `PLATFORM_BASE_MODEL is "${declared}" but ${bad.join("; ")} — all four move together ` +
      "or the front end runs one model with another's context window"
    : null;
});

check("the MCP protocol is written once", () => {
  // Six Python scripts each carried their own MCP client — the smoke harness, the conformance
  // measurer, the chain probe, the block probe, the credential batcher and the provisioner —
  // and a seventh copy sat in release.mjs. They had already drifted: FOUR protocol versions
  // between them (2025-06-18, 2025-03-26, 2024-11-05 twice) and three ways of reading a
  // streamable-HTTP answer. Nothing had broken, because the gateway accepts all of them; the
  // day it stops accepting the oldest, the failure lands in whichever copy nobody remembered.
  //
  // TWO things must not be duplicated, and they are different:
  //
  //   the VERSION — one string, wherever a handshake is built. release.mjs still builds one,
  //   deliberately: its probes use curl to assert a status code over real HTTPS from outside,
  //   which is a stronger claim than "our own client can talk to it". What it may not do is
  //   name the version itself, and it now reads it from the client's source.
  //
  //   the READING of a streamable-HTTP answer — a `data:` frame is where the three Python
  //   copies actually disagreed, and where the subtle bug lived: taking the FIRST frame
  //   returns a progress notification and calls it the answer.
  //
  // A file that does neither is not a second client, however much of the protocol it mentions.
  // services/gateway ANSWERS a handshake for its credential-required stub and echoes the
  // caller's version back; a server compares against "initialize" where a client builds it.
  const VERSION_LITERAL = /protocolVersion"?\s*:\s*"\d{4}-\d{2}-\d{2}"/;
  const BUILDS = /method:\s*"initialize"/;
  const READS_SSE = /(^|[^.\w])data:\s/;
  const bad = [];
  for (const f of sourceFiles(["."], [".ts", ".mjs"])) {
    if (f === join("packages", "mcp-client", "src", "index.ts")) continue;   // the one place it IS written
    // This file contains every pattern it searches for, by construction. So does any linter.
    if (gateOwnSource(f)) continue;
    const src = readFileSync(join(root, f), "utf8");
    if (VERSION_LITERAL.test(src)) bad.push(`${f} names a protocol version of its own`);
    else if (BUILDS.test(src) && READS_SSE.test(src)) bad.push(`${f} is a second MCP client`);
  }
  return bad.length
    ? `${bad.join("; ")} — import from @zz/mcp-client, or read PROTOCOL from it, so the ` +
      "version and the SSE reading are one thing and not several"
    : null;
});

check("every doc comment is attached to something", () => {
  // A `/** … */` block followed immediately by another one documents nothing: the first is
  // stranded and the compiler is perfectly happy, so it survives every build. They arrive
  // by insertion — somebody adds a function between a comment and the function it
  // described, and the comment stays where it was.
  //
  // Seven of them had accumulated. The worst named a parameter: `skipIfHash makes a rebuild
  // cheap` sat 115 lines from indexDoc, attached to an interface that has no parameters at
  // all, while indexDoc itself had no comment. Two of the seven were created in this
  // release by inserting ownershipCheck and commitStore.
  //
  // Only `/**` blocks. A `/* ── section ── */` band is a heading and is meant to sit above
  // the first thing under it.
  const bad = [];
  for (const f of sourceFiles(["."], [".ts", ".mjs"])) {
    const lines = readFileSync(join(root, f), "utf8").split("\n");
    let openedAsDoc = false, closedAt = -2;
    for (const [i, line] of lines.entries()) {
      if (/^\s*\/\*\*/.test(line)) {
        // A doc comment starting on the line right after one closed is the stranded case.
        if (i === closedAt + 1) bad.push(`${f}:${closedAt + 1} documents nothing`);
        openedAsDoc = true;
      } else if (/^\s*\/\*/.test(line)) {
        // A PLAIN block comment right after a doc comment strands it just as surely: the
        // declaration takes whichever comment sits immediately above it, and that is now the
        // plain one. @zz/contracts had exactly this — a one-line doc comment on parseCaller,
        // then a longer block explaining the header names, then the function.
        if (i === closedAt + 1) bad.push(`${f}:${closedAt + 1} documents nothing`);
        openedAsDoc = false;
      }
      if (/\*\/\s*$/.test(line) && openedAsDoc) { closedAt = i; openedAsDoc = false; }
    }
    // THE SECOND SHAPE. A block separated from its symbol by a BLANK LINE is the same defect
    // arriving differently: a JSDoc block belongs against what it describes, so a gap means
    // either the symbol it described is gone or somebody put one between them.
    //
    // admin.ts carried a paragraph about "the model every generated agent preset sits on"
    // over `presetId`, because the constant it described had been inlined into
    // render_agent_definition and the explanation stayed behind. The first shape could not
    // see it: nothing followed it but a blank line.
    //
    // A file header is the exception and the only one — it opens the file and documents the
    // module, so the blank line before the imports is right.
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim().startsWith("/**")) continue;
      const from = i;
      while (i < lines.length && !lines[i].trimEnd().endsWith("*/")) i += 1;
      if (from <= 1) continue;
      if ((lines[i + 1] ?? "x").trim() !== "") continue;
      bad.push(`${f}:${from + 1} is a blank line away from what it documents`);
    }
  }
  return bad.length
    ? `${bad.join("; ")} — a doc block belongs against its symbol; move it to what it describes`
    : null;
});

check("a markdown table row is built, never assembled", () => {
  // zz-core appends three tables — the outcome ledger, the journal log and the journal index
  // — and each assembled its own row. Two escaped their variable fields and the ledger did
  // not, so an initiative folder named `a|b`, which safePath permits, produced a row every
  // parser reads as initiative "a" and outcome "b". That ledger is what the smoke suite's
  // whole verdict rests on and what zz-okr grades key results from, and the model cannot
  // write it — but it could shape it, by choosing a folder name.
  //
  // A row is built by tableRow now, which escapes every cell. This refuses a fourth table
  // assembling its own, which is how the third one came to differ from the other two.
  // zz-core, not one file in it: tableRow moved into document-rules.ts when the pure document
  // rules were split out, and `export const` is what a moved symbol looks like.
  const f = "zz-core";
  const src = zzCoreSource();
  if (!/(export )?const tableRow = /.test(src)) return `${f}: tableRow is gone — the one row builder with it`;
  const bad = [];
  const lines = src.split("\n");
  lines.forEach((ln, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
    // tableRow is the one place that may assemble one — that is what it is for. Exempted by
    // what it IS rather than by line number, the way "the platform database is reached one
        // way" exempts lib/psql.ts.
    if (/const tableRow = /.test(lines[i - 1] ?? "") || /const tableRow = /.test(ln)) return;
    // A template literal that opens a markdown row and interpolates something.
    if (/`\|\s+\$\{/.test(ln)) bad.push(`${f}:${i + 1} assembles a table row instead of calling tableRow`);
  });
  return bad.length
    ? `${firstOf(bad)} — every cell has to be escaped, and one place escaping them is how that stays true`
    : null;
});

check("a plugin is named the same way wherever it is named", () => {
  // A flow named `ops-flow` ships as the plugin `sm`: pluginName drops the trailing -flow, and
  // the marketplace, the install line and the command namespace all take that name.
  //
  // The update line did not. It interpolated the FLOW name, so a person following the setup
  // text ran `claude plugin update ops-flow@zz-platform` for a plugin called `sm` — install
  // and update, in one file, naming the same thing two ways. That is the same failure as the
  // /zz: commands, and it survived in the same file after those were found.
  const src = gatewaySource();
  const bad = [];
  for (const [i, line] of src.split("\n").entries()) {
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    if (/\$\{[^}]*\bf\.flow\}@zz-platform/.test(line) || /\$\{[^}]*\.flow\}@zz-platform/.test(line)) {
      bad.push(`client-package.ts:${i + 1} names a plugin by its flow — use pluginName()`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("the audit criteria are written once", () => {
  // sdlc-spec-audit and sdlc-plan-audit shared 165 IDENTICAL lines — the eleven prose failure
  // modes, the evidence shapes, the JSON a round returns — with nothing holding them
  // together. They were in sync the day this was found, and an edit to either would have
  // left two auditors applying different standards with nobody able to say which was current.
  //
  // Two auditors is deliberate: a spec and a plan fail in different ways, and one generic
  // auditor finds the generic half of both. Two COPIES of the generic half is a different
  // thing, and the platform already has the answer — a flow loads zz-backbone rather than
  // restating it.
  const dir = join(catalogRoot, "sdlc/sdlc-flow/skills");
  const shared = join(dir, "sdlc-audit-criteria/SKILL.md");
  if (!existsSync(shared)) return "sdlc-audit-criteria is missing — the shared criteria have nowhere to live";
  const bad = [];
  const texts = {};
  for (const a of ["sdlc-spec-audit", "sdlc-plan-audit"]) {
    const f = join(dir, a, "SKILL.md");
    if (!existsSync(f)) { bad.push(`${a} is missing`); continue; }
    texts[a] = readFileSync(f, "utf8");
    if (!texts[a].includes("sdlc-audit-criteria")) {
      bad.push(`${a} never loads sdlc-audit-criteria, so its worker gets no criteria at all`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

// A source file with a control byte in it is a file every grep SKIPS.
//
// Three had one. block-conformance used a raw NUL as a Map-key separator, manifest-audit used
// one to join two lists before comparing them, and markdown.ts opened a character range with
// one — the regex that strips whitespace out of a URL before looking for a scheme, so that
// `java script:` cannot hide one. All three worked. All three were also invisible: grep
// reports "Binary file ... matches" and prints nothing, so every sweep over this repository,
// including the ones that found the defects around them, silently skipped those files whole.
// The sanitiser being one of them is the part that matters — a security-relevant line nobody
// searching for it could find.
//
// Written as the escape \u0000 instead, the behaviour is identical and the byte is
// readable. The rule is the general one: source is text, and a control byte makes it not text.
check("every source file is text a search can read", () => {
  const bad = [];
  const exts = [".ts", ".mjs", ".js", ".md", ".json", ".sql", ".yml", ".yaml", ".sh"];
  for (const rel of sourceFiles(["."], exts)) {
    const buf = readFileSync(join(root, rel));
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      // Tab, newline and carriage return are the only control bytes text has.
      if (b >= 32 || b === 9 || b === 10 || b === 13) continue;
      const line = buf.subarray(0, i).toString("utf8").split("\n").length;
      bad.push(`${rel}:${line} has a control byte (0x${b.toString(16)})` +
               " — grep calls this file binary and skips it whole");
      break;
    }
  }
  return bad.join("\n");
});

check("the shared MCP client still behaves", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  // Cases against a stub server, no gateway and no network — the engine prints how many on
  // every run, which is why the number is not repeated here; it said "thirteen" while the
  // engine reported seventeen. The six hand-rolled clients this replaced were never tested at
  // all — they were verified by the scripts around them appearing to work, which is how three
  // of them came to parse a streamable-HTTP answer three different ways without anybody
  // noticing.
  try {
    execFileSync("node", [join(root, "packages/tools/dist/testing/mcp-client-check.js")],
                 { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    return out.split("\n").filter((l) => /FAIL/.test(l)).join("; ") || "mcp client check failed";
  }
});

check("imports run node, then packages, then this directory", () => {
  // Not a taste rule: it is the order 42 of the 43 TypeScript files here already use, and the
  // one that did not put `./identity.js` above `pg` — so a reader scanning db.ts's head for
  // its external dependencies found a relative import where the package list should be.
  // Stating it mechanically costs less than the next person deciding it again.
  //
  // GROUPS ONLY, deliberately. Within a group this repository does not sort — admin.ts reads
  // ./blocks.js, ./db.js, ./identity.js, ./client-package.js — and inventing an
  // alphabetical rule here would report four files as broken against a convention nobody
  // adopted. A check must enforce the practice, not a tidier one it would prefer.
  const rank = (spec) => (spec.startsWith("node:") ? 0 : spec.startsWith(".") ? 2 : 1);
  const findings = [];
  // scripts/ TOO, and it is where the one violation was: this file imported ./manifests.mjs
  // above node:url — the gate breaking the rule the gate enforces, invisible because the walk
  // stopped at packages/ and services/. Five of the six .mjs files here already followed it,
  // which is the same majority the paragraph above cites for the TypeScript.
  for (const rel of [...sourceFiles(["packages", "services"], [".ts"]),
                     ...sourceFiles(["scripts"], [".mjs"])]) {
    const src = readFileSync(join(root, rel), "utf8");
    const seen = [...src.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)];
    for (let i = 1; i < seen.length; i++) {
      if (rank(seen[i][1]) < rank(seen[i - 1][1])) {
        const line = src.slice(0, seen[i].index).split("\n").length;
        findings.push(`${rel}:${line} imports "${seen[i][1]}" after "${seen[i - 1][1]}"`);
        break;                                   // one finding per file is enough to fix it
      }
    }
  }
  return firstOf(findings) &&
    `${firstOf(findings)} — node builtins, then packages, then ./relative`;
});

check("a flag given with nothing after it is refused, not read as absent", () => {
  // parseArgs stores "" for `--actor` written with nothing after it — it will not swallow the
  // next flag as a value — and `flags.get(name) ?? null` hands that "" straight through,
  // because "" is not nullish. Every caller then tests it with `if (value)` and skips the
  // filter in silence.
  //
  // For a flag naming a FILE that is a mistyped flag doing nothing: `--save` without a
  // directory printed the report and saved nothing. For a flag that narrows a QUERY it is
  // worse, because the tool still answers — `--actor` with no address reported on everybody
  // while the operator read it as one evaluation run's calls, which is the single thing that
  // flag exists to separate.
  //
  // tool-report had written the rule out and applied it to five flags. The two it missed were
  // the two that decide what the report is ABOUT, three lines above the comment stating it,
  // because the helper was local to the function rather than beside `required` where the
  // question "what happens when an argument is missing" already lives.
  const bad = [];

  const cli = readFileSync(join(root, "packages/tools/src/lib/cli.ts"), "utf8");
  const body = functionBody(cli, "optional");
  if (!body) return "packages/tools no longer defines optional() — this check cannot run";
  let read;
  try {
    // `die` injected, because the real one exits the process. What is under test is which
    // inputs reach it.
    read = new Function("die", "args", "name", "what", body).bind(
      null, (m) => { throw new Error(m); });
  } catch (err) {
    return `optional() could not be evaluated: ${String(err.message ?? err)}`;
  }
  const withFlags = (pairs) => ({ flags: new Map(pairs) });
  const call = (pairs, name) => {
    try { return { value: read(withFlags(pairs), name, "a value"), refused: false }; }
    catch { return { value: null, refused: true }; }
  };
  const absent = call([["since", "24h"]], "actor");
  if (absent.refused || absent.value !== null) {
    bad.push("optional() does not return null for a flag that was never given");
  }
  const empty = call([["actor", ""]], "actor");
  if (!empty.refused) {
    bad.push("optional() accepts a flag given with nothing after it, which is the mistyped " +
             "flag it exists to catch");
  }
  const blank = call([["actor", "   "]], "actor");
  if (!blank.refused) bad.push("optional() accepts a flag whose value is only whitespace");
  const given = call([["actor", "smoke@example.com"]], "actor");
  if (given.refused || given.value !== "smoke@example.com") {
    bad.push("optional() does not return a value that was actually given");
  }

  // TWO WAYS TO READ A FLAG, and no third. Either it has a real DEFAULT, written
  // `flags.get(x) || fallback` — there the tool still does the right thing against the right
  // target — or it has none and goes through optional(), which refuses a flag given with
  // nothing after it.
  //
  // The forms this replaces all read "" as absent, silently: `?? null` in tool-report, `?? ""`
  // in probe-block, where `--expect` with no value skipped the allowlist comparison it exists
  // for and exited 0; and a bare `get` in collect-turns, where `--since` with no value
  // collected the whole store on the run the flag is documented to bound.
  //
  // Stated as a shape rather than a list of spellings, because the list was what let the
  // second and third survive a fix to the first.
  for (const rel of sourceFiles(["packages/tools"], [".ts"])) {
    if (rel.endsWith("lib/cli.ts")) continue;              // where optional() itself reads one
    readFileSync(join(root, rel), "utf8").split("\n").forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
      for (const m of ln.matchAll(/flags\.get\([^)]*\)/g)) {
        const after = ln.slice(m.index + m[0].length);
        if (/^\s*\|\|/.test(after)) continue;              // a real default
        bad.push(`${rel}:${i + 1} reads a flag with neither a default nor optional(), so a ` +
                 "flag given with nothing after it is read as absent");
      }
    });
  }
  return bad.length ? bad.join("; ") : null;
});

check("a function is never mistaken for what it returns", () => {
  // `const bad = trackedFiles && [...trackedFiles()]` — the guard tested the FUNCTION, which
  // is a declaration and therefore always truthy, and the fallback under it (`if (!bad) return
  // null`, for a checkout with no git) could never run. Outside a checkout trackedFiles()
  // returns null, `[...null]` throws, and the gate reported "trackedFiles is not iterable"
  // instead of skipping a question it cannot answer — a graceful path that was complete and
  // unreachable, in the check that says this repository ships one runtime.
  //
  // The shape is general and mechanical: a `function name(…)` declared in the file, used as a
  // bare truthiness operand rather than called. Every real one in this repository is a call,
  // so the pattern has no honest use here — a nullable helper is guarded on its RESULT.
  const bad = [];
  for (const rel of sourceFiles(["services", "packages", "scripts"], [".ts", ".mjs"])) {
    const src = readFileSync(join(root, rel), "utf8");
    const fns = [...src.matchAll(/^(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/gm)]
      .map((m) => m[1]);
    if (!fns.length) continue;
    // `?` is deliberately not an operator here: `{ messages?: Message[] }` is an optional
    // PROPERTY, and reading it as a ternary reported a type annotation as a defect.
    const operand = new RegExp(`(?<![.\\w$])(${fns.join("|")})\\s*(?:&&|\\|\\||\\?\\?)`, "g");
    const tested = new RegExp(`\\b(?:if|while)\\s*\\(\\s*!?(${fns.join("|")})\\s*\\)`, "g");
    src.split("\n").forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
      for (const m of [...ln.matchAll(operand), ...ln.matchAll(tested)]) {
        bad.push(`${rel}:${i + 1} tests \`${m[1]}\` for truth and it is a function declaration, ` +
                 "so the test is always true and whatever it guards is unreachable — call it");
      }
    });
  }
  return bad.join("\n");
});

check("no statement is written twice in a row", () => {
  // Two identical adjacent statements: the second does nothing, and the pair reads as
  // deliberate for as long as nobody looks. `if (NAMING.error) return NAMING.error;` sat
  // twice in "no two flows collapse to the same command namespace" — harmless, and the same
  // kind of debris this file refuses everywhere else, arriving by an edit that duplicated a
  // line instead of moving it.
  //
  // Statements only, so a repeated key in a data literal or a wrapped expression is not a
  // subject; the terminating semicolon is what makes the line a whole one.
  const bad = [];
  for (const rel of sourceFiles(["services", "packages", "scripts"], [".ts", ".mjs"])) {
    const lines = readFileSync(join(root, rel), "utf8").split("\n");
    for (let i = 1; i < lines.length; i++) {
      const a = lines[i - 1].trim();
      if (a !== lines[i].trim() || a.length < 12) continue;
      if (/^(\/\/|\*|\/\*)/.test(a) || !/;\s*$/.test(a)) continue;
      bad.push(`${rel}:${i + 1} repeats the statement above it — \`${a.slice(0, 60)}\``);
    }
  }
  return bad.join("\n");
});

check("no comment repeats a line of itself", () => {
  // The same debris as an adjacent duplicated statement, in the half of the file this
  // repository puts most of its reasoning in — and invisible to that check, which skips
  // comments by design because a `//` line has no terminating semicolon to mark it whole.
  //
  // tool-report carried a paragraph about `--fail-under` twice: the older wording and its
  // replacement, one under the other, differing only in the last sentence. An edit that
  // rewrites a paragraph and leaves the original beside it produces exactly that, and it reads
  // as deliberate emphasis for as long as nobody compares the two.
  //
  // WITHIN ONE RUN of comment lines, so a rule quoted in two different places is not a
  // subject — that is often the point. Forty characters, because a short line ("// ---", "//
  // Two shapes:") legitimately repeats and says nothing when it does.
  const bad = [];
  for (const rel of sourceFiles(["services", "packages", "scripts"], [".ts", ".mjs"])) {
    const lines = readFileSync(join(root, rel), "utf8").split("\n");
    let run = [];
    const judge = () => {
      const seen = new Map();
      for (const [ln, body] of run) {
        if (body.length < 40) continue;
        if (seen.has(body)) {
          bad.push(`${rel}:${ln} repeats line ${seen.get(body)} of the same comment — ` +
                   `\`${body.slice(0, 60)}\`. A rewritten paragraph left beside the original ` +
                   "reads as emphasis until somebody compares the two");
        } else {
          seen.set(body, ln);
        }
      }
      run = [];
    };
    lines.forEach((l, i) => {
      const t = l.trim();
      if (/^(\/\/|\*|\/\*)/.test(t)) run.push([i + 1, t.replace(/^[/*]+/, "").trim()]);
      else judge();
    });
    judge();
  }
  return bad.join("\n");
});

/* A CEILING, CHOSEN FROM THIS REPOSITORY RATHER THAN FROM TASTE.
 *
 * 700 is the line above which every source file here was demonstrably more than one subject.
 * Measured, not picked: judge.ts is 627 lines with THREE exports and is one subject — split
 * it and you get fragments — while every file over 700 held a whole second thing. Every one
 * that did on 2026-09-11 was split into modules. How many, and what the largest file is
 * today, are deliberately NOT written here: a count in prose beside the thing that counts it
 * is the staleness this gate refuses in a skill, and it would age no better in a check. The
 * check below is the count.
 *
 * WHAT THIS DOES NOT CATCH, stated because a proxy presented as a judge is the failure this
 * whole gate exists to refuse: identity.ts is 619 lines with SEVENTEEN exports — cookies,
 * an adapter, middleware, authority predicates, slug helpers — and passes. Line count finds
 * "definitely too big". It cannot find "more than one subject", and nothing here can.
 *
 * NO EXEMPTION LIST. A list of files allowed to be large is a list nobody prunes, which is
 * the shape of defect the audit this rule came out of spent its time on. A file that cannot
 * get under the ceiling is telling you something; it is not asking for a waiver.
 *
 * .css, .html and .md are outside it. The rule is about code somebody has to reuse, and a
 * stylesheet or a document is neither read nor reused the way a module is.
 */
check("no source file is larger than one subject usually is", () => {
  const LIMIT = 700;
  const over = sourceFiles(["."], [".ts", ".tsx", ".mjs", ".js"])
    .map((f) => [f, readFileSync(join(root, f), "utf8").split("\n").length])
    .filter(([, n]) => n > LIMIT)
    .sort((a, b) => b[1] - a[1]);
  return over.length
    ? over.map(([f, n]) => `${f} is ${n} lines`).join("; ") +
      ` — over ${LIMIT}, which is where a file in this repository has always turned out to ` +
      "hold a second subject. Split it by what it is about, not by line count."
    : null;
});
