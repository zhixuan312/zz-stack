/**
 * What a flow's manifest declares, against what its skills and the platform actually do —
 * stages, the sections a document owes, overlays.
 *
 * Nothing in a flow package fails when the two drift: the stage simply does something other
 * than what the manifest says.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { root, sourceFiles, withoutComments, zzCoreSource } from "../read.ts";
import { check } from "../run.ts";
import { flows } from "../facts.ts";

check("a document's requirement is met by the only thing its target can offer", () => {
  // Nothing approves a non-gated document: `gate: false` means no approval is required, so
  // such a document's status stays `draft` forever. A readiness predicate asking for
  // `status === "approved"` whatever the target is can never make a document that requires a
  // non-gated one `pending`.
  //
  // Checked two ways, because either alone is weak: the predicate must branch on `gate`, and
  // no flow in the catalog may depend on it not doing so.
  const src = zzCoreSource();
  const bad: string[] = [];
  const fn = /const requirementMet = [\s\S]*?\n      \};/.exec(src)?.[0] ?? "";
  if (!fn) {
    bad.push("initiative_status no longer resolves a requirement through requirementMet — " +
             "this check reads nothing");
  } else if (!/t\.gate \?/.test(fn)) {
    bad.push("requirementMet does not branch on `gate`, so a non-gated prerequisite is judged " +
             "by an approval that will never come and next_move falls through to close");
  }
  // COUPLED: initiative_status decides what to do next and gateCheck decides what may be
  // written. Fixing one alone tells the agent to write a document and then refuses the write.
  const gc = /function gateCheck\([\s\S]*?\n\}/.exec(src)?.[0] ?? "";
  if (!gc) {
    bad.push("gateCheck is gone — this check reads half of what it is for");
  } else if (!/\.gate === true/.test(gc)) {
    bad.push("gateCheck demands approval of a `requires` target without asking whether that " +
             "target is gated, so a flow whose prerequisite is ungated can never write its " +
             "next document — while initiative_status tells it to");
  }
  // And name the flows that actually have the shape, so the check reports something real
  // rather than only guarding a regex.
  const exposed = [];
  for (const f of flows) {
    const mf = join(f.dir, "flow.json");
    if (!existsSync(mf)) continue;
    const docs = JSON.parse(readFileSync(mf, "utf8")).documents ?? [];
    for (const d of docs) {
      if (!d.requires) continue;
      const target = docs.find((x: { name: string }) => x.name === d.requires);
      if (target && target.gate !== true) exposed.push(`${f.flow}: ${d.name} requires ${d.requires} (ungated)`);
    }
  }
  if (exposed.length && !fn) {
    bad.push(`and these declare the shape that breaks: ${exposed.join("; ")}`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("every flow declares which document closes it", () => {
  // closingDoc falls back to the last document when no `closing: true` is declared, so a
  // manifest that omits it still resolves — to whatever happens to be last.
  const bad: string[] = [];
  for (const f of flows) {
    const m = JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8"));
    const docs = m.documents ?? [];
    if (docs.length === 0) continue;
    const closing = docs.filter((d: { closing?: boolean }) => d.closing);
    if (closing.length === 0) bad.push(`${f.flow}: no document marked closing (would default to ${docs[docs.length - 1].name})`);
    if (closing.length > 1) bad.push(`${f.flow}: ${closing.length} documents marked closing`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("a document's declared stage is a stage its flow has", () => {
  // COUPLED: FlowDoc.stage is what the console draws its stepper from — `console/shared.ts`
  // derives what a stage writes from it. A typo points a document at a stage that does not
  // exist.
  const bad: string[] = [];
  for (const f of flows) {
    const mf = join(f.dir, "flow.json");
    if (!existsSync(mf)) continue;
    const m = JSON.parse(readFileSync(mf, "utf8"));
    const names = (m.stages ?? []).map((s: { name: string }) => s.name);
    for (const d of m.documents ?? []) {
      if (!d.stage) continue;
      if (!names.includes(d.stage)) {
        bad.push(`${f.owner}/${f.flow}: document ${d.name} declares stage "${d.stage}", which is not one of [${names.join(", ")}]`);
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("every section a manifest declares is taught by one of its skills", () => {
  // COUPLED: normalizeSections renames a near-miss heading to the one the manifest declares,
  // on every write. So a skill teaching a heading the manifest does not declare has its output
  // rewritten, and a section the manifest declares that no skill mentions is a heading the flow
  // requires and never asks anyone for.
  const bad: string[] = [];
  for (const f of flows) {
    const fj = join(f.dir, "flow.json");
    const skillsDir = join(f.dir, "skills");
    if (!existsSync(skillsDir)) continue;
    const manifest = JSON.parse(readFileSync(fj, "utf8"));
    const taught = readdirSync(skillsDir)
      .map((sk) => join(skillsDir, sk, "SKILL.md"))
      .filter((f) => existsSync(f))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const d of manifest.documents ?? []) {
      for (const sec of d.sections ?? []) {
        if (!taught.includes(sec)) {
          bad.push(`${f.owner}/${f.flow} declares ${d.name} section "${sec}" that no skill names`);
        }
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("no shell freezes one flow's fixture paths", () => {
  // The sibling of "no evaluation tool is wired to one flow", for the shell layer that drives
  // them: a launcher holding one flow's {requirements,steps,scenarios}.json as constants makes
  // a corpus authored for a second flow one nothing can run. The path comes from an argument.
  const dir = join(root, "testing");
  // Tracked, so its absence is a defect — see the same guard in build.ts.
  if (!existsSync(dir)) return "testing/ does not exist, so no stage caller could be read at all";
  const bad: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sh"))) {
    const lines = readFileSync(join(dir, f), "utf8").split("\n");
    const hits: number[] = [];
    lines.forEach((line, i) => {
      // A comment or a printed usage example names a path, it does not depend on one.
      if (/^\s*(#|printf|echo)/.test(line)) return;
      // catalog/$FLOW/... does not match: the owner segment must be a literal.
      if (/catalog\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/(tests|flow\.json)/.test(line)) hits.push(i + 1);
    });
    if (hits.length) {
      bad.push(`testing/${f}:${hits.join(",")} freezes one flow's fixture path — take it as an argument`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("no evaluation tool is wired to one flow", () => {
  // An evaluation tool that names one flow's directory can evaluate exactly that flow.
  //
  // The subject is derived, not a list of paths: `services/zz-core/src/eval/` — the modules
  // `eval-door.ts` mounts, which checks/eval-tools-moved.ts pins there — plus the testing tools
  // in `packages/tools`. A tool added to either is covered without editing this file.
  //
  // Comments stripped, because prose here legitimately names catalog paths. A comment
  // describing a path is not a tool wired to one.
  const bad: string[] = [];
  const FLOW_PATH = /catalog\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/;
  const files = [...sourceFiles(["services/zz-core/src/eval"], [".ts"]),
                 ...sourceFiles(["packages/tools/src"], [".ts"])];
  // The control: an empty subject list is a check that passes having examined nothing, which
  // is indistinguishable from a clean tree unless it says so.
  if (files.length < 10) {
    return `the evaluation surface scan found ${files.length} file(s), which is fewer than ` +
           "this platform has ever had — the clause below iterates that list, so this run " +
           "examined almost nothing. Point it at where the evaluation code went.";
  }
  for (const rel of files) {
    const code = withoutComments(readFileSync(join(root, rel), "utf8"));
    const hit = code.split("\n").findIndex((l) => FLOW_PATH.test(l));
    if (hit >= 0) {
      bad.push(`${rel}:${hit + 1} hardcodes ${FLOW_PATH.exec(code.split("\n")[hit])?.[0]}, so it ` +
               "can evaluate exactly one flow — take the package as an argument");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a team overlay adds and cannot replace", () => {
  // An overlay is appended to the skill, never substituted for it: the shelf's text is
  // returned first and entire, the team's follows under a heading naming it. Substitution is
  // not something the code can express, so no overlay can shadow zz-platform or take over a
  // stage.
  //
  // Reads for that shape — the platform's text concatenated ahead of the team's — because an
  // overlay that replaced would be a one-character change here.
  const src = withoutComments(zzCoreSource());
  const bad: string[] = [];
  if (!/readFileSync\(path, "utf8"\) \+ await teamOverlay\(name\)/.test(src)) {
    bad.push("skill_read no longer appends the team overlay to the skill — an overlay that is not appended is a replacement");
  }
  // It must read from the team's store, not from a skills root, or it would be competing
  // for the same names the platform's skills use.
  if (!/join\(await userRoot\(\), "overlays", name, "SKILL\.md"\)/.test(src)) {
    bad.push("the overlay no longer comes from the team's own overlays/ directory");
  }
  // The overlay rule is a platform rule and lives on the spine skill, so the check reads
  // skills/zz-platform rather than any one flow's usage skill.
  const usage = join(root, "skills/zz-platform/SKILL.md");
  if (!readFileSync(usage, "utf8").includes("overlays/")) {
    bad.push("no skill tells a team the overlay exists");
  }
  return bad.length ? bad.join("; ") : null;
});
