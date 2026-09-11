/**
 * What a skill's TEXT may and may not say.
 *
 * Not its shape and not its arithmetic — its claims. A skill that justifies itself by
 * machinery this platform does not have, that tells an agent to write a document with a
 * local-file tool, that names a repository path nobody ships, or that instructs a model to
 * refuse a person's own words. Each of these reads as authoritative and is wrong, and prose
 * is the one part of this platform nothing else checks.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { firstOf, root, sourceFiles } from "../read.mjs";
import { check } from "../run.mjs";
import { NAMING, catalogPackages, everyShippedSkill, flows, ownedFields, platformSkills, skillsOf } from "../facts.mjs";

check("a skill_view a skill spells out names a skill that exists", () => {
  // THE DIRECT INSTRUCTION, checked directly. The prefix check below covers a backticked
  // sibling name, which is what a citation usually looks like WITHIN a flow. It cannot
  // cover a cross-family name: `blocks-capabilities` shares no prefix with ops-flow's
  // skills, so `skill_view("blocks-capabilities")` sat in sm-select AND in zz-backbone —
  // the platform skill every flow on this platform loads first — for as long as the skill
  // was gone, and the gate was green the whole time. A block evaluation loaded zz-backbone,
  // did what it said, and was refused: "no skill named 'blocks-capabilities' is available
  // to you".
  //
  // `skill_view("X")` is not a citation, it is an instruction to load X, and an instruction
  // to load something that does not exist is wrong in a way no convention makes ambiguous.
  // Its `file:` form is out of scope here: whether a skill ships a given reference is a
  // question about that skill's directory, and "a skill never instructs a tool its package
  // cannot reach" is where file paths are answered.
  const bad = [];
  for (const rel of sourceFiles(["catalog", "skills", "blocks"], ["SKILL.md"])) {
    const txt = readFileSync(join(root, rel), "utf8");
    for (const m of txt.matchAll(/skill_view\(\s*["'`]([a-z0-9][a-z0-9-]*)["'`]/g)) {
      if (!everyShippedSkill().has(m[1])) bad.push(`${rel} -> skill_view("${m[1]}")`);
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("no skill references a skill that is not shipped", () => {
  const bad = [];
  for (const f of flows) {
    const have = new Set(skillsOf(f).map((s) => s.name));
    if (have.size === 0) continue;
    // A backticked `<flow-prefix>-name` is an identifier the reader is expected to load.
    // Prose mentions are deliberately written without backticks, which is the convention
    // that lets this check mean something.
    // FROM THE SKILLS THEMSELVES, not from the flow's name. This was
    //   f.flow.replace(/-flow$/, "")
    // which works only where a flow is called `<x>-flow` and its skills `<x>-…`. For
    // zz-block-eval it looked for `zz-block-eval-*` while the skills are `zz-block-*`, so
    // the check covered NOTHING for both evaluation flows — and a restructure left
    // `zz-block-defects` and `zz-block-handover` cited in prose after they were merged away.
    // The agent loaded them, was refused, and the gate had been green throughout.
    //
    // The shared prefix of a flow's own skill names is what a citation of a sibling looks
    // like, and it cannot drift from the names it is derived from.
    const names = [...have];
    let prefix = names[0] ?? "";
    for (const n of names) {
      let i = 0;
      while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
      prefix = prefix.slice(0, i);
    }
    prefix = prefix.replace(/[^-]*$/, "");            // back to the last hyphen
    if (prefix.length < 3) continue;                  // nothing shared enough to be a prefix
    const re = new RegExp("`(" + prefix + "[a-z-]+)`", "g");
    for (const s of skillsOf(f)) {
      const txt = readFileSync(s.path, "utf8");
      for (const m of txt.matchAll(re)) {
        // Shipped ANYWHERE, not just by this flow. `zz-skill-evolve` is a platform skill and
        // zz-skill-eval's report legitimately names it as what consumes its findings; a check
        // that knew only one flow's skills would call every cross-flow citation a defect and
        // teach the reader to ignore it.
        if (!have.has(m[1]) && !everyShippedSkill().has(m[1])) bad.push(`${s.name} -> ${m[1]}`);
      }
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("no skill justifies itself by machinery this platform does not have", () => {
  // The sdlc flow was ported, and the port kept its source project's furniture. A "plan-stage
  // renderer" and a "spec-stage renderer" were given as the REASON the heading formats matter;
  // neither exists here. A check path was to be resolved "relative to the directory
  // execute_plan runs in", quoting "the validator's own error" — no such tool, no such
  // validator.
  //
  // The rules were right and the reasons were fiction, which is the worse way round: anyone
  // who checks finds no renderer and concludes the rule is vestigial, when sdlc-execute and
  // sdlc-plan-audit genuinely depend on it.
  // @include is here too: nothing on this platform expands one. skill_view returns the file
  // verbatim, so a directive that names another file ships as literal text — and both skills
  // that carried one followed it with "apply these writing rules", above nothing at all.
  // "the pipeline" joined them: sdlc-plan told a plan author that it "re-materializes your
  // declared checks from the plan before scoring". Nothing here is a pipeline — sdlc-execute's
  // caller writes each check to its path before dispatching the task that must pass it, which
  // is a person or an agent following a skill, and knowing which it is changes how you write
  // the check.
  const GHOSTS = [/\brenderer\b/, /\bexecute_plan\b/, /\bthe validator\b/, /\bPer FR-\d/,
                  /^@include\b/, /\bthe pipeline\b/, /\bregistered Method\b/, /\bsoftware-change@/,
                  // Another project's architecture, describing what this one does not add.
                  // There is no task type here and no HTTP route a skill could add.
                  /\btask type\b/, /\bserver schema\b/];
  const bad = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    readFileSync(join(root, rel), "utf8").split("\n").forEach((line, i) => {
      for (const g of GHOSTS) {
        if (g.test(line)) bad.push(`${rel}:${i + 1} cites ${g.source.replace(/\\b/g, "")}`);
      }
    });
  }
  // Shown eight at a time, and SAYING SO. It sliced to eight silently, so a port that dragged
  // forty citations across looked like a port that dragged eight — and the reader fixes eight,
  // re-runs, and is surprised. A cap that does not report itself is the same shape as a
  // listing that quietly omits things.
  return firstOf(bad);
});

check("no skill writes a document with a local-file tool", () => {
  // sdlc-spec told the model to write the spec skeleton "in ONE `Write` call" and to enrich
  // each section "using `Edit`". Those are the runtime's LOCAL file tools. The platform's
  // documents live in the initiative store and are written with write_file / patch_file — a
  // spec written to a local path has no envelope, no version snapshot at approval, no
  // telemetry, and nothing a person can approve or an auditor can read. And it looks exactly
  // like success, which is why the same file's own design note warns against it.
  const LOCAL = /`(Write|Edit|MultiEdit|NotebookEdit)`/g;
  const bad = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    readFileSync(join(root, rel), "utf8").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(LOCAL)) {
        bad.push(`${rel}:${i + 1} names \`${m[1]}\` — documents are written with write_file / patch_file`);
      }
    });
  }
  return firstOf(bad);
});

check("a skill that ships an asset does not say the asset is beside it", () => {
  // On Claude Code a standalone skill is PROMOTED: its SKILL.md becomes commands/<name>.md
  // and only the text moves — assets stay in skills/<name>/. So "next to this file" is true
  // in Codex and false on Claude Code, which is the client where the promotion happens and
  // the one most people use.
  //
  // sdlc-deck said exactly that about a 250KB template, added "that is the only place to
  // look — no probing, no fallbacks", and instructed the model to stop rather than improvise
  // if it was missing. Which it dutifully would have, every time, on Claude Code.
  const bad = [];
  for (const f of flows) {
    const m = JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8"));
    for (const name of m.standalone ?? []) {
      const dir = join(f.dir, "skills", name);
      if (!existsSync(dir)) continue;
      const assets = readdirSync(dir).filter((e) => e !== "SKILL.md");
      if (assets.length === 0) continue;
      const txt = readFileSync(join(dir, "SKILL.md"), "utf8");
      if (/next to this file|beside this file|same directory as this file/i.test(txt)) {
        bad.push(`${name} ships ${assets.join(", ")} and calls it "next to this file", ` +
                 "but the skill is promoted to commands/ on Claude Code and the asset is not");
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("every stage that writes a document names show_document, or says why not", () => {
  // ops-flow told its agent to present documents in full and its records show it did.
  // sdlc-flow's eleven skill files never mentioned the subject, and its records show that
  // too. The difference was never a decision — it was which prose happened to be loaded.
  // The departure regex is verified against sm-plan:177's actual wording.
  const bad = [];
  for (const f of flows) {
    const mf = join(f.dir, "flow.json");
    if (!existsSync(mf)) continue;
    const m = JSON.parse(readFileSync(mf, "utf8"));
    for (const d of m.documents ?? []) {
      if (!d.stage) continue;
      const sk = join(f.dir, "skills", d.stage, "SKILL.md");
      if (!existsSync(sk)) { bad.push(`${f.owner}/${f.flow}: ${d.stage} declares no SKILL.md`); continue; }
      const text = readFileSync(sk, "utf8");
      if (!/show_document/.test(text) && !/do not paste|does not paste|present .{0,40}differently/i.test(text)) {
        bad.push(`${f.owner}/${f.flow}/${d.stage} writes ${d.name} but neither names show_document nor states a departure`);
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a skill citing another document's section cites one that exists", () => {
  // Skills send each other to numbered sections of documents other skills produce —
  // "read section 10 ('about this stakeholder') of their records". The producing template is
  // edited, the numbers move, and the citation goes on looking authoritative.
  //
  // Four were wrong at once: learnings.md has SEVEN sections, and sm-spec sent readers to 10
  // and 4 while sm-select sent them to 10 and 9. An agent that follows one of those opens the
  // document, cannot find the section, and concludes the instruction is stale.
  //
  // The templates declare their sections as `N. **Title**`, so the numbering is readable.
  // A citation must agree with it on both the number and the name.
  const declared = new Map();          // number -> Set of titles declared anywhere
  const skillFiles = sourceFiles(["catalog", "skills"], ["SKILL.md"]);
  for (const rel of skillFiles) {
    for (const m of readFileSync(join(root, rel), "utf8").matchAll(/^(\d+)\.\s+\*\*([^*]+)\*\*/gm)) {
      if (!declared.has(m[1])) declared.set(m[1], new Set());
      declared.get(m[1]).add(m[2].trim().toLowerCase());
    }
  }
  const bad = [];
  for (const rel of skillFiles) {
    for (const m of readFileSync(join(root, rel), "utf8").matchAll(/section (\d+) \("([^"]+)"\)/g)) {
      const [, num, title] = m;
      const titles = declared.get(num);
      const want = title.trim().toLowerCase();
      if (!titles) {
        bad.push(`${rel}: cites section ${num} ("${title}"), and no template declares a section ${num}`);
      } else if (![...titles].some((t) => t.includes(want) || want.includes(t))) {
        bad.push(`${rel}: cites section ${num} as "${title}"; section ${num} is "${[...titles].join('", "')}"`);
      }
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("no skill or agent prompt names a repository path that does not exist", () => {
  // The release-document version of this check deliberately skips catalog/ and skills/,
  // because those are versioned by their own digest rather than dated as release documents.
  // The consequence was that nothing checked their paths at all, and both agent system
  // prompts said they were generated by a script one directory up from where it actually
  // sat. Both that script and the front end it bootstrapped have since been replaced, which
  // is the general case rather than the exception: a path in prose goes stale because the
  // thing moved, and nothing that moves it reads the prose.
  //
  // Matched with or without backticks: these two were written plain, which is exactly how
  // the other check missed them.
  const bad = [];
  const files = sourceFiles(["catalog", "skills"], [".md"]);
  const TOP = "docs|services|packages|catalog|skills|deploy|scripts|testing";
  for (const rel of files) {
    const txt = readFileSync(join(root, rel), "utf8");
    for (const m of txt.matchAll(
      new RegExp(`\\b((?:${TOP})/[A-Za-z0-9._/-]+\\.(?:py|mjs|sh|ts|json|md|html|yml))`, "g"))) {
      const p = m[1];
      if (/[<>*]/.test(p)) continue;                 // a placeholder, not a path
      // Three frames a skill legitimately speaks in, and it must resolve in one of them:
      // the repository root, its own flow's directory, and the layout the skill has once
      // installed — where a flow's `skills/<name>/asset` is exactly where the asset lands.
      const flowDir = rel.split("/").slice(0, 3).join("/");     // catalog/<owner>/<flow>
      const here = rel.split("/").slice(0, -1).join("/");
      const frames = [join(root, p), join(root, flowDir, p), join(root, here, p)];
      if (!frames.some(existsSync)) bad.push(`${rel}: names ${p}, which does not exist`);
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("only a dispatched skill demands a JSON-only final response", () => {
  // "Your FINAL text response must be exactly one JSON block" is a WORKER's contract: it is
  // read by the caller that dispatched it and synthesised. sdlc-spec carried it while running
  // in the main agent, where the final response goes to the person who has just been
  // interviewed and must now agree to the spec — so the stage ended by handing a stakeholder
  // a JSON envelope, and nothing on this platform reads one.
  //
  // A skill that demands it must say, in its own description, that it is dispatched.
  const bad = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    const txt = readFileSync(join(root, rel), "utf8");
    if (!/FINAL text response must be exactly one JSON/i.test(txt)) continue;
    const fm = txt.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    if (!/dispatched/i.test(fm)) {
      bad.push(`${rel}: demands a JSON-only final response and its description does not say it is dispatched`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("no flow tells an agent to refuse a person's own words", () => {
  // The platform default used to be that an approval passes ONLY on "approved" or "yes, I
  // approve", and that "ok" and "go ahead" do NOT pass — the agent was to hold and ask again.
  // That is the platform instructing every flow to make a person repeat a decision they had
  // already made. It is gone from zz-backbone, and the risk now is a flow reintroducing it
  // locally, where nobody would see it.
  //
  // Deliberately narrow: it looks for the shape of a phrase whitelist near an approval, not
  // for opinions about approvals. A flow that genuinely needs a stricter rule states the
  // override in its own words, which this does not match.
  const bad = [];
  for (const f of [...flows, { dir: null }]) {
    for (const sk of (f.dir === null ? platformSkills() : skillsOf(f))) {
      for (const m of readFileSync(sk.path, "utf8").matchAll(/^.*\bapprov\w*\b.*$/gim)) {
        const line = m[0].trim();
        // Three shapes, because the second and third slipped past the first. sm-intent
        // carried `(the same discipline as every gate: "approved", not "ok" or "continue")`
        // — a phrase whitelist in every respect, using none of the words the original
        // pattern looked for. A list of accepted words beside a list of rejected ones IS
        // the defect, however the sentence is built.
        const WHITELIST = /"[^"]{1,20}"\s*,?\s*(and )?not\s+"|not\s+"[^"]{1,20}"\s*(or|,)\s*"/i;
        if (/\bdo(es)? not pass\b|\bonly on an? (unambiguous|explicit|exact)\b/i.test(line)
            || WHITELIST.test(line)) {
          bad.push(`${sk.name}: "${line.slice(0, 66)}…"`);
        }
      }
    }
  }
  return bad.length
    ? `${bad.join("; ")} — judging whether someone agreed is the model's job; a list of ` +
      "accepted phrases only fails the person who said it the fourth way"
    : null;
});

check("no skill template hands a model a field the platform owns", () => {
  // A frontmatter template inside a fenced block is an instruction: the model copies it.
  // Five fields are the platform's — status, approved_by, approved_at, outcome, closed_by —
  // and zz-core refuses a write that moves any of them by hand. A template carrying one
  // therefore produces a refusal on the very first save of the very first document, which
  // is the worst place for a flow to discover it.
  //
  // Found by reading rather than by running: three sdlc templates opened with
  // `status: draft`, and an sdlc closing skill's close section handed over a whole
  // `outcome: delivered` block while the same file, forty lines down, correctly said
  // `close()` derives it. The stale half came first, which is the half an agent follows.
  //
  // Only inside a fence, and only as a KEY at the start of a line. Prose naming a field is
  // how these skills explain the rule, and explaining it is exactly what they should do.
  //
  // A fence is not the only way to hand a model a template. sdlc-plan's step 2 said "Write
  // the header — frontmatter — `flow: sdlc-flow`, `type: plan`, `status: draft`" in an
  // ordinary numbered step, inline backticks and no fence, and an agent following it was
  // refused on the first save of every plan.md. So OUTSIDE a fence the test is different and
  // has to be: naming a field is how these skills explain the rule, and they must go on
  // explaining it — what is refused is being TOLD TO WRITE one, which is an imperative verb
  // and the field in the same sentence.
  const OWNED = new RegExp(`^\\s*(${ownedFields().join("|")})\\s*:`);
  const ENVELOPE_KEY = /^\s*(flow|type|version|updated_at|accepted_by|no_signoff_reason)\s*:/;
  const OWNED_INLINE = new RegExp(
    `(record|write|set|put|add|patch|fill|stamp)\\b.{0,90}?\`(${ownedFields().join("|")})\\s*:`, "is");
  // The sentence is describing the platform's behaviour, not asking for it.
  const DESCRIBES = /platform|refus|by hand|approve\(|close\(|stamp|stays|never|not by/i;
  const bad = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    let fenced = false;
    for (const [i, line] of readFileSync(join(root, rel), "utf8").split("\n").entries()) {
      if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
      if (fenced && OWNED.test(line)) {
        bad.push(`${rel}:${i + 1} templates \`${line.trim().split(":")[0]}\``);
      }
      // ANY envelope key in a fenced block, not only the five the platform owns. sdlc-method
      // — the skill every sdlc stage is told to read first — showed the envelope as a
      // ```yaml block of `flow:` and `type:` under the words "every document carries the
      // envelope". Neither key is platform-OWNED in the refusing sense, and there was no
      // `---`, so both halves of this check walked past it while it taught every stage the
      // model that 2.12 removed.
      if (fenced && ENVELOPE_KEY.test(line)) {
        bad.push(`${rel}:${i + 1} shows \`${line.trim().split(":")[0]}\` as something to write`);
      }
      if (!fenced && OWNED_INLINE.test(line) && !DESCRIBES.test(line)) {
        bad.push(`${rel}:${i + 1} tells the model to write a field the platform stamps`);
      }
    }
  }
  return bad.length
    ? `${bad.join("; ")} — the platform stamps these; a template carrying one is refused on ` +
      "the first save. Say approve() or close() instead."
    : null;
});

check("a skill names the command a person would actually type", () => {
  // A command is `/<plugin>:<file>`, and both halves are computed: the plugin drops a
  // trailing `-flow`, the command drops the plugin's own prefix. So sdlc-flow's tldr skill
  // is typed `/sdlc:tldr`.
  //
  // Twelve places said `/zz:sdlc-tldr` — the namespace from when every flow shipped inside
  // one `zz` plugin. The `zz` plugin carries the router skill and NO commands, so every one
  // of those named a command that cannot exist, in when_to_use fields a model reads and
  // headings a person reads. The generated command file had been fixed and carries a comment
  // about the mistake; the skills describing those commands had not, and neither had the
  // setup text the package hands a person on install.
  //
  // Checked against the real derivation rather than against a list of known-bad strings.
  if (NAMING.error) return NAMING.error;
  const { pluginName, commandName } = NAMING;
  const bad = [];
  // Every package with skills, INCLUDING one that ships no manifest: a skills-only package
  // is packaged too, and its skills become commands the same way.
  for (const pkg of catalogPackages) {
    const skillsDir = join(pkg.dir, "skills");
    if (!existsSync(skillsDir)) continue;
    const plugin = pluginName(pkg.flow);
    const right = new Map(readdirSync(skillsDir).map((sk) => [sk, `/${plugin}:${commandName(plugin, sk)}`]));
    for (const sk of readdirSync(skillsDir)) {
      const md = join(skillsDir, sk, "SKILL.md");
      if (!existsSync(md)) continue;
      for (const m of readFileSync(md, "utf8").matchAll(/\/([a-z0-9-]+):([a-z0-9-]+)/g)) {
        const named = `/${m[1]}:${m[2]}`;
        // Only claims about THIS package's own skills. A skill may legitimately name
        // another plugin's command, and a URL scheme is not a command at all.
        const target = [...right.keys()].find((k) => right.get(k) === named || named.endsWith(`:${k}`));
        if (!target) continue;
        if (right.get(target) !== named) {
          bad.push(`${pkg.owner}/${pkg.flow}/${sk} says ${named}; the command is ${right.get(target)}`);
        }
      }
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("no skill names a package file the packager does not emit", () => {
  // The check above reads `/plugin:command` strings. A skill can also name the FILE — and
  // sdlc-deck did, telling the reader it is installed as `commands/sdlc-deck.md` so it can
  // resolve its template relative to the plugin root. The packager emits
  // `commands/${commandName(plugin, skill)}.md`, which is `commands/deck.md`; the prefix the
  // command name drops is dropped from the filename too, because they are the same name.
  //
  // The consequence is not cosmetic. That table exists so the skill can find
  // `../skills/sdlc-deck/deck-chassis.html` from where it is actually reading, and a deck
  // built without the chassis is the one failure the skill says to stop on. The string form
  // had already been corrected across twelve places; this form reads as a path rather than a
  // command, so the same sweep did not see it.
  if (NAMING.error) return NAMING.error;
  const { pluginName, commandName } = NAMING;
  const bad = [];
  for (const pkg of catalogPackages) {
    const skillsDir = join(pkg.dir, "skills");
    if (!existsSync(skillsDir)) continue;
    const plugin = pluginName(pkg.flow);
    const own = readdirSync(skillsDir).filter((sk) => existsSync(join(skillsDir, sk, "SKILL.md")));
    for (const sk of own) {
      const text = readFileSync(join(skillsDir, sk, "SKILL.md"), "utf8");
      for (const m of text.matchAll(/commands\/([a-z0-9-]+)\.md/g)) {
        // Only claims about a skill THIS package ships. Naming another plugin's file is
        // somebody else's business, and an unrelated path is not a claim at all.
        const target = own.find((k) => k === m[1] || commandName(plugin, k) === m[1]);
        if (!target) continue;
        const right = `commands/${commandName(plugin, target)}.md`;
        if (`commands/${m[1]}.md` !== right) {
          bad.push(`${pkg.owner}/${pkg.flow}/${sk} names commands/${m[1]}.md; the packager writes ${right}`);
        }
      }
      for (const m of text.matchAll(/skills\/([a-z0-9-]+)\/SKILL\.md/g)) {
        // Skills keep their full name in the package; only the command form is shortened.
        if (!own.includes(m[1]) && own.some((k) => commandName(plugin, k) === m[1])) {
          bad.push(`${pkg.owner}/${pkg.flow}/${sk} names skills/${m[1]}/SKILL.md; skills keep their full name`);
        }
      }
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("a re-entry section names the tool that can change an approved document", () => {
  // An approved gated document changes through revise_document; write_file and patch_file are
  // refused on it, because a signature has to cover the bytes it signed.
  //
  // Re-entry is where this always bites, and it is identifiable rather than guessable: a stage
  // re-entered from verification is by definition working on a document a stakeholder already
  // approved. sm-spec and sm-plan both said "amend it in place" there — the plan section says
  // one line above that "the stakeholder approved the old one" — so the skill routed the agent
  // into a refusal, and before the guard existed, into something worse: a silent write leaving
  // the approver's name over text they never read.
  //
  // Judged on the SECTION HEADING, not on whether the prose contains the word "approved".
  // The first version of this check read the word, and "**Not approved** -> amend the plan in
  // place" is the draft case where patching is exactly right — it called a correct line a
  // defect. A heading says which situation the section is about; a keyword does not.
  const RE_ENTRY = /^##+ .*(coming back|re-?enter|re-?entry|arrived here|back from verification)/im;
  const bad = [];
  for (const f of flows) {
    const fj = join(f.dir, "flow.json");
    const skillsDir = join(f.dir, "skills");
    if (!existsSync(skillsDir)) continue;
    const gated = (JSON.parse(readFileSync(fj, "utf8")).documents ?? [])
      .filter((d) => d.gate).map((d) => d.name);
    if (!gated.length) continue;
    for (const sk of readdirSync(skillsDir)) {
      const md = join(skillsDir, sk, "SKILL.md");
      if (!existsSync(md)) continue;
      for (const sec of readFileSync(md, "utf8").split(/\n(?=##+ )/)) {
        if (!RE_ENTRY.test(sec)) continue;
        if (!/\b(amend|revise|update|change)\b/i.test(sec)) continue;
        // Only when the section acts on a document that actually carries a gate.
        const docs = gated.filter((n) => sec.includes(n) || sec.includes(n.replace(/\.md$/, "")));
        if (docs.length && !/revise_document/.test(sec)) {
          bad.push(`${f.owner}/${f.flow}/${sk} re-entry touches ${docs.join(", ")} without naming revise_document`);
        }
      }
    }
  }
  return bad.length
    ? `${bad.join("; ")} — a re-entered stage works on a document the stakeholder already ` +
      "approved, and write_file and patch_file are refused there"
    : null;
});

check("no skill offers a choice the manifest does not allow", () => {
  // sectionCheck refuses the APPROVAL of a gated document missing any heading its manifest
  // declares — drafts may be half-written, but a document offered as done may not. sdlc-spec
  // meanwhile said "emit all eight unless the person narrowed them", told the agent to write
  // the omission into the document, and sdlc-spec-audit had an UNLESS clause for exactly
  // that case.
  //
  // So a narrowed spec wrote cleanly and was refused at the gate. That is the worst place to
  // discover a rule: the work is finished, the person has agreed, and the refusal arrives
  // after both. Two skills offering a choice the platform does not have is worse than either
  // one being wrong, because it reads as considered.
  //
  // The shape: a skill that names a document with declared sections, and offers to leave one
  // out. Presence is the manifest's to decide; whether a section says anything is the
  // auditor's, and that is the finding worth keeping.
  const bad = [];
  for (const f of flows) {
    const fj = join(f.dir, "flow.json");
    const skillsDir = join(f.dir, "skills");
    if (!existsSync(skillsDir)) continue;
    const withSections = (JSON.parse(readFileSync(fj, "utf8")).documents ?? [])
      .filter((d) => (d.sections ?? []).length);
    if (!withSections.length) continue;
    for (const sk of readdirSync(skillsDir)) {
      const md = join(skillsDir, sk, "SKILL.md");
      if (!existsSync(md)) continue;
      const text = readFileSync(md, "utf8");
      if (!withSections.some((d) => text.includes(d.name) || text.includes(d.name.replace(/\.md$/, "")))) continue;
      for (const [i, line] of text.split("\n").entries()) {
        // A SUBSET BY ANY NAME. This looked for omit-words only, and sdlc-spec's Phase B —
        // the instruction an agent actually follows — said "the title and EVERY heading of the
        // REQUESTED components" and "all eight only when all eight were requested". Neither is
        // an omit-word, and both were survivors of the correction three paragraphs above them,
        // which had already established that the platform refuses the approval of a spec
        // missing one. A spec written from Phase B emitted a subset, wrote cleanly as a draft,
        // and was refused at the gate — exactly the cost the correction describes.
        if (/\b(omit|omission|left out|narrow(ed|ing)?|subset|requested|agreed|selected|chosen)\b/i.test(line)
            && /\b(component|section|heading)/i.test(line)
            // Saying the platform REFUSES an omission is the correct statement of the rule.
            && !/refus|cannot|must|no exception|always|every time/i.test(line)
            // A FIELD is not a section. sdlc-review says to "OMIT `line`" from a finding
            // while mentioning a section heading in the same breath — the shape of a
            // report, nothing to do with a document's components. The tell is the
            // backticked identifier the omit-word takes as its object.
            && !/\b(omit|leave out)\s+`[a-z_]+`/i.test(line)) {
          bad.push(`${f.owner}/${f.flow}/${sk}:${i + 1} offers to leave a declared section out`);
        }
      }
    }
  }
  return bad.length
    ? `${[...new Set(bad)].join("; ")} — the manifest declares those sections and the platform ` +
      "refuses the approval without them, so the choice does not exist"
    : null;
});

check("a skill a person types is not one a model is told to load", () => {
  // `standalone` promotes a skill into a Claude Code command, and the promotion is not
  // additive: standaloneCommandFile writes `disable-model-invocation: true` and the SKILL.md
  // is dropped from the package, because the method ships exactly once. So a skill that
  // ANOTHER skill instructs a model to load must never be standalone — the command still
  // exists, the person can still type it, and the instruction to load it silently stops
  // working. Nothing about the package build fails; the route just goes quiet.
  //
  // Nearly shipped: zz-journal was declared standalone here while `zz-kb-usage` says "read
  // `zz-journal` first", which is the platform's own flow-agnostic path into the journal.
  //
  // A reference that names the COMMAND (`/sdlc:deck`) is the correct way to point at a
  // standalone skill and is not a load, which is why this reads the verb rather than the name.
  const standalone = new Map();   // skill -> flow that declares it
  for (const f of flows) {
    const m = JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8"));
    for (const n of m.standalone ?? []) standalone.set(n, f.flow);
  }
  if (!standalone.size) return null;
  const bad = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    const src = readFileSync(join(root, rel), "utf8");
    const self = rel.split("/").at(-2);
    for (const m of src.matchAll(/\b(?:load|read)\s+`([a-z][a-z0-9-]+)`/gi)) {
      const target = m[1];
      if (target === self || !standalone.has(target)) continue;
      bad.push(`${rel} tells a model to load '${target}', which ${standalone.get(target)} ` +
               `declares standalone — promotion makes it person-typed only`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a skill citing another's section cites one that is there", () => {
  // Three skills read `learnings.md` by section NUMBER and TITLE — sm-select wants section 4
  // ("platform gaps"), sm-spec wants 5 ("stakeholder patterns") and 6 ("repeated-question
  // candidates"). zz-knowledge is what writes that file, as a numbered list in its own text, and
  // nothing tied the two together: renumbering the list, or renaming an item, sends a reader
  // to a section that is not there and nothing says so.
  //
  // Found by changing zz-knowledge's section 4 and leaving sm-select describing what it used to
  // say. The citation still resolved by number, so only the description was wrong — which is
  // the version of this that no reader catches, because the section exists.
  //
  // The producing list is found by content, not by filename: any numbered `N. **Title**` list
  // in any shipped skill counts, so moving a document's definition to another skill keeps
  // working and renumbering it does not.
  const lists = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    const src = readFileSync(join(root, rel), "utf8");
    const items = new Map();
    for (const m of src.matchAll(/^(\d+)\.\s+\*\*([^*]+)\*\*/gm)) items.set(Number(m[1]), m[2].trim());
    if (items.size > 1) lists.push({ rel, items });
  }
  const bad = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    const src = readFileSync(join(root, rel), "utf8");
    for (const m of src.matchAll(/section (\d+) \("([^"]+)"\)/g)) {
      const [, nStr, title] = m;
      const n = Number(nStr);
      const ok = lists.some((l) => (l.items.get(n) ?? "").toLowerCase() === title.toLowerCase());
      if (!ok) {
        // The useful hint is where that TITLE actually sits, not what every list happens to
        // hold at N — a renumbering is the common cause and the fix is the new number.
        const moved = lists.flatMap((l) => [...l.items]
          .filter(([, t]) => t.toLowerCase() === title.toLowerCase())
          .map(([at]) => `${l.rel} has it at ${at}`));
        bad.push(`${rel} cites section ${n} ("${title}")` +
                 (moved.length ? ` — ${moved.join(", ")}` : ", and no skill's numbered list has that title"));
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a skill describing acceptance describes the honest close too", () => {
  // `close()` has two honest endings for finished work: somebody accepted it, or nobody did
  // and one line says why. Its own description states the design — "closing without an
  // acceptor is a legitimate route and costs a sentence... an honest close is never the
  // expensive one, but it is never free either" — and the whole point is that the cheap word
  // must never be the only one an agent can see.
  //
  // sm-build said "the platform refuses that close, because every outcome needs an
  // `accepted_by` you cannot honestly supply". Both halves wrong: the close is refused
  // because guide.md is requiredForClose, and an acceptor is optional. An agent that believed
  // it would go looking for a name to get past a guardrail — inventing the acceptance that
  // attributionCheck, closeCheck and the outcome derivation all exist to make impossible.
  //
  // So: name the acceptor and you must name the other route in the same file.
  const bad = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    const src = readFileSync(join(root, rel), "utf8");
    if (!src.includes("accepted_by")) continue;
    if (/no_signoff_reason|nobody signed off|nobody named|without an acceptor/.test(src)) continue;
    bad.push(`${rel} tells an agent to name an acceptor and never says a close without one is ` +
             `a route — the only way past it then looks like finding a name`);
  }
  return bad.length ? bad.join("; ") : null;
});
