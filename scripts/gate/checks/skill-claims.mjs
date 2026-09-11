/**
 * A skill that COUNTS something, counting it right.
 *
 * "Three gates", "eight components", "fifty-three slides" — a number written in prose beside
 * the thing it counts, which drifts the moment anybody adds a ninth. The number is not
 * decoration: an agent reads it and stops there, so a stale count silently shortens the work.
 * Every check here recomputes the number from the thing itself.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { firstOf, root, sourceFiles, unbuilt } from "../read.mjs";
import { check } from "../run.mjs";
import { catalogRoot, flows } from "../facts.mjs";

check("a flow's skills state its gate count as the manifest declares it", () => {
  // Written as prose, this number drifts and nothing notices. It was wrong in three places
  // at once: ops-flow's defining sentence said "three gates" and then listed spec, plan and
  // the acceptance — leaving out the intent gate the platform enforces — ops-spec called the
  // spec gate "the first gate", and state.md (then direction.md) said the Operations flow declares four.
  //
  // The manifest is the only thing that decides: a document with `gate: true` is a gate.
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
  const bad = [];
  for (const f of flows) {
    const mf = join(f.dir, "flow.json");
    const docs = JSON.parse(readFileSync(mf, "utf8")).documents ?? [];
    const gates = docs.filter((d) => d.gate).length;
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
  // "N gates" is checked above; the ORDINAL form is the same claim and slips past it.
  // ops-plan's description said it holds "the second approval gate" — plan.md is the third
  // gated document, after intent and spec, and it is the last one before anything is built,
  // which is the fact that makes the sentence worth writing at all.
  const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
  const bad = [];
  for (const f of flows) {
    const mf = join(f.dir, "flow.json");
    const docs = JSON.parse(readFileSync(mf, "utf8")).documents ?? [];
    const gated = docs.filter((d) => d.gate).map((d) => d.name);
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
        // Only when the sentence is about ITS OWN gate: "this is the second gate".
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
  // zz-backbone teaches the outcome words and then says "so a fifth word invents a row nobody
  // can total". There are three, so a new one is the fourth. The sentence was written when
  // there were four and stayed when `superseded` went — the identical drift the platform's own
  // refusal carried, in the skill every agent loads before anything else.
  //
  // The check above this one counts a skill's OWN contents under a heading. This counts a
  // vocabulary defined in @zz/contracts, so the number is derived from the definition rather
  // than from anything in the file.
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  const outcomes = JSON.parse(execFileSync("node", ["--input-type=module", "-e",
    `import { OUTCOMES } from ${JSON.stringify(join(root, "packages/contracts/dist/index.js"))};` +
    "process.stdout.write(JSON.stringify(OUTCOMES));"], { encoding: "utf8" }));
  const ORD = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh",
               "eighth", "ninth", "tenth"];
  const want = ORD[outcomes.length + 1];
  if (!want) return `OUTCOMES has ${outcomes.length} words — beyond what this check can name`;

  const bad = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    const lines = readFileSync(join(root, rel), "utf8").split("\n");
    lines.forEach((ln, i) => {
      const m = /\ba (\w+) word\b/i.exec(ln);
      if (!m) return;
      // Only where the outcome vocabulary is what is being counted: two or more of the words
      // within the surrounding few lines.
      const near = lines.slice(Math.max(0, i - 3), i + 3).join(" ").toLowerCase();
      if (outcomes.filter((o) => near.includes(o)).length < 2) return;
      if (m[1].toLowerCase() !== want) {
        bad.push(`${rel}:${i + 1} says "a ${m[1]} word" of a ${outcomes.length}-word ` +
                 `vocabulary — the next one is the ${want}`);
      }
    });
  }
  return bad.length ? firstOf(bad) : null;
});

check("a skill that counts its own contents counts them right", () => {
  // casebox-stg-usage's description said "its six verified traps" over a heading reading "The
  // seven verified traps", above seven of them. A seventh was added and the description was
  // not, which is the ordinary way a number in prose goes wrong.
  //
  // It matters more in a description than anywhere else: that sentence sits in context for
  // everyone on the team whether or not they load the skill, and it is what the model
  // matches on. A skill that miscounts itself in the one line everybody sees is not
  // trustworthy about the things nobody checks.
  //
  // Only headings that COUNT something, matched against the numbered items beneath them.
  const bad = [];
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
                  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13 };
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    const lines = readFileSync(join(root, rel), "utf8").split("\n");
    for (const [i, line] of lines.entries()) {
      // A COUNT of what follows ("The seven verified traps"), not an ORDINAL naming this
      // section ("## 2. Find the argument", "## Twelve: the spec's own contract"). The
      // first version of this check could not tell them apart and called five correct
      // headings defects — the number leading the heading and followed by punctuation is
      // the tell, and a count is always followed by the thing being counted.
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
  // sdlc-audit-criteria's own Criterion 8 is DRIFT / STALENESS: "Count items the doc claims to
  // discuss (e.g. 'across all three sessions', 'the four highest-impact items') and verify the
  // count against the actual list. If the count is wrong, that's drift."
  //
  // The number eleven is written out TEN times across three files — the criteria skill's
  // frontmatter and five places in its body, and both auditors' frontmatter and body — and is
  // derivable from two more: the `Criterion N —` step headings, and the length of
  // criteriaCovered in the JSON a round must return. Twelve statements of one number, held in
  // agreement by hand. Adding a twelfth criterion means editing ten lines, and missing one
  // fails nothing: the auditor still runs, and returns a criteriaCovered that does not match
  // what it did.
  //
  const dir = join(catalogRoot, "sdlc/sdlc-flow/skills");
  const f = join(dir, "sdlc-audit-criteria/SKILL.md");
  if (!existsSync(f)) return "sdlc-audit-criteria is missing";
  const src = readFileSync(f, "utf8");
  const heads = [...src.matchAll(/^### Step \d+: Criterion (\d+) — (.+)$/gm)].map((m) => m[2].trim());
  if (!heads.length) return "no `### Step N: Criterion M — NAME` headings — the criteria are no longer countable";
  const bad = [];
  // criteriaCovered's correspondence with these headings is the general rule and lives in
  // "a skill's coverage contract matches the list it enumerates". What is peculiar to this
  // trio is the COUNT, spelled ten times across three files — including in two skills that
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
  // The eight components a spec owes are written FIVE times: sdlc-flow's manifest declares
  // them, sdlc-spec-audit enumerates them `·`-separated and says "the platform refuses the
  // approval of a spec missing any of them", and sdlc-spec carries three more — a component
  // catalog table, the skeleton it tells the writer to emit, and a canonical numbered list
  // under "all eight, every time". Forty statements of one list, agreeing by hand.
  //
  // The existing check that every declared section is named by SOME skill does not catch a
  // drift in any of them: sdlc-spec writes those headings in four places, so a ninth section
  // would be "named" while every enumeration went on showing eight — and those enumerations
  // are what the writer emits and the auditor checks.
  //
  // Four shapes, because that is how the list is actually written. Anything that enumerates
  // declared names must enumerate all of them, in the manifest's order.
  const bad = [];
  for (const f of flows) {
    const m = JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8"));
    const skillsDir = join(f.dir, "skills");
    if (!existsSync(skillsDir)) continue;
    for (const doc of m.documents ?? []) {
      const want = doc.sections ?? [];
      if (want.length < 2) continue;
      const set = new Set(want);
      for (const sk of readdirSync(skillsDir)) {
        const g = join(skillsDir, sk, "SKILL.md");
        if (!existsSync(g)) continue;
        const src = readFileSync(g, "utf8");
        const runs = [];

        // 1. `A · B · C` — the first and last parts carry the surrounding prose.
        for (const run of src.replace(/\s+/g, " ").split(/(?<![·])\. /)) {
          const parts = run.split("·").map((x) => x.trim());
          if (parts.length < 2) continue;
          const got = parts.map((part, i) =>
            i === 0 ? want.find((w) => part.endsWith(w))
            : i === parts.length - 1 ? want.find((w) => part.startsWith(w))
            : (set.has(part) ? part : undefined));
          if (!got.some((x) => x === undefined)) runs.push(["a `·` list", got]);
        }
        // 2. a one-column table of `| `## X` |`, and 3. a numbered list of ``N. `## X```.
        for (const [label, re_] of [["a table", /^\|\s*`## ([^`]+)`\s*\|$/gm],
                                    ["a numbered list", /^\d+\. `## ([^`]+)`\s*$/gm]]) {
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
  // Four dispatched skills end by returning `criteriaCovered` — the caller's only evidence
  // that a worker applied everything it was supposed to. Each one enumerates its criteria as a
  // numbered list in its own text, and the array is a second copy of that list: eleven prose
  // failure modes in sdlc-audit-criteria, five investigation perspectives, five research
  // perspectives, ten review lenses. Adding, removing or renaming an item without editing the
  // array leaves a worker reporting coverage that does not describe what it did, and nothing
  // downstream can tell — the caller reads slugs, not headings.
  //
  // CONTAINMENT, not equality, because the slugs are deliberately shortened:
  // `pre-existing-defect-vs-new-regression` is written `pre-existing-vs-regression`, and four
  // of sdlc-review's ten are abbreviated that way. The slug's words must all appear in the
  // heading, which allows a shorter name and refuses a different one.
  //
  // Matched against ONE numbered list, found by correspondence rather than by position:
  // sdlc-research carries two (four constraints, then the five perspectives) and the array
  // describes the second. sdlc-recall's array is the journal's own `type` vocabulary rather
  // than an enumeration of its own text, so it is excluded by name.
  const TYPES = new Set(["decision", "design", "behavior", "process", "knowledge", "style"]);
  const words = (x) => new Set(x.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const bad = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    const src = readFileSync(join(root, rel), "utf8");
    const raw = /"criteriaCovered": (\[[^\]]*\])/.exec(src)?.[1];
    if (!raw) continue;
    let cov;
    try { cov = JSON.parse(raw); } catch { bad.push(`${rel}: criteriaCovered is not valid JSON`); continue; }
    if (!cov.length || cov.every((c) => TYPES.has(c))) continue;   // a type vocabulary, not a list
    // Every numbered list in the file: a maximal run of `N.` starting at 1, in either shape.
    const items = [...src.matchAll(/^(?:### Step \d+: Criterion (\d+) — (.+)$|(\d+)\. \*\*([^*]+)\*\*)/gm)]
      .map((m) => ({ n: Number(m[1] ?? m[3]), name: (m[2] ?? m[4]).trim() }));
    const lists = [];
    for (const it of items) {
      if (it.n === 1) lists.push([]);
      if (lists.length && it.n === lists[lists.length - 1].length + 1) lists[lists.length - 1].push(it.name);
    }
    const fits = lists.filter((l) => l.length === cov.length &&
      cov.every((c, i) => [...words(c)].every((w) => words(l[i]).has(w))));
    if (fits.length) continue;
    const near = lists.map((l) => l.length).join("/") || "none";
    bad.push(`${rel}: criteriaCovered has ${cov.length} entries and no numbered list in the file ` +
             `corresponds to it in order (lists of ${near} found)`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("the deck skill counts the template's slides correctly", () => {
  // sdlc-deck tells the writer to replace "the 53 guidebook `<section>` elements carrying the
  // `slide` class". That number is a fact about deck-guidebook.html — a 172KB file shipped
  // beside the skill — and nothing tied the two together, so editing the guidebook silently
  // makes the instruction wrong.
  //
  // It also nearly cost the cover slide. Fifty-two sections carry `class="slide"` and the
  // cover carries `class="slide active slide--cover"`, so an agent searching for that string
  // finds 52 of the 53 and leaves the guidebook's own title page as the first thing a reader
  // sees. The count and the matching rule are one fact, which is why both are checked here.
  const dir = join(catalogRoot, "sdlc/sdlc-flow/skills/sdlc-deck");
  const skill = join(dir, "SKILL.md"), tpl = join(dir, "deck-guidebook.html");
  if (!existsSync(skill)) return "sdlc-deck is missing";
  if (!existsSync(tpl)) return "deck-guidebook.html is missing — the skill tells the writer to read it";
  const html = readFileSync(tpl, "utf8");
  // A class TOKEN, the way a browser matches it, not a literal attribute value.
  const slides = [...html.matchAll(/<section\b[^>]*\bclass="([^"]*)"/g)]
    .filter((m) => m[1].split(/\s+/).includes("slide")).length;
  const said = /\b(\d+) guidebook `<section>` elements/.exec(readFileSync(skill, "utf8"))?.[1];
  if (!said) return "sdlc-deck no longer states how many guidebook sections the template has";
  const bad = [];
  if (Number(said) !== slides) {
    bad.push(`sdlc-deck says the template has ${said} guidebook slides and it has ${slides}`);
  }
  // A THIRD STATEMENT OF THE SAME LIST, inside the template itself. `#housebook-manifest`
  // is JSON the page parses at runtime: renderVersion reports "N reference pages across M
  // chapter labels" from it, and it is the only description of the deck a reader gets that
  // is not the deck. Nothing tied the two together, so adding, removing or reordering a
  // slide leaves the page telling its reader a count that is not its own — the same shape as
  // the skill's number above, one file further in and with no reader who could notice.
  const man = /<script id="housebook-manifest" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!man) {
    bad.push("deck-guidebook.html no longer carries #housebook-manifest, and renderVersion parses it at run time");
  } else {
    let listed;
    try {
      listed = JSON.parse(man[1]).slides ?? [];
    } catch (err) {
      bad.push(`#housebook-manifest is not valid JSON (${String(err.message)}) — renderVersion ` +
               "throws on the Version tab, and nothing else in the page would say why");
      listed = null;
    }
    if (listed) {
      // In ORDER, and by id: the library lists sections and the version panel counts the
      // manifest, so a reordering that keeps the count is a disagreement neither would show.
      const ids = [...html.matchAll(/<section\b[^>]*\bdata-slide-id="([^"]+)"/g)].map((m) => m[1]);
      const named = listed.map((x) => x.id);
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
  // AND THE VERSION THE SKILL TELLS AN AUTHOR TO STAMP. The template states its edition in 55
  // places: once in #housebook-manifest and once on each of the 53 slides, which is one file
  // and one edit — plus once more in sdlc-deck's worked example, which is a different file and
  // the only copy that can drift alone. Every slide a deck emits carries `data-version`, so a
  // stale example mislabels the provenance of every deck built from it, and nothing downstream
  // would contradict it.
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
      bad.push("sdlc-deck's worked example no longer stamps data-version, so an author has " +
               "nothing to copy and every emitted slide loses its provenance");
    } else if (example !== version) {
      bad.push(`sdlc-deck's example stamps data-version ${JSON.stringify(example)} and the ` +
               `template is ${JSON.stringify(version)} — an author following it mislabels every slide`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a heading that counts its own list counts it right", () => {
  // Four headings state how many items follow: "Five Investigation Perspectives", "The five
  // perspectives", "Failure-Mode Taxonomy (10 Categories)", "The seven verified traps". Each
  // is a number a person maintains by hand against a list right underneath it.
  //
  // casebox-stg-usage grew a seventh trap on 2026-08-28 and its own heading was updated; ops-select,
  // which cited "the six verified traps in `casebox-stg-usage`", was not — so one document counted
  // another's list and went stale the day that list grew. The count in ops-select carried no
  // information and is gone; these four do carry it, and are checked instead.
  //
  // Counted to the next heading of the same or higher level, which is the section the number
  // is about.
  const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
                 "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen"];
  const bad = [];
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
