/**
 * One implementation per rule, and code that says what it does.
 *
 * Nothing exported that nobody imports, no statement written twice in a row, no comment
 * repeating itself, no doc comment attached to nothing, no protocol spelled out in two
 * places.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { firstOf, functionBody, gateOwnSource, gatewaySource, root, sourceFiles, unbuilt, withoutComments, zzCoreSource } from "../read.ts";
import { check, note } from "../run.ts";
import { catalogRoot } from "../facts.ts";

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. `unknown?.message` narrows to `{}`, which has no properties at all. */
function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(err);
}

check("an async guard in a ?? chain is awaited", () => {
  // A promise is never null, so `a() ?? b()` where b is async ends the chain at b and
  // everything after b is unreachable: the outer await resolves b's promise and every write
  // past that point passes unguarded.
  //
  // DELIBERATE: narrow. Only the `??` chains that decide a refusal — an async function
  // declared in the file, named unawaited on a `??` line.
  const bad: string[] = [];
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
  // tsc does not report a symbol that is exported and imported nowhere: an export is a
  // legitimate public surface as far as the compiler is concerned. In a repo with no external
  // consumers it is dead code with a door on it.
  //
  // Consumers live under checks/ and testing/ too — a gate check is often the only tracked
  // caller of a helper whose production use is internal to the file defining it.
  const sources = [];
  sources.push(...sourceFiles(["services", "packages"], [".ts"])
    .filter((f) => !f.endsWith(".d.ts")).map((f) => join(root, f)));
  // Comments stripped, or this file's own prose keeps symbols alive: the gate names nearly
  // every export in the repository and is itself one of the consumers scanned.
  //
  // String literals stay. A check reaching a symbol by name — `functionBody(src, "someExport")`
  // — is a real coupling, so a literal naming a symbol counts as a use; a sentence does not.
  const text = new Map(sources.map((p) => [p, withoutComments(readFileSync(p, "utf8"))]));
  // The gate is a consumer too: a symbol exported so a check can exercise it is used. These
  // trees are kept out of `sources`, so nothing here is judged for its own exports.
  //
  // The walk is recursive — scripts/probes/ holds consumers a flat readdir never sees.
  // The declared schema target is a consumer as well: it types itself with the shared shape.
  for (const f of [...sourceFiles(["scripts", "checks", "testing", "schema-target"], [".ts"]), "schema-target.ts"]) {
    text.set(join(root, f), withoutComments(readFileSync(join(root, f), "utf8")));
  }

  // The console is a sibling checkout with its own build, so this walks its tree directly:
  // sourceFiles() answers only for what this repo's git tracks. Its conventions:
  //   · app/ holds Next.js routes, whose `default`, `metadata` and friends are consumed by the
  //     framework rather than by an import. Judging them dead deletes every page.
  //   · components/ui/index.ts is a barrel of `export * from './x'`, which names no symbol —
  //     so a file it re-exports is reachable through it, and the barrel's own re-exports are
  //     not exports to judge.
  //   · tests/ are consumers.
  const dash = join(root, "..", "zz-stack-dashboard");
  const dashFiles: string[] = [];
  if (existsSync(dash)) {
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith(".") || ["node_modules", ".next", "dist"].includes(e.name)) continue;
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name)) dashFiles.push(full);
      }
    };
    walk(dash);
  } else {
    // Skipping the sibling silently would let this check call an export dead while the
    // console is one of the things that could have named it.
    note("    unimported exports: ../zz-stack-dashboard is not checked out beside this " +
         "repository, so console imports did not count towards reachability here.");
  }
  const dashText = new Map(dashFiles.map((p) => [p, withoutComments(readFileSync(p, "utf8"))]));
  const bad: string[] = [];
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
  // Next's root entry points, which the framework loads by filename and never imports; the
  // `app/` exemption above misses them because they do not live under `app/`. Keyed by
  // filename and matched against the exact symbol Next looks for, so an unused helper
  // exported from the same file is still caught.
  const NEXT_ENTRY: Record<string, RegExp> = {
    "middleware.ts": /^(middleware|config)$/,
    "instrumentation.ts": /^(register|onRequestError)$/,
  };
  for (const [file, src] of dashText) {
    const rel = file.slice(dash.length + 1);
    if (rel.startsWith("tests/") || /(^|\/)index\.tsx?$/.test(rel)) continue;
    const isRoute = rel.startsWith("app/");
    // Reachable through the ui barrel: the barrel names the module, never the symbols.
    const viaBarrel = [...dashText].some(([b, bs]) =>
      /(^|\/)index\.tsx?$/.test(b.slice(dash.length + 1))
      && new RegExp(`from\\s+["']\\./${(rel.split("/").pop() ?? "").replace(/\.tsx?$/, "")}["']`).test(bs));
    for (const m of src.matchAll(EXPORTED)) {
      const name = m[1];
      if (isRoute && FRAMEWORK.test(name)) continue;
      if (NEXT_ENTRY[rel]?.test(name)) continue;
      if (viaBarrel) continue;
      const used = [...dashText].some(([other, otherSrc]) =>
        other !== file && new RegExp(`\\b${name}\\b`).test(otherSrc));
      if (!used) bad.push(`zz-stack-dashboard/${rel}: exports ${name}, imported by nothing`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("the MCP protocol is written once", () => {
  // Two things must not be duplicated: the protocol version, one string wherever a handshake
  // is built, and the reading of a streamable-HTTP answer, where taking the first `data:`
  // frame returns a progress notification and calls it the answer.
  //
  // A file that does neither is not a second client, however much of the protocol it
  // mentions: services/gateway compares a request's method against "initialize" to tell a
  // handshake from a tool call, where a client builds one.
  //
  // DELIBERATE: release.ts builds a handshake of its own — its probes assert a status code
  // over real HTTPS with curl — but reads the version from the client's source.
  const VERSION_LITERAL = /protocolVersion"?\s*:\s*"\d{4}-\d{2}-\d{2}"/;
  const BUILDS = /method:\s*"initialize"/;
  const READS_SSE = /(^|[^.\w])data:\s/;
  const bad: string[] = [];
  for (const f of sourceFiles(["."], [".ts"])) {
    if (f === join("packages", "mcp-client", "src", "index.ts")) continue;   // the one place it is written
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
  // stranded and the compiler is happy, so it survives every build. They arrive by insertion,
  // when a declaration goes in between a comment and the thing it described.
  //
  // Only `/**` blocks. A `/* Section */` band is a heading and is meant to sit above
  // the first thing under it.
  const bad: string[] = [];
  for (const f of sourceFiles(["."], [".ts"])) {
    const lines = readFileSync(join(root, f), "utf8").split("\n");
    let openedAsDoc = false, closedAt = -2;
    for (const [i, line] of lines.entries()) {
      if (/^\s*\/\*\*/.test(line)) {
        // A doc comment starting on the line right after one closed is the stranded case.
        if (i === closedAt + 1) bad.push(`${f}:${closedAt + 1} documents nothing`);
        openedAsDoc = true;
      } else if (/^\s*\/\*/.test(line)) {
        // A plain block comment right after a doc comment strands it just as surely: the
        // declaration takes whichever comment sits immediately above it.
        if (i === closedAt + 1) bad.push(`${f}:${closedAt + 1} documents nothing`);
        openedAsDoc = false;
      }
      if (/\*\/\s*$/.test(line) && openedAsDoc) { closedAt = i; openedAsDoc = false; }
    }
    // The second shape: a block separated from its symbol by a blank line. The gap means
    // either the symbol it described is gone or somebody put something between them.
    //
    // DELIBERATE: a file header is the one exception — it documents the module, so the blank
    // line before the imports is right.
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
  // Every cell of a markdown row has to be escaped, or an initiative folder named `a|b` —
  // which safePath permits — produces a row a parser reads as two cells. tableRow escapes
  // every cell; this refuses a table that assembles its own.
  //
  // COUPLED: tableRow lives in zz-core's document-rules.ts. The match is against the whole
  // service's source rather than one file, and accepts it with or without `export`.
  const f = "zz-core";
  const src = withoutComments(zzCoreSource());
  if (!/(export )?const tableRow = /.test(src)) return `${f}: tableRow is gone — the one row builder with it`;
  const bad: string[] = [];
  const lines = src.split("\n");
  lines.forEach((ln, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
    // DELIBERATE: tableRow may assemble one — that is what it is for. Exempted by what it
    // is rather than by line number.
    if (/const tableRow = /.test(lines[i - 1] ?? "") || /const tableRow = /.test(ln)) return;
    // A template literal that opens a markdown row and interpolates something.
    if (/`\|\s+\$\{/.test(ln)) bad.push(`${f}:${i + 1} assembles a table row instead of calling tableRow`);
  });
  return bad.length
    ? `${firstOf(bad)} — every cell has to be escaped, and one place escaping them is how that stays true`
    : null;
});

check("a plugin is named the same way wherever it is named", () => {
  // A flow named `sdlc-flow` ships as the plugin `sdlc`: pluginName drops the trailing -flow,
  // and the marketplace, the install line, the update line and the command namespace all take
  // the plugin name, never the flow name.
  const bad: string[] = [];
  for (const f of sourceFiles(["services/gateway/src"], [".ts"])) {
    readFileSync(join(root, f), "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/\$\{[^}]*\.flow\}@(\$\{MARKETPLACE\}|zz-stack)/.test(line)) {
        bad.push(`${f}:${i + 1} names a plugin by its flow — use pluginName()`);
      }
    });
  }
  return bad.length ? bad.join("; ") : null;
});

check("the audit criteria are written once", () => {
  // The generic half of both auditors — the eleven prose failure modes, the evidence shapes,
  // the JSON a round returns — lives in sdlc-audit-criteria, and each auditor loads it rather
  // than restating it.
  //
  // DELIBERATE: two auditors, not one. A spec and a plan fail in different ways.
  const dir = join(catalogRoot, "sdlc/sdlc-flow/skills");
  const shared = join(dir, "sdlc-audit-criteria/SKILL.md");
  if (!existsSync(shared)) return "sdlc-audit-criteria is missing — the shared criteria have nowhere to live";
  const bad: string[] = [];
  const texts: Record<string, string> = {};
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

// A source file with a control byte in it is a file every grep skips: grep reports
// "Binary file ... matches" and prints nothing, so a sweep over the repository misses the
// file whole. Written as the escape \u0000 instead, the behaviour is identical and the byte
// is readable.
check("every source file is text a search can read", () => {
  const bad: string[] = [];
  const exts = [".ts", ".js", ".md", ".json", ".sql", ".yml", ".yaml", ".sh"];
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
  // Cases run against a stub server: no gateway and no network. The engine prints how many
  // on every run, so the count is not repeated here.
  try {
    execFileSync("node", [join(root, "packages/tools/dist/testing/mcp-client-check.js")],
                 { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const e = err && typeof err === "object" ? err as Record<string, unknown> : {};
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    return out.split("\n").filter((l) => /FAIL/.test(l)).join("; ") || "mcp client check failed";
  }
});

check("imports run node, then packages, then this directory", () => {
  // DELIBERATE: groups only. Within a group this repository does not sort, so asserting an
  // alphabetical order would report files as broken against a convention nobody adopted.
  const rank = (spec: string): number => (spec.startsWith("node:") ? 0 : spec.startsWith(".") ? 2 : 1);
  const findings = [];
  for (const rel of [...sourceFiles(["packages", "services"], [".ts"]),
                     ...sourceFiles(["scripts"], [".ts"])]) {
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
  // parseArgs stores "" for a flag written with nothing after it — it will not swallow the
  // next flag as a value — and `flags.get(name) ?? null` hands that "" through, because "" is
  // not nullish. A caller testing it with `if (value)` then skips the filter in silence, and
  // a flag that narrows a query still answers, about everything.
  const bad: string[] = [];

  const cli = readFileSync(join(root, "packages/tools/src/lib/cli.ts"), "utf8");
  const body = functionBody(cli, "optional");
  if (!body) return "packages/tools no longer defines optional() — this check cannot run";
  let read: Function;
  try {
    // `die` injected, because the real one exits the process. What is under test is which
    // inputs reach it.
    read = new Function("die", "args", "name", "what", body).bind(
      null, (m: string): never => { throw new Error(m); });
  } catch (err) {
    return `optional() could not be evaluated: ${errMessage(err)}`;
  }
  const withFlags = (pairs: [string, string][]) => ({ flags: new Map(pairs) });
  const call = (pairs: [string, string][], name: string) => {
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

  // Two ways to read a flag and no third: a real default, written `flags.get(x) || fallback`,
  // or none, in which case it goes through optional(), which refuses a flag given with nothing
  // after it. `?? null`, `?? ""` and a bare `get` all read "" as absent, so the check is
  // stated as a shape rather than a list of those spellings.
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
  // A `function name(…)` declared in the file and used as a bare truthiness operand rather
  // than called: the guard tests the declaration, which is always truthy, so the fallback it
  // protects is unreachable. A nullable helper is guarded on its result instead.
  const bad: string[] = [];
  for (const rel of sourceFiles(["services", "packages", "scripts"], [".ts"])) {
    const src = readFileSync(join(root, rel), "utf8");
    const fns = [...src.matchAll(/^(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/gm)]
      .map((m) => m[1]);
    if (!fns.length) continue;
    // `?` is deliberately not an operator here: `{ messages?: Message[] }` is an optional
    // property, and reading it as a ternary reports a type annotation as a defect.
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
  // deliberate for as long as nobody looks.
  //
  // DELIBERATE: statements only. The terminating semicolon is what makes the line a whole one,
  // so a repeated key in a data literal or a wrapped expression is not a subject.
  const bad: string[] = [];
  for (const rel of sourceFiles(["services", "packages", "scripts"], [".ts"])) {
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
  // The same debris as an adjacent duplicated statement, in comments: a rewritten paragraph
  // left beside the original reads as emphasis until somebody compares the two. The statement
  // check cannot see it, because a `//` line has no terminating semicolon.
  //
  // DELIBERATE: within one run of comment lines, so a rule quoted in two different places is
  // not a subject. Short lines are exempt — they legitimately repeat.
  const bad: string[] = [];
  for (const rel of sourceFiles(["services", "packages", "scripts"], [".ts"])) {
    const lines = readFileSync(join(root, rel), "utf8").split("\n");
    let run: [number, string][] = [];
    const judge = () => {
      const seen = new Map<string, number>();
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

/* A ceiling on file size.
 *
 * Line count finds "definitely too big"; it cannot find "more than one subject", and nothing
 * here can.
 *
 * DELIBERATE: no exemption list. A file that cannot get under the ceiling is telling you
 * something; it is not asking for a waiver.
 *
 * .css, .html and .md are outside it — a stylesheet or a document is not reused the way a
 * module is.
 */
check("no source file is larger than one subject usually is", () => {
  const LIMIT = 700;
  const over = sourceFiles(["."], [".ts", ".tsx", ".js"])
    .map((f): [string, number] => [f, readFileSync(join(root, f), "utf8").split("\n").length])
    .filter(([, n]) => n > LIMIT)
    .sort((a, b) => b[1] - a[1]);
  return over.length
    ? over.map(([f, n]) => `${f} is ${n} lines`).join("; ") +
      ` — over ${LIMIT}, which is where a file in this repository has always turned out to ` +
      "hold a second subject. Split it by what it is about, not by line count."
    : null;
});
