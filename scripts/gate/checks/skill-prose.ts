/**
 * What a skill's text may and may not say — its claims, not its shape or its arithmetic.
 * A skill that justifies itself by machinery this platform does not have, that tells an
 * agent to write a document with a local-file tool, that names a repository path nobody
 * ships, or that instructs a model to refuse a person's own words.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { firstOf, root, sourceFiles } from "../read.ts";
import { check } from "../run.ts";
import { NAMING, catalogPackages, declaredCommands, everyShippedSkill, flows, ownedFields, platformSkills, skillsOf } from "../facts.ts";

check("a skill_read a skill spells out names a skill that exists", () => {
  // `skill_read("X")` is an instruction to load X, not a citation, so it is checked
  // directly. The prefix check below covers a backticked sibling name, which is what a
  // citation looks like within a flow; it cannot cover a cross-family name.
  //
  // The `file:` form is out of scope here — "a skill never instructs a tool its package
  // cannot reach" is where file paths are answered.
  const bad: string[] = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    const txt = readFileSync(join(root, rel), "utf8");
    for (const m of txt.matchAll(/skill_read\(\s*["'`]([a-z0-9][a-z0-9-]*)["'`]/g)) {
      if (!everyShippedSkill().has(m[1])) bad.push(`${rel} -> skill_read("${m[1]}")`);
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("no skill references a skill that is not shipped", () => {
  const bad: string[] = [];
  for (const f of flows) {
    const have = new Set(skillsOf(f).map((s) => s.name));
    if (have.size === 0) continue;
    // A backticked `<flow-prefix>-name` is an identifier the reader is expected to load.
    // Prose mentions are written without backticks, which is the convention that lets this
    // check mean something.
    //
    // The prefix comes from the skill names themselves, not from the flow's name: a flow is
    // not always called `<x>-flow` with skills named `<x>-…` — zz-plugin-eval ships
    // `zz-plugin-*` skills.
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
        // Shipped anywhere, not just by this flow: a cross-flow citation is legitimate, so
        // a check that knew only one flow's skills would call every one a defect.
        if (!have.has(m[1]) && !everyShippedSkill().has(m[1])) bad.push(`${s.name} -> ${m[1]}`);
      }
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("no skill justifies itself by machinery this platform does not have", () => {
  // Each pattern names something this platform does not have: no renderer, no `execute_plan`
  // tool, no validator, no pipeline. `@include` is here because nothing expands one —
  // skill_read returns the file verbatim, so the directive ships as literal text.
  // sdlc-execute's caller writes each check to its path before dispatching the task that
  // must pass it, and the executor is a person or an agent following a skill.
  const GHOSTS = [/\brenderer\b/, /\bexecute_plan\b/, /\bthe validator\b/, /\bPer FR-\d/,
                  /^@include\b/, /\bthe pipeline\b/, /\bregistered Method\b/, /\bsoftware-change@/,
                  // Another project's architecture, describing what this one does not add.
                  // There is no task type here and no HTTP route a skill could add.
                  /\btask type\b/, /\bserver schema\b/];
  const bad: string[] = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    readFileSync(join(root, rel), "utf8").split("\n").forEach((line, i) => {
      for (const g of GHOSTS) {
        if (g.test(line)) bad.push(`${rel}:${i + 1} cites ${g.source.replace(/\\b/g, "")}`);
      }
    });
  }
  // Eight at a time, and the cap reports itself rather than slicing silently.
  return firstOf(bad);
});

check("no skill writes a document with a local-file tool", () => {
  // `Write`/`Edit`/`MultiEdit`/`NotebookEdit` are the runtime's local file tools. The
  // platform's documents live in the initiative store and are written with document_write /
  // document_patch; a document written to a local path has no envelope, no version snapshot
  // at approval and no telemetry, and it looks exactly like success.
  const LOCAL = /`(Write|Edit|MultiEdit|NotebookEdit)`/g;
  const bad: string[] = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    readFileSync(join(root, rel), "utf8").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(LOCAL)) {
        bad.push(`${rel}:${i + 1} names \`${m[1]}\` — documents are written with document_write / document_patch`);
      }
    });
  }
  return firstOf(bad);
});

check("a skill that ships an asset does not say the asset is beside it", () => {
  // A skill the manifest declares as a command is promoted: its SKILL.md becomes
  // commands/<command>.md and only the text moves — assets stay in skills/<name>/. So "next to
  // this file" is false for a promoted skill.
  const bad: string[] = [];
  for (const f of flows) {
    const m = JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8"));
    for (const name of Object.values(m.commands ?? {}) as string[]) {
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

check("every stage that writes a document names document_present, or says why not", () => {
  // A stage that writes a document either names document_present or states a departure from
  // it in one of the phrasings the regex below accepts.
  const bad: string[] = [];
  for (const f of flows) {
    const mf = join(f.dir, "flow.json");
    if (!existsSync(mf)) continue;
    const m = JSON.parse(readFileSync(mf, "utf8"));
    for (const d of m.documents ?? []) {
      if (!d.stage) continue;
      const sk = join(f.dir, "skills", d.stage, "SKILL.md");
      if (!existsSync(sk)) { bad.push(`${f.owner}/${f.flow}: ${d.stage} declares no SKILL.md`); continue; }
      const text = readFileSync(sk, "utf8");
      if (!/document_present/.test(text) && !/do not paste|does not paste|present .{0,40}differently/i.test(text)) {
        bad.push(`${f.owner}/${f.flow}/${d.stage} writes ${d.name} but neither names document_present nor states a departure`);
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a skill citing another document's section cites one that exists", () => {
  // Skills send each other to numbered sections of documents other skills produce. The
  // templates declare their sections as `N. **Title**`, and a citation must agree with a
  // declaration on both the number and the name.
  const declared = new Map();          // number -> Set of titles declared anywhere
  const skillFiles = sourceFiles(["catalog", "skills"], ["SKILL.md"]);
  for (const rel of skillFiles) {
    for (const m of readFileSync(join(root, rel), "utf8").matchAll(/^(\d+)\.\s+\*\*([^*]+)\*\*/gm)) {
      if (!declared.has(m[1])) declared.set(m[1], new Set());
      declared.get(m[1]).add(m[2].trim().toLowerCase());
    }
  }
  const bad: string[] = [];
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
  // COUPLED: `scripts/gate/checks/docs-integrity.ts` runs the same path check over release
  // documents and skips catalog/ and skills/, which are versioned by digest rather than
  // dated. This one covers those two, and matches a path with or without backticks.
  const bad: string[] = [];
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
  // "Your FINAL text response must be exactly one JSON block" is a worker's contract, read
  // by the caller that dispatched it. In a main-agent skill the final response goes to a
  // person instead. A skill that demands it must say, in its own description, that it is
  // dispatched.
  const bad: string[] = [];
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
  // A phrase whitelist near an approval — "approved", not "ok" — makes a person repeat a
  // decision they already made. DELIBERATE: this matches the shape of such a whitelist, not
  // opinions about approvals, so a flow that states a stricter rule in its own words passes.
  const bad: string[] = [];
  for (const f of [...flows, { dir: null }]) {
    for (const sk of (f.dir === null ? platformSkills() : skillsOf(f))) {
      for (const m of readFileSync(sk.path, "utf8").matchAll(/^.*\bapprov\w*\b.*$/gim)) {
        const line = m[0].trim();
        // Three shapes: a list of accepted words beside a list of rejected ones is the
        // defect, however the sentence is built.
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
  // zz-core refuses a write that moves a platform-owned field by hand, so a template
  // carrying one produces a refusal on the first save of the first document.
  //
  // Inside a fence, the test is the field as a key at the start of a line. Outside one, the
  // test is different: prose naming a field is how these skills explain the rule, so what is
  // matched is an imperative verb and the field in the same sentence.
  const OWNED = new RegExp(`^\\s*(${ownedFields().join("|")})\\s*:`);
  const ENVELOPE_KEY = /^\s*(flow|type|version|updated_at|accepted_by|no_signoff_reason)\s*:/;
  const OWNED_INLINE = new RegExp(
    `(record|write|set|put|add|patch|fill|stamp)\\b.{0,90}?\`(${ownedFields().join("|")})\\s*:`, "is");
  // The sentence is describing the platform's behaviour, not asking for it.
  const DESCRIBES = /platform|refus|by hand|document_approve\(|initiative_close\(|stamp|stays|never|not by/i;
  const bad: string[] = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    let fenced = false;
    for (const [i, line] of readFileSync(join(root, rel), "utf8").split("\n").entries()) {
      if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
      if (fenced && OWNED.test(line)) {
        bad.push(`${rel}:${i + 1} templates \`${line.trim().split(":")[0]}\``);
      }
      // Any envelope key in a fenced block, not only the ones the platform owns: a `flow:`
      // or `type:` shown in a yaml block still teaches a stage to write the envelope by
      // hand, and neither key is owned in the refusing sense.
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
      "the first save. Say document_approve() or initiative_close() instead."
    : null;
});

check("a skill names the command a person would actually type", () => {
  // A command is `/<plugin>:<file>`. The plugin half is computed — a trailing `-flow` is
  // dropped — and the command half is declared, in the manifest's `commands` map. So
  // zz-core's tldr skill is typed `/zz-core:tldr` because flow.json says `"tldr": "zz-tldr"`.
  //
  // Checked against the real declaration, so two ways to be wrong are caught: naming the
  // wrong string for a command that exists, and naming a command for a skill the manifest
  // declares none for.
  if (NAMING.error || !NAMING.pluginName) return NAMING.error ?? "NAMING has no pluginName";
  const { pluginName } = NAMING;
  const bad: string[] = [];
  // Every package with skills, including one that ships no manifest: such a package declares
  // no commands, so naming one of its skills as a command names a file the packager does not
  // write.
  for (const pkg of catalogPackages) {
    const skillsDir = join(pkg.dir, "skills");
    if (!existsSync(skillsDir)) continue;
    const plugin = pluginName(pkg.flow);
    const cmds = declaredCommands(pkg);
    const shipped = readdirSync(skillsDir);
    const right = new Map([...cmds].map(([sk, cmd]) => [sk, `/${plugin}:${cmd}`]));
    for (const sk of shipped) {
      const md = join(skillsDir, sk, "SKILL.md");
      if (!existsSync(md)) continue;
      for (const m of readFileSync(md, "utf8").matchAll(/\/([a-z0-9-]+):([a-z0-9-]+)/g)) {
        const named = `/${m[1]}:${m[2]}`;
        // Only claims about this package's own skills: naming another plugin's command is
        // legitimate, and a URL scheme is not a command at all.
        const target = shipped.find((k) => right.get(k) === named || named.endsWith(`:${k}`));
        if (!target) continue;
        const want = right.get(target);
        if (!want) {
          bad.push(`${pkg.owner}/${pkg.flow}/${sk} says ${named}; ${pkg.flow} declares no ` +
                   `command for '${target}', so no such command exists`);
        } else if (want !== named) {
          bad.push(`${pkg.owner}/${pkg.flow}/${sk} says ${named}; the command is ${want}`);
        }
      }
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("no skill names a package file the packager does not emit", () => {
  // The check above reads `/plugin:command` strings; a skill can also name the file. The
  // packager emits `commands/<the manifest's key>.md`, so the file is named by the command
  // and not by the skill. A skill resolves its assets relative to where it is installed, so
  // naming the wrong file makes it look in the wrong place.
  const bad: string[] = [];
  for (const pkg of catalogPackages) {
    const skillsDir = join(pkg.dir, "skills");
    if (!existsSync(skillsDir)) continue;
    const cmds = declaredCommands(pkg);
    const own = readdirSync(skillsDir).filter((sk) => existsSync(join(skillsDir, sk, "SKILL.md")));
    for (const sk of own) {
      const text = readFileSync(join(skillsDir, sk, "SKILL.md"), "utf8");
      for (const m of text.matchAll(/commands\/([a-z0-9-]+)\.md/g)) {
        // Only claims about a skill this package ships: another plugin's file is somebody
        // else's business, and an unrelated path is not a claim at all.
        const target = own.find((k) => k === m[1] || cmds.get(k) === m[1]);
        if (!target) continue;
        const cmd = cmds.get(target);
        if (!cmd) {
          bad.push(`${pkg.owner}/${pkg.flow}/${sk} names commands/${m[1]}.md; ${pkg.flow} ` +
                   `declares no command for '${target}', so the packager writes no such file`);
        } else if (m[1] !== cmd) {
          bad.push(`${pkg.owner}/${pkg.flow}/${sk} names commands/${m[1]}.md; the packager ` +
                   `writes commands/${cmd}.md`);
        }
      }
      for (const m of text.matchAll(/skills\/([a-z0-9-]+)\/SKILL\.md/g)) {
        // Skills keep their full name in the package; only the command form is the map's key.
        if (!own.includes(m[1]) && own.some((k) => cmds.get(k) === m[1])) {
          bad.push(`${pkg.owner}/${pkg.flow}/${sk} names skills/${m[1]}/SKILL.md; skills keep their full name`);
        }
      }
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("a re-entry section names the tool that can change an approved document", () => {
  // An approved gated document changes through document_revise; document_write and
  // document_patch are refused on it, because a signature has to cover the bytes it signed.
  // A stage re-entered from verification is by definition working on such a document.
  //
  // Judged on the section heading, not on whether the prose contains the word "approved":
  // "**Not approved** -> amend the plan in place" is the draft case, where patching is right.
  const RE_ENTRY = /^##+ .*(coming back|re-?enter|re-?entry|arrived here|back from verification)/im;
  const bad: string[] = [];
  for (const f of flows) {
    const fj = join(f.dir, "flow.json");
    const skillsDir = join(f.dir, "skills");
    if (!existsSync(skillsDir)) continue;
    const gated = (JSON.parse(readFileSync(fj, "utf8")).documents ?? [])
      .filter((d: { gate?: boolean }) => d.gate).map((d: { name: string }) => d.name);
    if (!gated.length) continue;
    for (const sk of readdirSync(skillsDir)) {
      const md = join(skillsDir, sk, "SKILL.md");
      if (!existsSync(md)) continue;
      for (const sec of readFileSync(md, "utf8").split(/\n(?=##+ )/)) {
        if (!RE_ENTRY.test(sec)) continue;
        if (!/\b(amend|revise|update|change)\b/i.test(sec)) continue;
        // Only when the section acts on a document that actually carries a gate.
        const docs = gated.filter((n: string) => sec.includes(n) || sec.includes(n.replace(/\.md$/, "")));
        if (docs.length && !/document_revise/.test(sec)) {
          bad.push(`${f.owner}/${f.flow}/${sk} re-entry touches ${docs.join(", ")} without naming document_revise`);
        }
      }
    }
  }
  return bad.length
    ? `${bad.join("; ")} — a re-entered stage works on a document the stakeholder already ` +
      "approved, and document_write and document_patch are refused there"
    : null;
});

check("no skill offers a choice the manifest does not allow", () => {
  // sectionCheck refuses the approval of a gated document missing any heading its manifest
  // declares — drafts may be half-written, a document offered as done may not. So a skill
  // that offers to leave one out sends the agent into a refusal at the gate.
  //
  // The shape matched: a skill that names a document with declared sections, and offers to
  // leave one out. Presence is the manifest's to decide; whether a section says anything is
  // the auditor's.
  const bad: string[] = [];
  for (const f of flows) {
    const fj = join(f.dir, "flow.json");
    const skillsDir = join(f.dir, "skills");
    if (!existsSync(skillsDir)) continue;
    const withSections = (JSON.parse(readFileSync(fj, "utf8")).documents ?? [])
      .filter((d: { sections?: string[] }) => (d.sections ?? []).length);
    if (!withSections.length) continue;
    for (const sk of readdirSync(skillsDir)) {
      const md = join(skillsDir, sk, "SKILL.md");
      if (!existsSync(md)) continue;
      const text = readFileSync(md, "utf8");
      if (!withSections.some((d: { name: string }) => text.includes(d.name) || text.includes(d.name.replace(/\.md$/, "")))) continue;
      for (const [i, line] of text.split("\n").entries()) {
        // A subset by any name, not just an omit-word: "every heading of the requested
        // components" describes a subset without naming an omission.
        if (/\b(omit|omission|left out|narrow(ed|ing)?|subset|requested|agreed|selected|chosen)\b/i.test(line)
            && /\b(component|section|heading)/i.test(line)
            // Saying the platform refuses an omission is the correct statement of the rule.
            && !/refus|cannot|must|no exception|always|every time/i.test(line)
            // A field is not a section; the tell is the backticked identifier the omit-word
            // takes as its object.
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
  // `commands` promotes a skill into a Claude Code command, and the promotion is not
  // additive: standaloneCommandFile writes `disable-model-invocation: true` and the SKILL.md
  // is dropped from the package. So a skill that another skill instructs a model to load
  // must never be named in `commands` — the command still exists and a person can type it,
  // but the instruction to load it stops working and nothing about the build fails.
  //
  // A reference that names the command (`/sdlc:deck`) is the correct way to point at a
  // promoted skill and is not a load, which is why this reads the verb rather than the name.
  const promoted = new Map();   // skill -> flow that declares a command for it
  for (const f of flows) {
    const m = JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8"));
    for (const n of Object.values(m.commands ?? {})) promoted.set(n, f.flow);
  }
  if (!promoted.size) return null;
  const bad: string[] = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    const src = readFileSync(join(root, rel), "utf8");
    const self = rel.split("/").at(-2);
    for (const m of src.matchAll(/\b(?:load|read)\s+`([a-z][a-z0-9-]+)`/gi)) {
      const target = m[1];
      if (target === self || !promoted.has(target)) continue;
      bad.push(`${rel} tells a model to load '${target}', which ${promoted.get(target)} ` +
               `declares as a command — promotion makes it person-typed only`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a skill citing another's section cites one that is there", () => {
  // Skills read documents other skills write by section number and title, so renumbering the
  // producing list, or renaming an item, sends a reader to a section that is not there.
  // Matching the title as well as the number catches the rename, which resolves by number
  // and so looks correct.
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
  const bad: string[] = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    const src = readFileSync(join(root, rel), "utf8");
    for (const m of src.matchAll(/section (\d+) \("([^"]+)"\)/g)) {
      const [, nStr, title] = m;
      const n = Number(nStr);
      const ok = lists.some((l) => (l.items.get(n) ?? "").toLowerCase() === title.toLowerCase());
      if (!ok) {
        // The hint is where that title actually sits, not what every list holds at N: a
        // renumbering is the common cause and the fix is the new number.
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
  // `initiative_close()` has two honest endings for finished work: somebody accepted it, or
  // nobody did and one line says why. An acceptor is optional. A skill that names only the
  // first route leaves an agent looking for a name to get past a guardrail, which is the
  // invented acceptance attributionCheck, closeCheck and the outcome derivation exist to
  // make impossible. So: name the acceptor and you must name the other route in the same
  // file.
  const bad: string[] = [];
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    const src = readFileSync(join(root, rel), "utf8");
    if (!src.includes("accepted_by")) continue;
    if (/no_signoff_reason|nobody signed off|nobody named|without an acceptor/.test(src)) continue;
    bad.push(`${rel} tells an agent to name an acceptor and never says a close without one is ` +
             `a route — the only way past it then looks like finding a name`);
  }
  return bad.length ? bad.join("; ") : null;
});
