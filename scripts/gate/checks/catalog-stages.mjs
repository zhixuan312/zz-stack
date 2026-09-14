/**
 * What a flow's manifest DECLARES, against what its skills and the platform actually do —
 * stages, the blocks a stage may reach, scenarios, the sections a document owes, overlays.
 *
 * A manifest is a promise made in JSON to code that is not beside it. Nothing in the flow
 * package fails when the two drift; the stage simply does something other than what the
 * manifest says, and the person reading the manifest is the last to find out.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { between, root, sourceFiles, zzCoreSource } from "../read.mjs";
import { check } from "../run.mjs";
import { flows } from "../facts.mjs";

check("a selection stage requires the past-work lookup and names where it goes", () => {
  // An instruction that produces no artifact is one nothing can check, and this one had
  // already been skipped. ops-select §"Check what past initiatives learned about these blocks"
  // told the agent to search; the Output section did not require the answer to appear. On
  // 2026-08-27 two runs of the same scenario showed what that costs: one wrote what past work
  // recorded, took the six verified traps from casebox-stg-usage, and passed; the other did not,
  // and stalled on the base64-email-body trap that was already written down.
  //
  // The check is that the two halves agree. A skill that asks for the bullet must also name
  // the heading its answer goes under, because the bullet is what an author reads and the
  // heading is what a reader — or a later check — finds. Requiring one without the other is
  // the drift this exists to stop, in the file that stops it.
  const BULLET = /\*\*What past work recorded\*\*/;
  const HEADING = /`##+ ?What past work recorded`|^##+\s+What past work recorded\b/m;
  const bad = [];
  for (const f of flows) {
    const manifest = join(f.dir, "flow.json");
    const docs = JSON.parse(readFileSync(manifest, "utf8")).documents ?? [];
    // Only a flow that HAS a selection stage is a subject. A flow without one is not
    // failing to do this; it is not doing it, which is different.
    if (!docs.some((d) => d.role === "selection")) continue;
    const skills = join(f.dir, "skills");
    if (!existsSync(skills)) continue;
    for (const s of readdirSync(skills, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const md = join(skills, s.name, "SKILL.md");
      if (!existsSync(md)) continue;
      const text = readFileSync(md, "utf8");
      const asks = BULLET.test(text);
      const names = HEADING.test(text);
      if (asks && !names) {
        bad.push(`${s.name} requires the past-work bullet and never names the heading its ` +
                 `answer goes under — a reader cannot tell what to call it and no check can find it`);
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a document's requirement is met by the only thing its target can offer", () => {
  // NOTHING APPROVES A NON-GATED DOCUMENT. `gate: false` means no approval is required, so
  // such a document's status stays `draft` forever. initiative_status asked for
  // `status === "approved"` whatever the target was, so a document requiring a non-gated one
  // could never become `pending`; `awaiting` only fires for a document that already exists;
  // and both fell through to the close branch.
  //
  // sdlc-flow is that shape — explore.md (no gate) -> spec.md (gate, closing) -> plan.md
  // (gate) — so from the moment explore.md was written the platform told every agent to
  // close, with two of three documents absent and both of them gates. ops-flow never met it
  // because all of ITS requires-targets are gated, which is why it survived: the flow that
  // hits it is the one nobody had run end to end.
  //
  // Checked two ways, because either alone is weak: the predicate must branch on `gate`, and
  // no flow in the catalog may quietly depend on the old behaviour going unnoticed.
  const src = zzCoreSource();
  const bad = [];
  const fn = /const requirementMet = [\s\S]*?\n      \};/.exec(src)?.[0] ?? "";
  if (!fn) {
    bad.push("initiative_status no longer resolves a requirement through requirementMet — " +
             "this check reads nothing");
  } else if (!/t\.gate \?/.test(fn)) {
    bad.push("requirementMet does not branch on `gate`, so a non-gated prerequisite is judged " +
             "by an approval that will never come and next_move falls through to close");
  }
  // BOTH SITES, because they must agree. initiative_status decides what to do next and
  // gateCheck decides what may be written, and the first fix touched only the former — so the
  // platform told the agent to write spec.md and then refused the write. Two answers to one
  // question is worse than one wrong answer.
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
      const target = docs.find((x) => x.name === d.requires);
      if (target && target.gate !== true) exposed.push(`${f.flow}: ${d.name} requires ${d.requires} (ungated)`);
    }
  }
  if (exposed.length && !fn) {
    bad.push(`and these declare the shape that breaks: ${exposed.join("; ")}`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("every flow declares which document closes it", () => {
  // closingDoc falls back to the LAST document when no `closing: true` is declared, so a
  // manifest that omits it still resolves — to whatever happens to be last. sdlc-flow
  // silently made plan.md its closing record that way: the plan, treated as the outcome.
  const bad = [];
  for (const f of flows) {
    const m = JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8"));
    const docs = m.documents ?? [];
    if (docs.length === 0) continue;
    const closing = docs.filter((d) => d.closing);
    if (closing.length === 0) bad.push(`${f.flow}: no document marked closing (would default to ${docs[docs.length - 1].name})`);
    if (closing.length > 1) bad.push(`${f.flow}: ${closing.length} documents marked closing`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("a document's declared stage is a stage its flow has", () => {
  // FlowDoc.stage is what the console draws its stepper from and what eval-grade reads its
  // step-to-role map from. Nothing has ever checked that it resolves, so a typo has always been
  // able to point a document at a stage that does not exist.
  const bad = [];
  for (const f of flows) {
    const mf = join(f.dir, "flow.json");
    if (!existsSync(mf)) continue;
    const m = JSON.parse(readFileSync(mf, "utf8"));
    const names = (m.stages ?? []).map((s) => s.name);
    for (const d of m.documents ?? []) {
      if (!d.stage) continue;
      if (!names.includes(d.stage)) {
        bad.push(`${f.owner}/${f.flow}: document ${d.name} declares stage "${d.stage}", which is not one of [${names.join(", ")}]`);
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a stage's blocks are ones its flow carries", () => {
  // `tools` is what the CLIENT PACKAGE CARRIES; a stage's `blocks` is what THAT STAGE MAY
  // CALL, enforced per call at the proxy. A stage declaring a block the flow does not carry
  // is a manifest describing a flow nobody can run: the agent is provisioned without that
  // block's MCP server, so the authority is granted for a call that cannot be made.
  //
  // It fails silently in the direction that matters. The proxy would ALLOW the call — the
  // stage says so — and the agent simply has no tool to make it with, which reads to whoever
  // is watching as the block being broken rather than as a manifest that never agreed with
  // itself.
  const bad = [];
  for (const f of flows) {
    const m = JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8"));
    const carries = new Set(m.tools ?? []);
    const selects = (m.documents ?? []).some((d) => d.role === "selection");
    for (const st of m.stages ?? []) {
      if (st.blocks === undefined) continue;
      if (st.blocks === "selected") {
        // "selected" resolves through the initiative's selection document. A flow with no
        // such document has nothing for it to resolve THROUGH, so the stage would fall back
        // to unenforced — a declaration that reads as a constraint and is not one.
        if (!selects) {
          bad.push(`${f.flow}: stage '${st.name}' declares blocks "selected" and the flow ` +
                   `declares no document with role "selection"`);
        }
        continue;
      }
      for (const b of st.blocks) {
        if (!carries.has(b)) {
          bad.push(`${f.flow}: stage '${st.name}' may call '${b}' and the flow's tools ` +
                   (carries.size ? `carry only ${[...carries].join(", ")}` : "carry no block"));
        }
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("every flow that declares stages ships scenarios, or says why not", () => {
  // a prior system lost two scenarios from a full sweep and they still passed under a filter; the fix was
  // a guard that aborts by NAME. A count cannot do this: it reads the same whether the hole is
  // old or new. Exemptions carry a reason, and a reason that has expired fails.
  // TWO INDEPENDENT PROPERTIES, because one flag got one of them wrong. `mayBeMissing` says a
  // scenarios file need not exist. `permanent` says having one does not make the exemption
  // expired. They are not the same question, and conflating them meant casebox-assist — which HAS a
  // file we want kept — was also excused from ever having it, so deleting it would have gone
  // unnoticed. Found by the worker that wrote this check, reading its own consequences.
  const ALLOW = [
    // zz-admin WAS a second entry here, and it is gone because the package is: its skill and
    // its tools ship inside zz-access now. Its reason came with them and is why this one is
    // `permanent` rather than deferred — those tools mutate the live registry, so a driven
    // scenario would create and deactivate real principals on whichever deployment it ran
    // against. That cannot be fixed by proving the mechanism; it is a property of the tools.
    { flow: "zz-access", reason: "the mechanism is unproven for a one-stage surface, and its admin tools mutate the live registry — a driven scenario would create and deactivate real principals on whichever deployment it ran against", mayBeMissing: true, permanent: true },
    // Exempt for a sharper reason than the two component-level evaluators it replaced: its
    // subject is a RELEASED plugin version with recorded runs, so a driven scenario would have
    // to cut a release to have anything to evaluate.
    { flow: "zz-plugin-eval", reason: "its subject is a released plugin version with recorded runs; a driven scenario would have to cut a release to have a subject at all", mayBeMissing: true, permanent: true },
    { flow: "sdlc-flow", reason: "no browser agent: clients declares claude-code and codex only, so depth 2 cannot reach it", mayBeMissing: true, permanent: true },
    // TWO STRUCTURAL EXEMPTIONS, AND THEY ARE EXEMPT FOR DIFFERENT REASONS.
    // sdlc-flow cannot be DRIVEN — it declares no browser client and the engine drives a
    // LibreChat agent. casebox-assist can be driven and cannot be VERDICTED: it declares no
    // documents at all, so `ledgerClosed()` has nothing to find and every run reports FAILED
    // however well the agent performed. Its scenarios are readable evidence of what it should
    // do, not a pass/fail — and without this entry the guard would be satisfied by a file that
    // can only ever fail, which is the "exists and tests nothing" case this check exists to
    // refuse, arriving through the check's own front door.
    { flow: "casebox-assist", reason: "declares no documents, so no ledger close is reachable and depth 2 cannot verdict it — its scenarios are readable evidence, not a pass/fail", permanent: true },
  ];
  const bad = [];
  for (const f of flows) {
    const mf = join(f.dir, "flow.json");
    if (!existsSync(mf)) continue;
    const m = JSON.parse(readFileSync(mf, "utf8"));
    if (!(m.stages ?? []).length) continue;
    const sf = join(f.dir, "tests", "scenarios.json");
    const exempt = ALLOW.find((a) => a.flow === f.flow);
    if (!existsSync(sf)) {
      if (!exempt?.mayBeMissing) bad.push(`${f.owner}/${f.flow} declares ${(m.stages ?? []).length} stage(s) and ships no tests/scenarios.json`);
      continue;
    }
    if (exempt && !exempt.permanent) {
      bad.push(`${f.owner}/${f.flow} is on the coverage allowlist but now HAS scenarios — remove the exemption, its reason has expired`);
    }
    let parsed;
    try { parsed = JSON.parse(readFileSync(sf, "utf8")); }
    catch (e) { bad.push(`${f.owner}/${f.flow}: tests/scenarios.json does not parse — ${e.message}`); continue; }
    // THE FLOW IT LIVES UNDER, not merely a real one. A file copied from another flow carries a
    // valid `flow` field and would pass a catalog-membership test, and then declaredGates()
    // would read a DIFFERENT flow's gate count at run time — a scenario scored against the
    // wrong contract, silently.
    if (parsed.flow !== f.flow) {
      bad.push(`${f.owner}/${f.flow}: scenarios.json names flow "${parsed.flow}", not the flow it lives under`);
    }
    if (!Object.keys(parsed.scenarios ?? {}).length) {
      bad.push(`${f.owner}/${f.flow}: scenarios.json declares no scenarios — a file that exists and tests nothing is worse than none`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("every door that asks what a team runs counts the flows they did not install", () => {
  // `install: "auto"` means every team has that flow and no flow_install row is ever
  // written for it. Three doors answer "what does this team run", and two of them read only
  // that table:
  //
  //   render_agent_definition answered "ERROR: <team> does not have 'zz-flow-builder'
  //   installed" for a flow whose manifest says every team has it — and the provisioner
  //   calls exactly this for each flow it is given, so the browser agent every account is
  //   meant to get could not be rendered at all.
  //
  //   list_installs listed the flows a team CHOSE, while render_agent_definition's own
  //   refusal pointed the reader at it: "list_installs shows what they do have". It showed
  //   what they picked. A silently partial answer is worse than a refusal, because the
  //   reader has no reason to look further.
  //
  // flowsFor and list_catalog merge both sources and always did. The check is that every
  // reader of flow_install does — autoFlows() is the merge, so a function that queries the
  // table for a team and never calls it is answering half the question.
  const src = readFileSync(join(root, "services/gateway/src/admin.ts"), "utf8");
  const bad = [];
  // Function bodies, crudely: from a `function name(` / `server.registerTool("name"` to the
  // next one. Enough to attribute a query to the thing that runs it.
  const marks = [...src.matchAll(/(?:^(?:async )?function ([a-zA-Z_]\w*)|registerTool\(\s*\n?\s*"([a-z0-9_]+)")/gm)];
  for (const [i, m] of marks.entries()) {
    const name = m[1] ?? m[2];
    const body = src.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : src.length);
    // Only READS scoped to a team. An insert or a delete is about one named flow.
    if (!/select[^;]*from flow_install/i.test(body)) continue;
    if (!/autoFlows\(\)/.test(body)) bad.push(`${name} reads flow_install without autoFlows()`);
  }
  return bad.length
    ? `${bad.join("; ")} — a flow with install: "auto" has no row there, so this answers half the question`
    : null;
});

check("every section a manifest declares is taught by one of its skills", () => {
  // normalizeSections renames a near-miss heading to the one the manifest declares, silently
  // and on every write. That is the right behaviour and it is also why the two must agree: a
  // skill that teaches a heading the manifest does not declare has its output quietly
  // rewritten, and a section the manifest declares that no skill mentions is a heading the
  // flow requires and never asks anyone for.
  //
  // sdlc-spec prints its eight component labels in three places — a catalog table, a fenced
  // skeleton, and a numbered canonical list — and the manifest declares the same eight a
  // fourth time. Nothing held the four together, so a rename in any one of them was a silent
  // divergence in the other three.
  const bad = [];
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

check("the smoke engine can find the manifest of every flow it can run", () => {
  // declaredGates() builds this path to count a flow's gates, and a manifest it cannot find
  // DISABLES the premature-acceptance guard — the one check between a classifier misfire and a
  // scenario reported PASSED. It failed open, with a warning that read like a note about an
  // unusual layout.
  //
  // It appended the flow's name to a directory that already ended in the flow's own name, so
  // it resolved for NO flow, ever, including ops-flow. Every smoke run this platform has made
  // ran with that guard off. Nothing caught it because nothing ever asserted the path resolves
  // — the warning was the only signal, and it went to stderr in a live run nobody diffed.
  //
  // Mirrors declaredGates() exactly. If that changes and this does not, this check fails,
  // which is the point.
  const bad = [];
  for (const scen of sourceFiles(["catalog"], ["scenarios.json"])) {
    const flowDir = dirname(dirname(resolve(scen)));
    const manifest = join(flowDir, "flow.json");
    if (!existsSync(manifest)) {
      bad.push(`${scen}: the engine would look for a manifest at ${manifest}, which does not exist — the gate-count guard would be silently OFF for this flow`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("no shell freezes one flow's fixture paths", () => {
  // The sibling of "no evaluation tool is wired to one flow", for the layer that DRIVES them.
  //
  // eval-judge, eval-grade and eval-store were all parameterised by --flow, and the component
  // depth still could not reach a second flow: eval-step.sh, the script that PRODUCES a run
  // directory, held ONE flow's {requirements,steps}.json as constants and had no --flow at all.
  // smoke-env.sh did the same with that flow's scenarios.json in its exec line. So a corpus
  // authored for a SECOND flow was one nothing could run, and "drive a second flow end to end"
  // was blocked by the launcher rather than by the engine.
  //
  // The tools were checked and the shells that call them were not, which is the same miss as
  // the --flow guard above: the migration inspected the files someone had decided were the
  // callers. Path comes from an argument now; this keeps it that way.
  const ALLOW = [
    { file: "block-oracle.sh", reason: "derives which BUILDING BLOCKS a requirement needs, and block selection is a stage only some flows declare — scoping it to the flow that does is the fact, not a shortcut" },
  ];
  const dir = join(root, "testing");
  if (!existsSync(dir)) return null;
  const bad = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sh"))) {
    const exempt = ALLOW.find((a) => a.file === f);
    const lines = readFileSync(join(dir, f), "utf8").split("\n");
    const hits = [];
    lines.forEach((line, i) => {
      // A comment or a printed usage example NAMES a path, it does not depend on one.
      if (/^\s*(#|printf|echo)/.test(line)) return;
      // catalog/$FLOW/... does not match: the owner segment must be a literal.
      if (/catalog\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/(tests|flow\.json)/.test(line)) hits.push(i + 1);
    });
    if (hits.length && !exempt) {
      bad.push(`testing/${f}:${hits.join(",")} freezes one flow's fixture path — take it as an argument`);
    }
    // An exemption that has outlived its reason is a stale rule, and the coverage guard
    // already established that exemptions must be checked in both directions.
    if (!hits.length && exempt) {
      bad.push(`testing/${f} is exempt from the fixture-path guard but no longer freezes one — remove the exemption`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("no evaluation tool is wired to one flow", () => {
  // Each of these could evaluate exactly one flow, and each was one literal. Literals are how
  // a mechanism silently becomes a fixture.
  const bad = [];
  for (const rel of [
    "packages/tools/src/testing/eval-judge.ts",
    "packages/tools/src/testing/eval-grade.ts",
    "packages/tools/src/testing/eval-store.ts",
  ]) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    if (readFileSync(p, "utf8").includes("catalog/sdlc/sdlc-flow")) {
      bad.push(`${rel} still hardcodes catalog/sdlc/sdlc-flow, so it can evaluate exactly one flow`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a team overlay adds and cannot replace", () => {
  // A team running ops-flow may want two more considerations at ops-select. That is not a
  // different ops-select, and forking one to say it is how five teams end up with five
  // slightly different flows and a `flow` column nobody can group by.
  //
  // So an overlay is APPENDED to the skill, never substituted for it, and that is a property
  // of the code rather than a rule anybody has to follow: the shelf's text is returned first
  // and entire, the team's follows under a heading naming it. Substitution is not something
  // this can express, which is why no overlay can shadow zz-backbone or take over a stage.
  //
  // Reads for the shape that guarantees it — the platform's text concatenated ahead of the
  // team's — because an overlay that REPLACED would be a one-character change here.
  const src = zzCoreSource();
  const bad = [];
  if (!/readFileSync\(path, "utf8"\) \+ await teamOverlay\(name\)/.test(src)) {
    bad.push("skill_read no longer appends the team overlay to the skill — an overlay that is not appended is a replacement");
  }
  // It must read from the TEAM's store, not from a skills root, or it would be competing
  // for the same names the platform's skills use.
  if (!/join\(await userRoot\(\), "overlays", name, "SKILL\.md"\)/.test(src)) {
    bad.push("the overlay no longer comes from the team's own overlays/ directory");
  }
  // zz-kb-usage was removed on 2026-09-04 (never loaded once, by anybody). The rule it
  // carried is a PLATFORM rule, so it moved to the spine rather than out of the repository —
  // the check follows the rule, not the file that used to hold it.
  const usage = join(root, "skills/zz-backbone/SKILL.md");
  if (!readFileSync(usage, "utf8").includes("overlays/")) {
    bad.push("no skill tells a team the overlay exists");
  }
  return bad.length ? bad.join("; ") : null;
});
