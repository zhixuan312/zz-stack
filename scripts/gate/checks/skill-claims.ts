/**
 * A skill that counts something, counting it right.
 *
 * "Three gates", "eight components", "fifty-three slides" — a number written in prose beside
 * the thing it counts drifts the moment anybody adds a ninth, and an agent that reads the
 * number stops there. Every check here recomputes the number from the thing itself.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { firstOf, root, sourceFiles, unbuilt } from "../read.ts";
import { check } from "../run.ts";
import { catalogRoot, flows } from "../facts.ts";

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. `unknown?.message` narrows to `{}`, which has no properties at all. */
function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(err);
}

check("a flow's skills state its gate count as the manifest declares it", () => {
  // The manifest is the only thing that decides: a document with `gate: true` is a gate.
  const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
  const bad: string[] = [];
  for (const f of flows) {
    const mf = join(f.dir, "flow.json");
    const docs = JSON.parse(readFileSync(mf, "utf8")).documents ?? [];
    const gates = docs.filter((d: { gate?: boolean }) => d.gate).length;
    if (!gates) continue;
    const skills = join(f.dir, "skills");
    if (!existsSync(skills)) continue;
    for (const sk of readdirSync(skills)) {
      const md = join(skills, sk, "SKILL.md");
      if (!existsSync(md)) continue;
      const txt = readFileSync(md, "utf8");
      for (const m of txt.matchAll(/\*?\*?(one|two|three|four|five|six|seven|\d+)\*?\*? gates\b/gi)) {
        const said = WORDS[m[1].toLowerCase()] ?? Number(m[1]);
        if (said !== gates) {
          bad.push(`${f.owner}/${f.flow}/${sk}: says "${m[1]} gates"; the manifest declares ${gates}`);
        }
      }
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("a stage skill's ordinal for its own gate matches the manifest", () => {
  // "N gates" is checked above; the ordinal form is the same claim and slips past it — a
  // description saying a document holds "the second approval gate" is counting the gated
  // documents before it.
  const ORD: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
  const bad: string[] = [];
  for (const f of flows) {
    const mf = join(f.dir, "flow.json");
    const docs = JSON.parse(readFileSync(mf, "utf8")).documents ?? [];
    const gated = docs.filter((d: { gate?: boolean }) => d.gate).map((d: { name: string }) => d.name);
    const skills = join(f.dir, "skills");
    if (!existsSync(skills)) continue;
    for (const sk of readdirSync(skills)) {
      const md = join(skills, sk, "SKILL.md");
      if (!existsSync(md)) continue;
      // ops-plan -> plan.md, sdlc-spec -> spec.md: the stage skill is named for its document.
      const doc = `${sk.replace(/^[a-z0-9]+-/, "")}.md`;
      const pos = gated.indexOf(doc) + 1;
      if (!pos) continue;                          // this skill holds no gate
      const txt = readFileSync(md, "utf8");
      for (const m of txt.matchAll(/\b(first|second|third|fourth|fifth) (?:approval )?gate\b/gi)) {
        const said = ORD[m[1].toLowerCase()];
        // Only when the sentence is about its own gate: "this is the second gate".
        if (!/\b(this is|hold(?:s|ing)? the|carries the)\b/i.test(
              txt.slice(Math.max(0, m.index - 40), m.index))) continue;
        if (said !== pos) {
          bad.push(`${f.owner}/${f.flow}/${sk}: calls its gate the ${m[1]}; ` +
                   `${doc} is number ${pos} of ${gated.length} (${gated.join(", ")})`);
        }
      }
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("a skill counting the platform's vocabulary counts it right", () => {
  // The check above counts a skill's own contents under a heading. This counts the outcome
  // vocabulary, which is defined in @zz/contracts, so the number is derived from the
  // definition rather than from anything in the file. A skill saying "a fifth word invents a
  // row nobody can total" is claiming there are four.
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  const outcomes = JSON.parse(execFileSync("node", ["--input-type=module", "-e",
    `import { OUTCOMES } from ${JSON.stringify(join(root, "packages/contracts/dist/index.js"))};` +
    "process.stdout.write(JSON.stringify(OUTCOMES));"], { encoding: "utf8" }));
  const ORD = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh",
               "eighth", "ninth", "tenth"];
  const want = ORD[outcomes.length + 1];
  if (!want) return `OUTCOMES has ${outcomes.length} words — beyond what this check can name`;

  const bad: string[] = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    const lines = readFileSync(join(root, rel), "utf8").split("\n");
    lines.forEach((ln, i) => {
      const m = /\ba (\w+) word\b/i.exec(ln);
      if (!m) return;
      // Only where the outcome vocabulary is what is being counted: two or more of the words
      // within the surrounding few lines.
      const near = lines.slice(Math.max(0, i - 3), i + 3).join(" ").toLowerCase();
      if (outcomes.filter((o: string) => near.includes(o)).length < 2) return;
      if (m[1].toLowerCase() !== want) {
        bad.push(`${rel}:${i + 1} says "a ${m[1]} word" of a ${outcomes.length}-word ` +
                 `vocabulary — the next one is the ${want}`);
      }
    });
  }
  return bad.length ? firstOf(bad) : null;
});

check("a skill that counts its own contents counts them right", () => {
  // A count in a skill's description matters more than one in its body: that sentence sits in
  // context for everyone on the team whether or not they load the skill, and it is what the
  // model matches on.
  //
  // Only headings that count something, matched against the numbered items beneath them.
  const bad: string[] = [];
  const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
                  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13 };
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    const lines = readFileSync(join(root, rel), "utf8").split("\n");
    for (const [i, line] of lines.entries()) {
      // A count of what follows ("The seven verified traps"), not an ordinal naming this
      // section ("## 2. Find the argument", "## Twelve: the spec's own contract"). The number
      // leading the heading and followed by punctuation is the tell; a count is always
      // followed by the thing being counted.
      if (/^##+\s*(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|\d+)\s*[.:)]/i.test(line)) continue;
      const m = /^##+ .*?\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|\d+)\s+[a-z]/i.exec(line);
      if (!m) continue;
      const claimed = WORDS[m[1].toLowerCase()] ?? Number(m[1]);
      if (!claimed || claimed > 30) continue;
      // Numbered items until the next heading of the same or higher level.
      const level = (/^#+/.exec(line) ?? [""])[0].length;
      let n = 0;
      for (let j = i + 1; j < lines.length; j++) {
        const h = /^#+/.exec(lines[j]);
        if (h && h[0].length <= level) break;
        if (/^\d+\. /.test(lines[j])) n++;
      }
      if (n && n !== claimed) {
        bad.push(`${rel}:${i + 1} says ${claimed} and lists ${n}`);
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("the audit criteria count themselves the way they tell auditors to", () => {
  // sdlc-audit-criteria's Criterion 8 is drift and staleness: count the items a document
  // claims to discuss and verify the count against the actual list.
  //
  // The criteria count is written out in the criteria skill's frontmatter and body and in both
  // auditors' frontmatter and body, and is derivable from the `Criterion N —` step headings.
  // Missing one of those edits fails nothing on its own: the auditor still runs and returns a
  // criteriaCovered that does not match what it did.
  const dir = join(catalogRoot, "sdlc/sdlc-flow/skills");
  const f = join(dir, "sdlc-audit-criteria/SKILL.md");
  if (!existsSync(f)) return "sdlc-audit-criteria is missing";
  const src = readFileSync(f, "utf8");
  const heads = [...src.matchAll(/^### Step \d+: Criterion (\d+) — (.+)$/gm)].map((m) => m[2].trim());
  if (!heads.length) return "no `### Step N: Criterion M — NAME` headings — the criteria are no longer countable";
  const bad: string[] = [];
  // criteriaCovered's correspondence with these headings is the general rule and lives in
  // "a skill's coverage contract matches the list it enumerates". What is peculiar to this
  // trio is the count, spelled ten times across three files — including in two skills that
  // only load these criteria and can go stale without touching this one.
  const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
                 "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen"];
  for (const rel of ["sdlc-audit-criteria", "sdlc-spec-audit", "sdlc-plan-audit"]) {
    const g = join(dir, rel, "SKILL.md");
    if (!existsSync(g)) continue;
    const text = readFileSync(g, "utf8");
    for (const m of text.matchAll(/\b([a-z]+|\d+) (?:prose )?failure modes\b/g)) {
      const said = /^\d+$/.test(m[1]) ? Number(m[1]) : WORDS.indexOf(m[1]);
      if (said < 0) continue;                       // not a count ("the failure modes")
      if (said !== heads.length) {
        bad.push(`${rel} says "${m[1]} failure modes" and there are ${heads.length}`);
      }
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("a skill that lists a document's sections lists all of them", () => {
  // The components a spec owes are declared by sdlc-flow's manifest and enumerated again in
  // sdlc-spec-audit (`·`-separated) and sdlc-spec (a component table, the skeleton it tells the
  // writer to emit, and a numbered list).
  //
  // The check that every declared section is named by some skill does not catch a drift in any
  // of them: a new section named once would pass while every enumeration went on omitting it,
  // and those enumerations are what the writer emits and the auditor checks.
  //
  // Four shapes, because that is how the list is actually written. Anything that enumerates
  // declared names must enumerate all of them, in the manifest's order.
  const bad: string[] = [];
  const TABLE_SHAPES: [string, RegExp][] = [["a table", /^\|\s*`## ([^`]+)`\s*\|$/gm],
                                            ["a numbered list", /^\d+\. `## ([^`]+)`\s*$/gm]];
  for (const f of flows) {
    const m = JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8"));
    const skillsDir = join(f.dir, "skills");
    if (!existsSync(skillsDir)) continue;
    for (const doc of m.documents ?? []) {
      const want: string[] = doc.sections ?? [];
      if (want.length < 2) continue;
      const set = new Set(want);
      for (const sk of readdirSync(skillsDir)) {
        const g = join(skillsDir, sk, "SKILL.md");
        if (!existsSync(g)) continue;
        const src = readFileSync(g, "utf8");
        const runs: [string, (string | undefined)[]][] = [];

        // 1. `A · B · C` — the first and last parts carry the surrounding prose.
        for (const run of src.replace(/\s+/g, " ").split(/(?<![·])\. /)) {
          const parts = run.split("·").map((x) => x.trim());
          if (parts.length < 2) continue;
          const got = parts.map((part, i) =>
            i === 0 ? want.find((w: string) => part.endsWith(w))
            : i === parts.length - 1 ? want.find((w: string) => part.startsWith(w))
            : (set.has(part) ? part : undefined));
          if (!got.some((x) => x === undefined)) runs.push(["a `·` list", got]);
        }
        // 2. a one-column table of `| `## X` |`, and 3. a numbered list of ``N. `## X```.
        for (const [label, re_] of TABLE_SHAPES) {
          const got = [...src.matchAll(re_)].map((x) => x[1].trim()).filter((x) => set.has(x));
          if (got.length) runs.push([label, got]);
        }
        // 4. the `##` headings of a skeleton the skill tells the writer to emit.
        for (const blk of src.matchAll(/^(`{3,})[a-z]*\n([\s\S]*?)^\1`*$/gm)) {
          const got = [...blk[2].matchAll(/^## (.+)$/gm)].map((x) => x[1].trim()).filter((x) => set.has(x));
          if (got.length > 1) runs.push(["a skeleton", got]);
        }

        for (const [label, got] of runs) {
          if (got.length !== want.length || got.some((x, i) => x !== want[i])) {
            bad.push(`${f.flow}/${sk}: ${label} gives ${got.length} of ${doc.name}'s ` +
                     `${want.length} declared sections (${got.join(" · ")}) — the manifest says ` +
                     want.join(" · "));
          }
        }
      }
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("a skill's coverage contract matches the list it enumerates", () => {
  // Dispatched skills end by returning `criteriaCovered`, the caller's only evidence that a
  // worker applied everything it was supposed to. Each enumerates its criteria as a numbered
  // list in its own text, and the array is a second copy of that list. A rename that misses the array leaves a worker reporting
  // coverage that does not describe what it did, and the caller reads slugs, not headings.
  //
  // Containment, not equality, because the slugs are deliberately shortened:
  // `pre-existing-defect-vs-new-regression` is written `pre-existing-vs-regression`. The slug's
  // words must all appear in the heading, which allows a shorter name and refuses a different
  // one.
  //
  // Matched against one numbered list, found by correspondence rather than by position:
  // sdlc-research carries two and the array describes the second. sdlc-recall's array is the
  // journal's own `type` vocabulary rather than an enumeration of its own text, so it is
  // excluded by name.
  const TYPES = new Set(["decision", "design", "behavior", "process", "knowledge", "style"]);
  const words = (x: string): Set<string> => new Set(x.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const bad: string[] = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    const src = readFileSync(join(root, rel), "utf8");
    const raw = /"criteriaCovered": (\[[^\]]*\])/.exec(src)?.[1];
    if (!raw) continue;
    let cov;
    try { cov = JSON.parse(raw); } catch { bad.push(`${rel}: criteriaCovered is not valid JSON`); continue; }
    if (!cov.length || cov.every((c: string) => TYPES.has(c))) continue;   // a type vocabulary, not a list
    // Every numbered list in the file: a maximal run of `N.` starting at 1, in either shape.
    const items = [...src.matchAll(/^(?:### Step \d+: Criterion (\d+) — (.+)$|(\d+)\. \*\*([^*]+)\*\*)/gm)]
      .map((m) => ({ n: Number(m[1] ?? m[3]), name: (m[2] ?? m[4]).trim() }));
    const lists: string[][] = [];
    for (const it of items) {
      if (it.n === 1) lists.push([]);
      if (lists.length && it.n === lists[lists.length - 1].length + 1) lists[lists.length - 1].push(it.name);
    }
    const fits = lists.filter((l) => l.length === cov.length &&
      cov.every((c: string, i: number) => [...words(c)].every((w) => words(l[i]).has(w))));
    if (fits.length) continue;
    const near = lists.map((l) => l.length).join("/") || "none";
    bad.push(`${rel}: criteriaCovered has ${cov.length} entries and no numbered list in the file ` +
             `corresponds to it in order (lists of ${near} found)`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("the deck skill counts the template's slides correctly", () => {
  // zz-deck tells the writer how many guidebook `<section>` elements carry the `slide` class.
  // That number is a fact about deck-guidebook.html, shipped beside the skill.
  //
  // The matching rule is part of the same fact: the cover carries
  // `class="slide active slide--cover"`, so an agent searching for the exact string
  // `class="slide"` misses the guidebook's title page.
  //
  // DELIBERATE: `skills/zz-deck`, not a catalog path. The baseline's skills are the tree beside
  // the catalog rather than inside it, and the two `existsSync` guards below return a string,
  // so a catalog path would make this report "zz-deck is missing" for ever.
  const dir = join(root, "skills/zz-deck");
  const skill = join(dir, "SKILL.md"), tpl = join(dir, "deck-guidebook.html");
  if (!existsSync(skill)) return "zz-deck is missing";
  if (!existsSync(tpl)) return "deck-guidebook.html is missing — the skill tells the writer to read it";
  const html = readFileSync(tpl, "utf8");
  // A class token, the way a browser matches it, not a literal attribute value.
  const slides = [...html.matchAll(/<section\b[^>]*\bclass="([^"]*)"/g)]
    .filter((m) => m[1].split(/\s+/).includes("slide")).length;
  const said = /\b(\d+) guidebook `<section>` elements/.exec(readFileSync(skill, "utf8"))?.[1];
  if (!said) return "zz-deck no longer states how many guidebook sections the template has";
  const bad: string[] = [];
  if (Number(said) !== slides) {
    bad.push(`zz-deck says the template has ${said} guidebook slides and it has ${slides}`);
  }
  // A third statement of the same list, inside the template itself. `#housebook-manifest` is
  // JSON the page parses at runtime: renderVersion reports "N reference pages across M chapter
  // labels" from it, and it is the only description of the deck a reader gets that is not the
  // deck.
  const man = /<script id="housebook-manifest" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!man) {
    bad.push("deck-guidebook.html no longer carries #housebook-manifest, and renderVersion parses it at run time");
  } else {
    let listed;
    try {
      listed = JSON.parse(man[1]).slides ?? [];
    } catch (err) {
      bad.push(`#housebook-manifest is not valid JSON (${errMessage(err)}) — renderVersion ` +
               "throws on the Version tab, and nothing else in the page would say why");
      listed = null;
    }
    if (listed) {
      // In order, and by id: the library lists sections and the version panel counts the
      // manifest, so a reordering that keeps the count is a disagreement neither would show.
      const ids = [...html.matchAll(/<section\b[^>]*\bdata-slide-id="([^"]+)"/g)].map((m) => m[1]);
      const named: string[] = listed.map((x: { id: string }) => x.id);
      if (named.length !== ids.length || named.some((x, i) => x !== ids[i])) {
        const missing = ids.filter((x) => !named.includes(x));
        const extra = named.filter((x) => !ids.includes(x));
        bad.push(`#housebook-manifest lists ${named.length} slides and the template has ` +
                 `${ids.length}` +
                 (missing.length ? `; not in the manifest: ${missing.join(", ")}` : "") +
                 (extra.length ? `; in the manifest and not in the deck: ${extra.join(", ")}` : "") +
                 (!missing.length && !extra.length ? "; the same slides in a different order" : ""));
      }
    }
  }
  // And the version the skill tells an author to stamp. The template states its edition once
  // in #housebook-manifest and once on each slide, plus once more in zz-deck's worked example, which is a different file and the only copy that can drift alone.
  // Every slide a deck emits carries `data-version`, so a stale example mislabels the
  // provenance of every deck built from it.
  const version = /"version"\s*:\s*"([^"]+)"/.exec(man?.[1] ?? "")?.[1];
  if (!version) {
    bad.push("#housebook-manifest states no version — the slides stamp `data-version` from it");
  } else {
    const stamped = [...new Set([...html.matchAll(/data-version="([^"]*)"/g)].map((m) => m[1]))];
    if (stamped.length !== 1 || stamped[0] !== version) {
      bad.push(`the template's slides stamp data-version ${stamped.map((v) => JSON.stringify(v)).join(", ")} ` +
               `and #housebook-manifest says ${JSON.stringify(version)} — one edition, one number`);
    }
    const example = /data-version="([^"]*)"/.exec(readFileSync(skill, "utf8"))?.[1];
    if (!example) {
      bad.push("zz-deck's worked example no longer stamps data-version, so an author has " +
               "nothing to copy and every emitted slide loses its provenance");
    } else if (example !== version) {
      bad.push(`zz-deck's example stamps data-version ${JSON.stringify(example)} and the ` +
               `template is ${JSON.stringify(version)} — an author following it mislabels every slide`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a heading that counts its own list counts it right", () => {
  // A heading that states how many items follow ("Five Investigation Perspectives",
  // "Failure-Mode Taxonomy (10 Categories)") carries a number maintained by hand against the
  // list right underneath it.
  //
  // Counted to the next heading of the same or higher level, which is the section the number
  // is about.
  const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
                 "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen"];
  const bad: string[] = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    const lines = readFileSync(join(root, rel), "utf8").split("\n");
    lines.forEach((line, i) => {
      const h = /^(#{2,6})\s+(.*)$/.exec(line);
      if (!h) return;
      // "The five perspectives" / "Five Investigation Perspectives" / "… (10 Categories)"
      const m = /^(?:The\s+)?(\w+)\s+\S/.exec(h[2]) ?? /\((\w+)\s+\w+\)\s*$/.exec(h[2]);
      if (!m) return;
      const w = m[1].toLowerCase();
      const said = /^\d+$/.test(w) ? Number(w) : WORDS.indexOf(w);
      if (said < 2) return;                      // not a count, or too small to be one
      const depth = h[1].length;
      let items = 0;
      for (let j = i + 1; j < lines.length; j += 1) {
        const hh = /^(#{1,6})\s/.exec(lines[j]);
        if (hh && hh[1].length <= depth) break;
        if (/^\d+\.\s/.test(lines[j])) items += 1;
      }
      if (items && items !== said) {
        bad.push(`${rel}: "${h[2]}" says ${said} and ${items} numbered items follow it`);
      }
    });
  }
  return bad.length ? bad.join("; ") : null;
});
