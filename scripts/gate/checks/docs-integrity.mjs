/**
 * The documents this repository is answerable for: that they are discovered rather than
 * listed, dated, and pointing at things that exist.
 *
 * DISCOVERED, never enumerated — a hardcoded set stops covering the document somebody adds
 * tomorrow, which is the exact failure this step exists to prevent arriving through the
 * check meant to prevent it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { between, gateCheckNames, gateOwnSource, root, sourceFiles, trackedFiles } from "../read.mjs";
import { check, note } from "../run.mjs";
import { flows, ourDocs } from "../facts.mjs";

check("the README's map names every package, flow and script, and no others", () => {
  // The release command makes this map a release obligation — "a flow added or removed, a
  // scripts/ entry that is gone" — and nothing checked it, so it drifted on every axis at
  // once: packages/catalog missing, the entire sdlc flow and its 16 skills missing, zz-access
  // and zz-admin missing, and add-block.py still listed after it was deleted. A map that is
  // wrong in both directions is worse than none: it tells a newcomer a flow does not exist
  // and sends them to a script that does not.
  const readme = readFileSync(join(root, "README.md"), "utf8");
  // The map is the fenced block. Everything below reads THAT, not the prose around it.
  // THE MAP FENCE, not merely the FIRST fence. This took `match` on the first code block,
  // which quietly assumed the map is the first thing in the README — so adding a quickstart
  // above it made this check read `npm install && npm run gate` as the directory tree and
  // report every package as missing. The map is the fence that names the packages; find it
  // by what it contains rather than by where it sits.
  const fenceOf = (md) => (md.match(/```[a-z]*\n([\s\S]*?)```/g) ?? [])
    .map((b) => b.replace(/^```[a-z]*\n/, "").replace(/```$/, ""))
    .find((b) => /^packages\//m.test(b)) ?? "";
  const bad = [];

  // A package is a directory with a package.json, exactly as the catalog loop below asks for
  // a flow.json. This read every directory ENTRY, so a stray file in packages/ was demanded
  // of the README as if it were a package — and macOS drops .DS_Store into any directory the
  // Finder or a tool has touched. The gate then failed over a file .gitignore already
  // excludes and git has never tracked, which is the worst kind of gate failure: it is not
  // wrong about the repository, it is wrong about what counts as part of it, and a check
  // that cries wolf teaches people to stop reading it.
  for (const p of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!p.isDirectory() || !existsSync(join(root, "packages", p.name, "package.json"))) continue;
    if (!fenceOf(readme).includes(`packages/${p.name}/`)) bad.push(`packages/${p.name} is not in the map`);
  }
  for (const f of flows) {
    if (!fenceOf(readme).includes(`${f.owner}/${f.flow}`)) {
      bad.push(`catalog/${f.owner}/${f.flow} is not in the map`);
    }
  }

  // Searched inside the map's `scripts/` paragraph, not the whole README.
  //
  // `readme.includes(stem)` was a substring match over the entire file, and manifests.mjs
  // passed it on the word "manifests" in the sentence describing packages/catalog — a file
  // absent from the map, reported as present, by prose two dozen lines above it. The fourth
  // check in this file to be fooled by prose it was never meant to read.
  const fence = fenceOf(readme);
  const scriptsPara = fence.slice(fence.indexOf("\nscripts/") + 1);
  // What the repository counts as part of itself, which is the same question the packages
  // loop above answers with `package.json` — a raw readdir here demanded `.DS_Store` of the
  // README, in the one check whose own comment calls that "the worst kind of gate failure".
  const belongs = trackedFiles();
  for (const s of readdirSync(join(root, "scripts"))) {
    if (belongs && !belongs.has(`scripts/${s}`) && ![...belongs].some((f) => f.startsWith(`scripts/${s}/`))) continue;
    const stem = s.replace(/\.(py|mjs)$/, "");
    if (!new RegExp(`\\b${stem}\\b`).test(scriptsPara)) bad.push(`scripts/${s} is not in the map`);
  }
  // And the other direction: a file the map names must still exist SOMEWHERE. Not
  // necessarily in scripts/ — the map also names each flow's tests/scenarios.json, and
  // assuming otherwise made this check report a file that was right where it belonged.
  const everywhere = new Set();
  for (const f of sourceFiles(["scripts", "testing", "catalog", "deploy", "services", "packages"], [""])) {
    everywhere.add(f.split("/").pop());
  }
  for (const m of readme.matchAll(/\b([a-z][a-z0-9-]*\.(?:py|mjs))\b/g)) {
    if (!everywhere.has(m[1])) bad.push(`the map names ${m[1]}, which no longer exists`);
  }
  // AND THE SAME QUESTION FOR DIRECTORIES, which is the half this check asserted and did not
  // ask. Its name has always ended "and no others", but the reverse pass above matches only
  // `*.py|*.mjs` FILENAMES — so the map could name four catalog packages and a blocks/
  // subdirectory that had all been removed, and this check stayed green while saying in its
  // own title that it would not. It did: `ops/ops-flow`, `zz/zz-flow-builder`,
  // `catalog/casebox/casebox-assist` and `blocks/casebox/` were all advertised to a reader
  // and none of them existed.
  //
  // A check that claims more than it tests is worse than no check, because the claim is what
  // people rely on. Read of the fence only: the prose around the map talks about things that
  // are deliberately elsewhere.
  for (const m of fence.matchAll(/(?:^|\s)((?:catalog|blocks)\/[a-z0-9][a-z0-9._/-]*)/g)) {
    const rel = m[1].replace(/[.,;]$/, "").replace(/\/$/, "");
    if (!existsSync(join(root, rel))) bad.push(`the map names ${rel}/, which does not exist`);
  }
  // A catalog package written as `<owner>/<name>` with no `catalog/` prefix, which is how the
  // map lists the shelf.
  for (const m of fence.matchAll(/^\s{8,}([a-z][a-z0-9-]*\/[a-z][a-z0-9-]*)\s{2,}\S/gm)) {
    if (!existsSync(join(root, "catalog", m[1]))) {
      bad.push(`the map names catalog/${m[1]}, which does not exist`);
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("every document ours to keep is discovered and dated", () => {
  const docs = ourDocs();
  if (docs.length === 0) return "found no documents at all — the discovery is broken";
  note(`      ${docs.length} documents: ${docs.join(", ")}`);

  // Held to a date stamp: STATE.md. It is what someone OUTSIDE this repo reads to answer
  // "which version of this am I holding", so that has to be answerable from the file itself.
  //
  // STATE.md sits beside CHANGELOG.md on purpose — one is the balance, the other the
  // transaction log, and a reader should meet them together rather than find one at the root
  // and the other three directories down. It used to be docs/release/direction.md and read
  // as neither: a document describing where you are GOING has no obligation to be accurate
  // about where you are, which is how it drifted. That directory is gone; the rule it earned
  // is not, and it applies to whatever is held to a stamp next.
  const stamped_ = (x) => x === "STATE.md";
  const bad = [];
  for (const d of docs.filter(stamped_)) {
    const txt = readFileSync(join(root, d), "utf8");
    if (!/\b\d{4}-\d{2}-\d{2}\b/.test(txt.slice(0, 1200))) bad.push(`${d}: no YYYY-MM-DD near the top`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("no document is older than the code it describes", () => {
  const notes = [];
  for (const d of ourDocs().filter((x) => x === "STATE.md")) {
    const txt = readFileSync(join(root, d), "utf8");
    const stamped = /\b(\d{4}-\d{2}-\d{2})\b/.exec(txt.slice(0, 1200))?.[1];
    if (!stamped) continue;
    const since = execFileSync("git", [
      "log", "--oneline", `--since=${stamped}`, "--", "services", "catalog", "packages", "deploy",
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n").filter(Boolean);
    if (since.length) notes.push(`${d} stamped ${stamped}, ${since.length} commit(s) since`);
  }
  // A warning, not a failure. A direction document is allowed to be steady while code
  // moves beneath it, and failing here would train people to bump a date instead of
  // reading — which is worse than a stale date, because it converts "probably out of
  // date" into "recently confirmed" while confirming nothing.
  if (notes.length) {
    console.log(`      note: ${notes.join("; ")}`);
    console.log("      → read them during the release; bump a stamp only if the content changed");
  }
  return null;
});

// sourceFiles RETURNS REPO-RELATIVE PATHS, and reading one without join(root, …) reads
// whatever sits at that path relative to the working directory. From the repo root that is
// the same file, so it works — until somebody runs the gate from anywhere else, and then a
// check reads nothing, finds nothing, and reports a pass. This file did exactly that for the
// length of one commit: the vocabulary check read `f` directly and reported its findings
// against an empty filename, which is the visible half of the same mistake.
//
// A check that silently examines no files is the worst failure this gate has, because it is
// indistinguishable from a clean repository.
check("the gate reads the files it says it reads", () => {
  // EVERY MODULE, not the entry file. The checks moved into gate/checks/ on 2026-09-11 and
  // gate.mjs became sixty-seven lines of imports — so this check went on reading one file,
  // found no `for (const … of sourceFiles(` in it, and passed. It was the paragraph above
  // this one, happening to the check that wrote it, within the same commit.
  const bad = [];
  for (const rel of [...sourceFiles(["scripts/gate/checks"], [".mjs"]), "scripts/gate/facts.mjs"]) {
  const lines = readFileSync(join(root, rel), "utf8").split("\n");
  lines.forEach((line, i) => {
    const m = /for \(const (\w+) of sourceFiles\(/.exec(line);
    if (!m) return;
    const v = m[1];
    // The loop body: to the line that closes it.
    let depth = 0;
    for (let j = i; j < lines.length; j++) {
      depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length;
      const bare = new RegExp(`(readFileSync|readdirSync|existsSync|statSync)\\(\\s*${v}\\s*[,)]`);
      if (bare.test(lines[j])) {
        bad.push(`${rel}:${j + 1} reads \`${v}\` without join(root, …) — sourceFiles ` +
                 "returns repo-relative paths, so this reads relative to the working directory");
      }
      // THE OTHER HALF OF THE SAME MISTAKE, and the half that is invisible. Treating the
      // path as absolute in order to shorten it — `rel.slice(root.length + 1)` — cuts more
      // characters than the string has, so the finding is reported against an EMPTY
      // filename. "a report counting an activity counts the ones that happened" did exactly
      // that, and a reader of its failure would have been given a line number and no file.
      const shortened = new RegExp(`\\b${v}\\.slice\\(\\s*root\\.length`);
      if (shortened.test(lines[j])) {
        bad.push(`${rel}:${j + 1} slices root's length off \`${v}\`, which is already ` +
                 "repo-relative — the finding is reported against an empty filename");
      }
      if (j > i && depth === 0) break;
    }
  });
  }
  if (!bad.length && !sourceFiles(["scripts/gate/checks"], [".mjs"]).length) {
    return "no gate modules found — this cannot verify anything";
  }
  return bad.join("\n");
});

check("what someone says about a document has one home", () => {
  // A comment and a source were the same thing under two names — somebody's words about a
  // document, arriving from outside the flow — and they cost differently. A source bumps the
  // document to the next version, is named in the envelope, and is frozen into _versions/
  // with the approval it changed. A comment did none of that. So whether "B says this
  // requirement is wrong" entered the record depended on which door B used, and the cheaper
  // door left no trace in the document's history.
  //
  // The affordance survived; the second record did not. A person still writes on a document
  // from the web, and it lands as a source through zz-core like every other write. This
  // refuses the concept's return: a comment tool, a comment table, or a comment endpoint.
  const bad = [];
  // Every source in the repository, plus the skills — the concept can come back as a tool, a
  // table, an endpoint, or as a sentence in a skill telling somebody to leave a comment.
  //
  // NOT the prose documents. CHANGELOG.md and STATE.md record the removal, which is what a
  // record is for, and docs/casebox-mcp-tools-reference.md describes a BLOCK's surface: CaseBox
  // CaseBox has its own add_comment and it is theirs to have. This is about what THIS platform
  // offers. Nor this file, which has to name the strings in order to look for them.
  const subjects = [...sourceFiles(["."], [".ts", ".mjs", ".html", ".sql"]),
                    ...sourceFiles(["catalog", "skills"], ["SKILL.md"])];
  for (const rel of subjects) {
    // The drop migration names the table it drops; that is the record of the removal.
    if (/012_drop_comment\.sql$|002_comments\.sql$/.test(rel)) continue;
    if (gateOwnSource(rel)) continue;
    for (const [i, line] of readFileSync(join(root, rel), "utf8").split("\n").entries()) {
      if (/^\s*(\/\/|\*|\/\*|--)/.test(line)) continue;   // comments explain the removal
      if (/\b(add_comment|list_comments|resolve_comment)\b/.test(line)
          || /zz\.comment\b/.test(line)
          || /["'`]\/api\/kb\/comments/.test(line)) {
        bad.push(`${rel}:${i + 1}`);
      }
    }
  }
  return bad.length
    ? `${bad.join(", ")} bring back a separate comment record — what someone says about a ` +
      "document is a source, so it versions the document and lands in the team's own store"
    : null;
});

check("the README describes the tree it ships with", () => {
  // The README is the first thing anyone reads and it is a map of directories, so every fact
  // in it goes stale by someone moving a file. All four of these had: it said sdlc ships 16
  // skills when splitting out sdlc-audit-criteria and sdlc-authoring made it 18; it named
  // three of the five under skills/, omitting zz-distil and zz-evolve — the two platform-team
  // capabilities this release added; it placed set-credential and probe-block in scripts/
  // after both moved into packages/tools/src/ops/; and it listed seven of the nine testing
  // engines, missing evolve-report and flow-compare.
  //
  // Nothing failed for any of them, which is the point: a map is not executed.
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const bad = [];
  const ls = (d) => existsSync(join(root, d)) ? readdirSync(join(root, d)) : [];

  // Skill counts the README states per flow, read from the flow's own ENTRY in the map and
  // bounded by the next one. The regex here required the count on the SAME LINE as the flow
  // path, which is true of both entries today and is a property of how the paragraph happens
  // to wrap — a count pushed onto the following line stops being checked and nothing says so.
  // The map fence, found by content — see the note on fenceOf above. A quickstart block
  // ahead of the map is allowed, and used to make this check read it as the tree.
  const fence = (readme.match(/```[a-z]*\n([\s\S]*?)```/g) ?? [])
    .map((b) => b.replace(/^```[a-z]*\n/, "").replace(/```$/, ""))
    .find((b) => /^packages\//m.test(b)) ?? "";
  const starts = flows
    .map((f) => ({ f, at: fence.indexOf(`${f.owner}/${f.flow}`) }))
    .filter((e) => e.at >= 0).sort((a, b) => a.at - b.at);
  starts.forEach(({ f, at }, i) => {
    const entry = fence.slice(at, i + 1 < starts.length ? starts[i + 1].at : at + 400);
    const said = /(\d+)\s+skills\b/.exec(entry);
    if (!said) return;                 // an entry stating no count cannot be wrong about one
    const have = ls(join("catalog", f.owner, f.flow, "skills")).length;
    if (Number(said[1]) !== have) {
      bad.push(`README says ${f.owner}/${f.flow} has ${said[1]} skills and it ships ${have}`);
    }
  });

  // Every directory under skills/ is named in the README — and nothing the README names is
  // gone. One direction told a reader a skill did not exist; the other sends them looking for
  // a file that does not. The paragraph is bounded so a name mentioned in the prose elsewhere
  // cannot answer for the map.
  const skillsPara = (() => {
    const from = fence.indexOf("\nskills/");
    if (from < 0) return "";
    const rest = fence.slice(from + 1);
    const stop = rest.search(/\n[a-z]/);
    return stop > 0 ? rest.slice(0, stop) : rest;
  })();
  const onDisk = ls("skills").filter((n) => existsSync(join(root, "skills", n, "SKILL.md")));
  for (const name of onDisk) {
    if (!skillsPara.includes(name)) bad.push(`skills/${name} ships and the README never names it`);
  }
  for (const m of skillsPara.matchAll(/\b(zz-[a-z-]+|casebox-[a-z-]+)\b/g)) {
    if (!onDisk.includes(m[1])) bad.push(`the README names skills/${m[1]}, which does not exist`);
  }
  // Every engine and ops tool, likewise — a tool nobody can find is one nobody runs.
  for (const [dir, what] of [["packages/tools/src/testing", "engine"], ["packages/tools/src/ops", "ops tool"]]) {
    for (const f of ls(dir)) {
      if (!f.endsWith(".ts")) continue;
      const name = f.replace(/\.ts$/, "");
      if (!readme.includes(name)) bad.push(`${what} ${name} ships and the README never names it`);
    }
  }
  // AND THE CHECKS THAT LIVE BESIDE THE CODE THEY ARE ABOUT. Not every offline check is under
  // packages/tools: markdown-check and identity-check sit in services/gateway/src, because
  // each runs the real function it is about rather than a copy of its rules. This walked the
  // two tool directories alone, so identity-check was added, wired into an npm script and run
  // by the gate — and the map a newcomer reads never mentioned it. A check nobody can find is
  // the same as a tool nobody can find, and it is worse here: it is the evidence that an
  // authentication property is tested at all.
  for (const svc of ls("services")) {
    for (const f of ls(join("services", svc, "src"))) {
      if (!/-check\.ts$/.test(f)) continue;
      const name = f.replace(/\.ts$/, "");
      if (!readme.includes(name)) {
        bad.push(`services/${svc}/src/${f} is an offline check and the README never names it`);
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a gate check cited elsewhere is cited by a name that exists", () => {
  // Nine places cited a check BY NUMBER — STATE.md, six changelog entries and three comments
  // in this file. The numbering is positional, so every check added above a citation moves it,
  // and five of the nine already pointed at the wrong check: the citation for the asymmetric
  // fork resolved to "the platform model is one name", and the changelog used one number twice
  // for two different checks, which is the drift itself, in one file.
  //
  // Names are stable and greppable, so citations are names now. This holds them: a quoted
  // "..." that reads like a check name must BE one, and a numeric citation is refused outright
  // because it cannot be verified and will rot the next time a check is inserted.
  const names = new Set(gateCheckNames());
  if (!names.size) return "no checks found — this cannot verify anything";
  const files = ["STATE.md", "CHANGELOG.md", "README.md",
                 ...sourceFiles(["scripts/gate/checks"], [".mjs"]),
                 ...sourceFiles(["catalog", "skills", "docs"], [".md"])];
  const bad = [];
  for (const rel of files) {
    const f = join(root, rel);
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/\b(?:gate )?check \d+/gi)) {
      bad.push(`${rel} cites "${m[0]}" by number — cite the check's name, which does not move`);
    }
    // A quoted phrase introduced as a check must resolve to one. Whitespace is collapsed
    // because a name wraps across lines in prose, and in a comment carries the `//` with it.
    // `\b` before the word, because closeCheck, gateCheck and statusCheck are FUNCTIONS.
    // Without it, prose that ends a line with one and continues the sentence in the next
    // string — `"… closeCheck " +` — reads as a citation of whatever sits between the two
    // quotes, and this reported a check named "+".
    for (const m of text.matchAll(/(?:gate )?\bcheck\s+"([^"]{8,})"/gi)) {
      const cited = m[1].replace(/\n\s*(?:\/\/|\*)?\s*/g, " ").replace(/\s+/g, " ").trim();
      if (!names.has(cited)) bad.push(`${rel} cites a check named "${cited}" and no check has that name`);
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("a document's links point at something that exists", () => {
  // The README sends an installer to `deploy/README.md`, CONTRIBUTING.md points at
  // `ARCHITECTURE.md`, and STATE.md points at the building-block contract. Each is a file in this repository that somebody can move or
  // rename, and a link that 404s in a document a person reads while UPGRADING is worse than no
  // link — it reads as though the evidence exists somewhere they cannot find.
  //
  // Relative targets only. An external URL cannot be checked offline, and this gate has no
  // network by design.
  const bad = [];
  const docs = ["README.md", "STATE.md", "CHANGELOG.md", ...sourceFiles(["docs"], [".md"])];
  for (const rel of docs) {
    const f = join(root, rel);
    if (!existsSync(f)) continue;
    const dir = dirname(f);
    for (const m of readFileSync(f, "utf8").matchAll(/\[[^\]]*\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|javascript:)/.test(target)) continue;
      // Prose in the XSS entry contains `[**bold** link](…)` as an EXAMPLE, not a link.
      if (target.includes("…")) continue;
      if (!existsSync(resolve(dir, target))) bad.push(`${rel} links to ${target}, which does not exist`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("the standard names the requirements its own battery settles", () => {
  // §6 of the building-block contract replaced a hand-written table of met and unmet
  // requirements with a battery a block team runs themselves — because the table "was true
  // when someone looked, nothing re-checked it, and it read as current for as long as it sat
  // here". The sentence describing WHICH requirements the battery settles was then written by
  // hand, and drifted the same way: it listed eight, block-conformance measures nine, and R10
  // was missing from it while a paragraph two below cited R10 as something measurement found.
  //
  // This is the document handed to every block team. A requirement the standard says is not
  // measured is one nobody expects a verdict on, so the omission is a block shipping unchecked
  // against a check that runs.
  const doc = readFileSync(join(root, "blocks/_standard/skills/building-a-block/references/contract.md"), "utf8");
  const eng = readFileSync(join(root, "packages/tools/src/testing/block-conformance.ts"), "utf8");
  const bad = [];

  // The engine's own two sets. NOT_MEASURED is a named constant; everything the engine
  // assigns a verdict to is measured, whether it is written into the requirement object or
  // set afterwards — R6 is set afterwards, which a check reading only the object literal
  // would have missed.
  const notMeasured = new Set(
    [...(/const NOT_MEASURED[^{]*\{([\s\S]*?)^\}/m.exec(eng)?.[1] ?? "")
      .matchAll(/^\s*(R\d+):/gm)].map((m) => m[1]));
  const measured = new Set([...eng.matchAll(/^\s*(?:req\.)?(R\d+)\s*[:=]\s*\{/gm)]
    .map((m) => m[1]).filter((r) => !notMeasured.has(r)));
  if (!measured.size || !notMeasured.size) {
    return "block-conformance no longer states which requirements it measures — this check cannot run";
  }

  const sentence = /settles ((?:R\d+[,\s]+(?:and\s+)?)+R\d+) mechanically\.\s*((?:R\d+[,\s]+(?:and\s+)?)+R\d+) are behavioural/
    .exec(doc.replace(/\n/g, " "));
  if (!sentence) {
    return "§6 no longer says which requirements the battery settles and which it does not — " +
           "that sentence is what tells a block team where a verdict is coming from";
  }
  const ids = (t) => new Set([...t.matchAll(/R\d+/g)].map((m) => m[0]));
  const said = ids(sentence[1]), saidNot = ids(sentence[2]);

  for (const r of measured) {
    if (!said.has(r)) {
      bad.push(`block-conformance settles ${r} and the standard does not say so — a block team ` +
               "reading this expects no verdict on it");
    }
  }
  for (const r of said) {
    if (!measured.has(r)) bad.push(`the standard says the battery settles ${r}; it does not`);
  }
  for (const r of notMeasured) {
    if (!saidNot.has(r)) bad.push(`${r} is reported as not measured and the standard omits it`);
  }
  for (const r of saidNot) {
    if (!notMeasured.has(r)) bad.push(`the standard calls ${r} behavioural; the battery scores it`);
  }

  // And every requirement is in exactly one of the two, because the table above numbers them
  // R1..RN and a requirement in neither list is one nobody is told anything about.
  const all = new Set([...doc.matchAll(/^\| (R\d+) \|/gm)].map((m) => m[1]));
  for (const r of all) {
    if (!said.has(r) && !saidNot.has(r)) {
      bad.push(`${r} is a requirement in the table and appears in neither half of §6`);
    }
  }
  if (all.size && all.size !== measured.size + notMeasured.size) {
    bad.push(`the table has ${all.size} requirements and the battery accounts for ` +
             `${measured.size + notMeasured.size}`);
  }
  return bad.length ? bad.join("; ") : null;
});
