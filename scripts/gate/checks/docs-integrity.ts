/**
 * The documents this repository is answerable for: that they are discovered rather than
 * listed, dated, and pointing at things that exist.
 *
 * Discovered, never enumerated: a hardcoded set stops covering the document somebody adds
 * tomorrow.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { gateCheckNames, gateOwnSource, root, sourceFiles, trackedFiles } from "../read.ts";
import { check, note } from "../run.ts";
import { flows, ourDocs, toolEntryPoints } from "../facts.ts";

check("the README's map names every package, flow and script, and no others", () => {
  // The release command makes this map a release obligation, and it is checked both ways: a
  // name missing tells a newcomer a flow does not exist, a name left behind sends them to a
  // script that does not.
  const readme = readFileSync(join(root, "README.md"), "utf8");
  // The map is the fenced block, found by what it contains rather than by where it sits — a
  // quickstart fence above it would otherwise be read as the directory tree. Everything below
  // reads that fence, not the prose around it.
  const fenceOf = (md: string): string => (md.match(/```[a-z]*\n([\s\S]*?)```/g) ?? [])
    .map((b: string) => b.replace(/^```[a-z]*\n/, "").replace(/```$/, ""))
    .find((b) => /^packages\//m.test(b)) ?? "";
  const bad: string[] = [];

  // A package is a directory with a package.json, exactly as the catalog loop below asks for
  // a flow.json. A bare directory entry would demand a stray file such as .DS_Store of the
  // README.
  for (const p of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!p.isDirectory() || !existsSync(join(root, "packages", p.name, "package.json"))) continue;
    if (!fenceOf(readme).includes(`packages/${p.name}/`)) bad.push(`packages/${p.name} is not in the map`);
  }
  for (const f of flows) {
    if (!fenceOf(readme).includes(`${f.owner}/${f.flow}`)) {
      bad.push(`catalog/${f.owner}/${f.flow} is not in the map`);
    }
  }

  // Searched inside the map's `scripts/` paragraph, not the whole README: a substring match
  // over the file passes on prose that happens to contain the stem.
  const fence = fenceOf(readme);
  const scriptsPara = fence.slice(fence.indexOf("\nscripts/") + 1);
  // What the repository counts as part of itself — the same question the packages loop above
  // answers with `package.json`. A raw readdir here would demand `.DS_Store` of the README.
  const belongs = trackedFiles();
  for (const s of readdirSync(join(root, "scripts"))) {
    if (belongs && !belongs.has(`scripts/${s}`) && ![...belongs].some((f) => f.startsWith(`scripts/${s}/`))) continue;
    if (!new RegExp(`\\b${s}\\b`).test(scriptsPara)) bad.push(`scripts/${s} is not in the map`);
  }
  // And the other direction: a file the map names must still exist somewhere, not necessarily
  // in scripts/.
  const everywhere = new Set();
  for (const f of sourceFiles(["scripts", "testing", "catalog", "deploy", "services", "packages"], [""])) {
    everywhere.add(f.split("/").pop());
  }
  for (const m of readme.matchAll(/\b([a-z][a-z0-9-]*\.(?:ts|sh))\b/g)) {
    if (!everywhere.has(m[1])) bad.push(`the map names ${m[1]}, which no longer exists`);
  }
  // The same question for directories: the reverse pass above matches `*.ts|*.sh` filenames
  // only, so a removed catalog subdirectory would stay advertised. Read of the fence only,
  // because the prose around the map talks about things that are elsewhere.
  for (const m of fence.matchAll(/(?:^|\s)(catalog\/[a-z0-9][a-z0-9._/-]*)/g)) {
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

check("every document ours to keep is discovered", () => {
  const docs = ourDocs();
  if (docs.length === 0) return "found no documents at all — the discovery is broken";
  note(`      ${docs.length} documents: ${docs.join(", ")}`);

  // COUPLED: `/release` step 4 reads the `documents:` line printed above to account for every document in the
  // release.
  return null;
});

// sourceFiles returns repo-relative paths, and reading one without join(root, …) reads
// whatever sits at that path relative to the working directory. From the repo root that is
// the same file, so it works until somebody runs the gate from anywhere else — and then a
// check reads nothing, finds nothing, and reports a pass, which is indistinguishable from a
// clean repository.
check("the gate reads the files it says it reads", () => {
  // Every module under gate/checks/, not the entry file, which is only imports.
  const bad: string[] = [];
  for (const rel of [...sourceFiles(["scripts/gate/checks"], [".ts"]), "scripts/gate/facts.ts"]) {
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
      // The other half of the same mistake: treating the path as absolute in order to shorten
      // it — `rel.slice(root.length + 1)` — cuts more characters than the string has, so the
      // finding is reported against an empty filename.
      const shortened = new RegExp(`\\b${v}\\.slice\\(\\s*root\\.length`);
      if (shortened.test(lines[j])) {
        bad.push(`${rel}:${j + 1} slices root's length off \`${v}\`, which is already ` +
                 "repo-relative — the finding is reported against an empty filename");
      }
      if (j > i && depth === 0) break;
    }
  });
  }
  if (!bad.length && !sourceFiles(["scripts/gate/checks"], [".ts"]).length) {
    return "no gate modules found — this cannot verify anything";
  }
  return bad.join("\n");
});

check("what someone says about a document has one home", () => {
  // Somebody's words about a document are a source: it bumps the document to the next
  // version, is named in the envelope, and is frozen into _versions/ with the approval it
  // changed. This refuses a second, cheaper record — a comment tool, a comment table, or a
  // comment endpoint.
  const bad: string[] = [];
  // Every source in the repository, plus the skills, since the concept can come back as a
  // sentence telling somebody to leave a comment.
  //
  // Not the prose documents: they record the removal, and a document describing another
  // server's surface is describing someone else's tool. Nor this file, which has to name the strings
  // in order to look for them.
  const subjects = [...sourceFiles(["."], [".ts", ".html", ".sql"]),
                    ...sourceFiles(["catalog", "skills"], ["SKILL.md"])];
  for (const rel of subjects) {
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
  // The README is a map of directories, so every fact in it goes stale when someone moves a
  // file and nothing fails, because a map is not executed.
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const bad: string[] = [];
  const ls = (d: string): string[] => existsSync(join(root, d)) ? readdirSync(join(root, d)) : [];

  // Skill counts the README states per flow, read from the flow's own entry in the map and
  // bounded by the next one, so a count that wraps onto the following line is still checked.
  // The map fence is found by content — see fenceOf above.
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
  for (const m of skillsPara.matchAll(/\b(zz-[a-z-]+)\b/g)) {
    if (!onDisk.includes(m[1])) bad.push(`the README names skills/${m[1]}, which does not exist`);
  }
  // Every engine and ops tool somebody runs. A module an engine imports is not a tool anybody
  // looks for by name, so naming it would send a reader after a command that does not exist.
  for (const [dir, what] of [["packages/tools/src/testing", "engine"], ["packages/tools/src/ops", "ops tool"]]) {
    for (const rel of toolEntryPoints(dir)) {
      const name = (rel.split("/").pop() ?? "").replace(/\.ts$/, "");
      if (!readme.includes(name)) bad.push(`${what} ${name} ships and the README never names it`);
    }
  }
  // And the checks that live beside the code they are about: not every offline check is under
  // packages/tools — `*-check.ts` under services/*/src runs the real function it is about.
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
  // A check is cited by name, never by number: the numbering is positional, so every check
  // added above a citation moves it. A quoted "..." that reads like a check name must be one,
  // and a numeric citation is refused outright.
  const names = new Set(gateCheckNames());
  if (!names.size) return "no checks found — this cannot verify anything";
  // Discovered, not listed: `ourDocs()` is the same set every other document rule reads, so a
  // document added tomorrow is covered without anybody remembering to add it.
  const files = [...ourDocs(),
                 ...sourceFiles(["scripts/gate/checks"], [".ts"]),
                 ...sourceFiles(["catalog", "skills", "docs"], [".md"])];
  const bad: string[] = [];
  for (const rel of files) {
    // DELIBERATE: CHANGELOG.md is exempt, as it is from the line ceiling and the derived-count
    // rule. It is append-only, and an entry naming a check that has since been removed is
    // history rather than drift.
    if (rel === "CHANGELOG.md") continue;
    const f = join(root, rel);
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/\b(?:gate )?check \d+/gi)) {
      bad.push(`${rel} cites "${m[0]}" by number — cite the check's name, which does not move`);
    }
    // A quoted phrase introduced as a check must resolve to one. Whitespace is collapsed
    // because a name wraps across lines in prose, and in a comment carries the `//` with it.
    // `\b` before the word, because closeCheck, gateCheck and statusCheck are functions and
    // would otherwise make the text between two quotes read as a citation.
    for (const m of text.matchAll(/(?:gate )?\bcheck\s+"([^"]{8,})"/gi)) {
      const cited = m[1].replace(/\n\s*(?:\/\/|\*)?\s*/g, " ").replace(/\s+/g, " ").trim();
      if (!names.has(cited)) bad.push(`${rel} cites a check named "${cited}" and no check has that name`);
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("a document's links point at something that exists", () => {
  // Relative targets only: an external URL cannot be checked offline, and this gate has no
  // network by design.
  const bad: string[] = [];
  // Discovered, not listed, so a document that moves keeps having its links checked.
  const docs = [...ourDocs(), ...sourceFiles(["docs"], [".md"])];
  for (const rel of docs) {
    const f = join(root, rel);
    if (!existsSync(f)) continue;
    const dir = dirname(f);
    for (const m of readFileSync(f, "utf8").matchAll(/\[[^\]]*\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|javascript:)/.test(target)) continue;
      // Prose contains `[**bold** link](…)` as an example, not a link.
      if (target.includes("…")) continue;
      if (!existsSync(resolve(dir, target))) bad.push(`${rel} links to ${target}, which does not exist`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});


