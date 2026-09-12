/**
 * eval-grade — score what one step produced, across the whole corpus.
 *
 *   ZZ_URL=… ZZ_TOKEN=… npm run eval-grade -- --flow ops/ops-flow --step ops-intent --out evals/intent-1.0
 *   npm run eval-grade -- --flow ops/ops-flow --step ops-intent --out … --json
 *
 * MECHANICAL FIRST, AND ALMOST ENTIRELY. Every grader here reads the document the step wrote
 * and checks something the step's own contract states — the sections the flow manifest
 * declares, the facts the brief put in front of it. Nothing is asked of a model.
 *
 * That is a deliberate limit, not an oversight. A rubric is the easy thing to write and the
 * hard thing to trust: grade thirty documents with a judge and the number you get is partly
 * about the judge, and it moves when the judge does. Where a mechanical check exists it is
 * worth more than a better-worded rubric, and for ops-intent nearly everything that matters has
 * one — because the skill's contract is unusually concrete: exactly four sections, and
 * "nothing added, nothing solved, nothing dropped".
 *
 * FACT SURVIVAL IS THE HEADLINE. The step's job is reorganisation: take their content, give it
 * your structure, drop none of it. So the corpus records what each brief actually states, and
 * this counts how much of it came out the other side. A fact is carried if ANY of its
 * spellings appears, because "half-hour" and "30 minutes" are one fact and marking one wrong
 * would be grading prose style rather than the work.
 *
 * WHAT IT REFUSES TO SCORE. Whether the outcome is "really" an outcome and not a solution is a
 * judgement, and the honest mechanical proxy — does the outcome name a technology — is
 * reported as a FLAG rather than folded into the score. A flag is something for a person to
 * look at; a score is something a change gets judged by, and quietly mixing the two is how a
 * measurement stops meaning anything.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { manifestAt } from "@zz/catalog";
import { parseEnvelope, type FlowDoc } from "@zz/contracts";
import { Mcp } from "@zz/mcp-client";

import { die, envRequired, optional, parseArgs, required } from "../lib/cli.js";

interface Requirement {
  requester: string;
  title: string;
  brief: string;
  must_survive: string[][];
}

/** Every document the given flow declares — the one place both "what sections does this owe"
 *  and "does this owe a gate" are answered from. Read once, through manifestAt (not a cast —
 *  a cast accepts `gate: "false"`, which is a truthy string, and turns "not a gate" into a
 *  gate; not the schema directly either, since this answers "missing", "not JSON" and "not a
 *  manifest" as three different sentences, and an operator who gets one of them knows which
 *  of three things to go and fix). A second copy of this list goes stale the first time a
 *  flow changes its mind. */
function flowDocs(root: string, flow: string): FlowDoc[] {
  const file = join(root, "catalog", flow, "flow.json");
  const { manifest, why } = manifestAt(file);
  if (!manifest) die(`${file} ${why}`, 2);
  const documents = manifest.documents ?? [];
  if (!documents.length) die(`${flow} declares no documents — it owes no documents and cannot be graded`, 2);
  return documents;
}

/** Which document a step owes, from the flow's own manifest rather than a table kept here.
 *  The manifest names documents by ROLE and steps write them by STAGE — FlowDoc.stage is the
 *  join, so a flow that renames or reorders its steps cannot go stale against a second list
 *  nobody remembered to update alongside it. */
function docFor(documents: FlowDoc[], step: string, flow: string): FlowDoc {
  const doc = documents.find((d) => d.stage === step);
  if (!doc) {
    const known = documents.map((d) => d.stage).filter(Boolean).join(", ");
    die(`${step} has no document in ${flow}'s manifest — known steps: ${known}`, 2);
  }
  return doc;
}

/** Technology a business document should not be naming. Used for a FLAG, never for a score:
 *  "the outcome must not be a solution" is a judgement, and this is only its cheapest proxy. */
const TECHNOLOGY = /\b(casebox|rulemill|bookit|mcp|webhook|api|database|workflow engine|case management system)\b/i;

/**
 * Whether a fact survived, allowing for the words a writer puts BETWEEN its words.
 *
 * Exact substring was the first attempt and it scored two carried facts as dropped on its first
 * full run: the brief said "three groups a day" and the intent said "three tour groups a day";
 * the brief said "past their deadline" and the intent said "past their fix deadline". Both facts
 * were plainly carried, and a grader that calls those losses is not measuring the step, it is
 * measuring how closely the step transcribes — the one thing this step is explicitly NOT asked
 * to do, since its job is "their content, your organisation".
 *
 * So the words of a phrase must appear IN ORDER and CLOSE TOGETHER, not adjacently. Each word
 * matches as a substring of a token, which handles "group" against "groups" without stemming.
 * The window is the phrase's own length plus three, which admits an adjective or two and still
 * refuses to match words scattered across a paragraph.
 */
function carried(alternatives: string[], text: string): boolean {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return alternatives.some((alt) => {
    const words = alt.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!words.length) return false;
    const window = words.length + 3;
    for (let start = 0; start <= tokens.length - words.length; start += 1) {
      if (!tokens[start].includes(words[0])) continue;
      let at = start, ok = true;
      for (let w = 1; w < words.length; w += 1) {
        let found = -1;
        for (let j = at + 1; j < Math.min(tokens.length, start + window); j += 1) {
          if (tokens[j].includes(words[w])) { found = j; break; }
        }
        if (found < 0) { ok = false; break; }
        at = found;
      }
      if (ok) return true;
    }
    return false;
  });
}

interface Scored {
  id: string;
  requester: string;
  found: boolean;
  sections: { present: string[]; missing: string[] };
  facts: { carried: number; total: number; dropped: string[] };
  flags: string[];
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, ["json"]);
  const flow = required(args, "flow", "which flow to grade against, as <owner>/<flow>", 2);
  const step = required(args, "step", "which step's output to grade");
  const out = required(args, "out", "the run directory eval-step.sh wrote");
  const corpus = optional(args, "corpus", "the requirements file")
    ?? `catalog/${flow}/tests/requirements.json`;
  const url = envRequired("ZZ_URL", "the gateway holding the documents").replace(/\/+$/, "");
  const pat = envRequired("ZZ_TOKEN", "reads the documents back");

  // THE VERSION THE RUN WAS MADE AT, read from what the runner recorded rather than from the
  // file on disk now. Those differ the moment anybody edits the skill between running and
  // grading, and a score filed against the wrong version credits a change with results from
  // before it existed — the exact failure the whole versioning scheme was built to stop.
  let version = "(unrecorded)";
  try {
    // Through parseEnvelope, like every other `key: value` block the platform reads. run.txt
    // is exactly that shape, and a second spelling of "read a field" is how two readers of one
    // file come to disagree about what it says.
    version = parseEnvelope(readFileSync(join(out, "run.txt"), "utf8")).version || version;
  } catch {
    die(`no run.txt in ${out} — grade a directory eval-step.sh wrote, so the score has a version`);
  }

  const documents = flowDocs(process.cwd(), flow);
  const flowDoc = docFor(documents, step, flow);
  const role = flowDoc.role;
  if (!role) die(`${step}'s document in ${flow}'s manifest declares no role — nothing to grade against`, 2);
  const doc = { name: flowDoc.name, sections: flowDoc.sections ?? [] };
  const reqs = (JSON.parse(readFileSync(corpus, "utf8")) as { requirements: Record<string, Requirement> }).requirements;

  // WHAT WAS ACTUALLY RUN, and only that. Grading the whole corpus against a partial run
  // reported most requirements as producing no document when they had simply never
  // been asked to — a table of failures that were not failures, which is worse than no table.
  const ran = new Map<string, string>();
  try {
    for (const line of readFileSync(join(out, "produced.txt"), "utf8").split("\n")) {
      const [id, path] = line.trim().split(/\s+/);
      if (id && path) ran.set(id, path.split("/")[0]);
    }
  } catch {
    die(`no produced.txt in ${out} — it records which initiative each requirement wrote, and ` +
        "without it a document can only be matched to a requirement by guessing at its content");
  }
  if (!ran.size) die(`${out}/produced.txt is empty — no requirement wrote a document`);

  const core = new Mcp(`${url}/core/mcp`, { pat, client: "zz-eval-grade" });

  // Which roles owe a gate, from the manifest already read above rather than a list here.
  const gated = new Set(documents.filter((d) => d.gate).map((d) => d.role ?? ""));
  // READ BY THE EXACT PATH the step wrote, from the record the runner kept. Matching by content
  // was the first attempt and it mis-attributed two documents on its first outing — a greedy
  // best-hits join will always find SOME document for every requirement, and a wrong match
  // scores silently rather than failing.
  const bodies = new Map<string, string>();
  const approvedOf = new Map<string, string>();
  for (const [id, initiative] of ran) {
    try {
      const body = await core.call("read_file", { path: `${initiative}/${doc.name}` });
      if (body && !/^ERROR/.test(body)) {
        bodies.set(id, body);
        // The envelope the PLATFORM writes, not anything the model typed: status is stamped by
        // approve() and hand-writing it is refused.
        approvedOf.set(id, parseEnvelope(body).status ?? "");
      }
    } catch { /* the step wrote no document for this one, which is itself the finding */ }
  }

  const scored: Scored[] = [];
  for (const [id, r] of Object.entries(reqs)) {
    if (!ran.has(id)) continue;
    const text = bodies.get(id);
    if (!text) {
      scored.push({
        id, requester: r.requester, found: false,
        sections: { present: [], missing: doc.sections },
        facts: { carried: 0, total: r.must_survive.length, dropped: r.must_survive.map((a) => a[0]) },
        flags: [`no ${doc.name} at ${ran.get(id)} — the step ran and produced nothing readable`],
      });
      continue;
    }

    const present = doc.sections.filter((s) => new RegExp(`^#{1,4}\\s*${s.replace(/[()]/g, "\\$&")}`, "im").test(text));
    // WHICH FACTS A DOCUMENT MUST CARRY DEPENDS ON THE DOCUMENT. An intent and a spec restate what the
    // stakeholder said, so every fact in the brief should survive into them. A SELECTION does
    // not: it is a fit ledger about technology, and "9:30, 11:00 and 1:30" belongs in the spec
    // it answers to. Scoring it on brief facts marked ops-select down for correctly declining to
    // repeat the schedule — 85.4%, every point of it earned by not restating a spec.
    //
    // So a selection is scored on what it DOES owe: a verdict for the work, and the call shapes
    // the round-8 change made it write down. Both are checked below and neither is a fact count.
    const dropped = role === "selection"
      ? []
      : r.must_survive.filter((alts) => !carried(alts, text)).map((a) => a[0]);

    const flags: string[] = [];
    // DID THE GATE PASS. A document that exists and was never approved does not let the flow
    // continue, and checking only that the file is there reports it as a success. This was found
    // the expensive way: ops-spec scored full marks on documents and sections, and then ops-select
    // refused two of them because the spec was still a draft — the step downstream noticed what
    // the grader had not.
    //
    // The platform stamps `status` on approve(), so this reads the act rather than the prose.
    if (gated.has(role) && approvedOf.get(id) !== "approved") {
      flags.push(`${doc.name} was never approved — it exists, and the gate it owes is still open`);
    }
    // The artefact the round-8 change asked for. A selection that skipped it is the case that
    // change exists to prevent, and it is checkable in one line.
    if (role === "selection" && !/##\s*Call shapes/i.test(text)) {
      flags.push("no `## Call shapes` section — the block's required arguments were not written down");
    }
    // The outcome section only. Technology named in "Constraints (theirs)" is the stakeholder's
    // own word and belongs there — flagging it would punish the step for carrying their content.
    const outcome = /##\s*The outcome([\s\S]*?)(\n##\s|$)/i.exec(text)?.[1] ?? "";
    const named = TECHNOLOGY.exec(outcome);
    if (named) flags.push(`the outcome names "${named[0]}" — worth reading, an outcome is a state, not a solution`);
    // ONLY WHERE THE SECTION EXISTS. `Open questions` is an INTENT section, and this flag was
    // raised against every spec — a section a spec is not asked to have, reported as a defect on
    // every one of thirty documents. A flag that fires on correct work is worse than no flag: it
    // teaches the reader to skip the list, and the one that matters is in the same list.
    if (role === "intent" && !/##\s*Open questions[\s\S]*?\S/i.test(text)) {
      flags.push("no open questions at all");
    }

    scored.push({
      id, requester: r.requester, found: true,
      sections: { present, missing: doc.sections.filter((s) => !present.includes(s)) },
      facts: { carried: r.must_survive.length - dropped.length, total: r.must_survive.length, dropped },
      flags,
    });
  }

  // ── THE VERDICT CHECK, for the step that chooses ───────────────────────────
  //
  // A step whose document is a SELECTION is the only kind with a checkable ground truth beyond
  // its own sections: some requirements cannot be built with the blocks on this
  // deployment — no payment block, no identity block, no mapping block, no streaming block is
  // connected, and none of those is a matter of opinion. Keyed on `role`, not on the step's
  // name, so a flow that calls its selection step something other than ops-select still gets
  // this check — the name was ops-flow's, the role is the manifest's.
  //
  // A selection step that never answers `not_possible` has not been shown to be capable of it,
  // and the cost of finding that out in production is a team that built the wrong thing. So the
  // claims it recorded are read back from the platform's reconciliation, which derives them from
  // the fit ledger the step wrote — its own words, not a second account of them.
  //
  // The buildable requirements are checked the other way round: a step that answered
  // `not_possible` to everything would score perfectly on the four and be useless.
  const verdicts: { id: string; ok: boolean; why: string }[] = [];
  if (role === "selection") {
    for (const [id] of ran) {
      const shape = (reqs[id] as unknown as { exercises?: { shape?: string } })?.exercises?.shape;
      const text = bodies.get(id);
      if (!shape || !text) continue;
      // READ FROM THE FIT LEDGER ITSELF, not from the platform's reconciliation of it. The first
      // version asked `reconcile` and grepped its prose, and reported three steps as having
      // failed to answer `not_possible` when the stored decisions plainly showed they had. A
      // grader one layer away from the evidence is a grader that can be wrong about it.
      const impossible = /not[ _]possible/i.test(text);
      const buildable = /\b(native|achievable|workaround)\b/i.test(text);
      if (shape === "not_possible") {
        verdicts.push({ id, ok: impossible,
          why: impossible ? "answered not possible, correctly"
                          : "did NOT answer not possible for work this deployment cannot do" });
      } else {
        verdicts.push({ id, ok: buildable,
          why: buildable ? "claimed something buildable, correctly"
                         : "claimed nothing buildable for work that IS buildable" });
      }
    }
  }

  const done = scored.filter((s) => s.found);
  const carriedTotal = done.reduce((a, s) => a + s.facts.carried, 0);
  const total = done.reduce((a, s) => a + s.facts.total, 0);
  const whole = done.filter((s) => !s.sections.missing.length).length;

  if (args.flags.has("json")) {
    console.log(JSON.stringify({ step, version, document: doc.name, scored }, null, 2));
    return 0;
  }

  const pad = (s: unknown, n: number): string => String(s).padEnd(n);
  console.log("");
  console.log(`== ${step} @ ${version} over ${scored.length} requirement(s) - ${doc.name}`);
  console.log("");
  console.log(`  ${pad("id", 6)}${pad("requester", 20)}${pad("sections", 12)}${pad("facts", 10)}flags`);
  for (const s of scored) {
    const sec = s.found ? `${s.sections.present.length}/${doc.sections.length}` : "-";
    const f = s.found ? `${s.facts.carried}/${s.facts.total}` : "-";
    console.log(`  ${pad(s.id, 6)}${pad(s.requester, 20)}${pad(sec, 12)}${pad(f, 10)}${s.flags.length || ""}`);
  }

  console.log("");
  console.log(`  produced a document      ${done.length} of ${scored.length}`);
  console.log(`  every declared section   ${whole} of ${done.length}`);
  if (role === "selection") {
    // NOT SCORED, AND SAID SO. A selection is a fit ledger about technology; the brief's facts
    // belong in the spec it answers to. Reporting 100% here because nothing was checked is the
    // same flattering-direction error as every instrument defect in this repository's history —
    // an unmeasured thing must read as unmeasured, never as perfect.
    console.log("  facts carried            not scored for a selection");
    console.log("");
    console.log("  A SELECTION DOES NOT RESTATE THE BRIEF. It is a fit ledger about technology, and");
    console.log("  \"9:30, 11:00 and 1:30\" belongs in the spec it answers to. Scored on brief facts");
    console.log("  this step read 85.4%, every lost point earned by correctly declining to repeat a");
    console.log("  specification. What it owes instead is a verdict and its call shapes, below.");
  } else {
    console.log(`  facts carried            ${carriedTotal} of ${total}` +
                (total ? `  (${((carriedTotal / total) * 100).toFixed(1)}%)` : ""));
    console.log("");
    console.log("  FACTS CARRIED IS THE HEADLINE, because the step's own rule is 'nothing added,");
    console.log("  nothing solved, nothing dropped - an aside you cut may be the requirement they");
    console.log("  cared most about'. A fact counts if any of its spellings appears, so this is not");
    console.log("  measuring whether the step copied words.");
  }

  const worst = [...done].sort((a, b) => (a.facts.carried / a.facts.total) - (b.facts.carried / b.facts.total)).slice(0, 5);
  if (worst.length && worst[0].facts.dropped.length) {
    console.log("");
    console.log("  WHAT WENT MISSING, worst first - this is the material a change is written from:");
    for (const s of worst) {
      if (!s.facts.dropped.length) continue;
      console.log(`    ${s.id} ${s.requester}: ${s.facts.dropped.join(", ")}`);
    }
  }

  if (verdicts.length) {
    const right = verdicts.filter((v) => v.ok).length;
    console.log("");
    console.log(`== CAN IT SAY NO — ${right} of ${verdicts.length} verdicts correct`);
    console.log("");
    console.log("  Four requirements cannot be built with the blocks connected here: no payment,");
    console.log("  identity, mapping or streaming block exists. A selection step that never answers");
    console.log("  `not_possible` has not been shown to be capable of it, and finding that out in");
    console.log("  production means a team built the wrong thing.");
    console.log("");
    for (const v of verdicts.filter((x) => !x.ok)) console.log(`  WRONG  ${v.id}  ${v.why}`);
    if (right === verdicts.length) console.log("  every verdict matched what this deployment can actually do.");
  }

  const flagged = scored.filter((s) => s.flags.length);
  if (flagged.length) {
    console.log("");
    console.log("  FLAGS - for a person to read, deliberately NOT in the score. Whether an outcome");
    console.log("  is really an outcome is a judgement, and quietly folding a judgement into a");
    console.log("  number is how a measurement stops meaning anything:");
    for (const s of flagged) for (const f of s.flags) console.log(`    ${s.id}  ${f}`);
  }
  console.log("");
  return done.length === scored.length ? 0 : 1;
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (err) {
  console.error(String((err as Error)?.message ?? err));
  process.exit(2);
}
