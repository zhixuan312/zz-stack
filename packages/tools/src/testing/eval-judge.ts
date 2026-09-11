/**
 * eval-judge — ask a model whether what a step wrote is any GOOD, not whether it is well-formed.
 *
 *   zz-tool eval-judge --flow sm/ops-flow --step sm-select --out <rundir> --derive   # the rubric, once
 *   zz-tool eval-judge --flow sm/ops-flow --step sm-select --out <rundir>            # score every instance
 *   zz-tool eval-judge --flow sm/ops-flow --step sm-select --out <rundir> --control  # deliberately wrong
 *   zz-tool eval-judge --flow sm/ops-flow --step sm-select --out <rundir> --reflect  # the recurring mistake
 *
 * and the expected-versus-actual loop, which is the one that says WHY:
 *
 *   zz-tool eval-judge --flow sm/ops-flow --step sm-intent --expect                  # the answer, written blind
 *   zz-tool eval-judge --flow sm/ops-flow --step sm-intent --out <rundir> --compare  # every deviation, classified
 *   zz-tool eval-judge --flow sm/ops-flow --step sm-intent --out <rundir> --pattern  # what recurs, and the guideline
 *
 * WHY THIS EXISTS. eval-grade counts sections and checks that facts from the brief survived. Both
 * are worth having and neither is a quality measurement. A selection that names three blocks for
 * a brief needing one carries every fact and has every section; it scores full marks and is
 * wrong. The thing that was missing is a reader who can hold the brief and the document at once
 * and say "casebox alone would have done this" — and no amount of regular expression is that reader.
 *
 * SO THE SPLIT IS DELIBERATE, AND BOTH HALVES STAY. Mechanical checks are the sanity floor: they
 * are cheap, they never drift, and they catch the failures that are genuinely structural — a
 * missing section, a dropped constraint, a document that was never approved. The model is the
 * quality ceiling: fit, accuracy, whether a plan could actually be built from. Folding them into
 * one number would let a good rubric score hide a missing section, and let a present section
 * stand in for having said anything useful.
 *
 * THE RUBRIC IS DERIVED, NOT DECLARED BY ME. I do not get to decide what a good selection looks
 * like and then measure against my own opinion — that is a graded exam written by the candidate.
 * `--derive` reads the skill's own instructions and real examples of its output and asks what
 * separates a strong one from a weak one; the answer lands in a file beside the skill, in prose,
 * where a person can disagree with it. Every score afterwards cites the dimension it came from.
 *
 * AND THE JUDGE IS ITSELF ON TRIAL. `--control` re-runs every judgement against a NEIGHBOUR's
 * brief. A judge that is reading collapses to near the floor; a judge that is pattern-matching on
 * confident prose barely moves. That gap is printed on every run, because a quality score with no
 * control behind it is exactly the too-good number that started this.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { manifestAt } from "@zz/catalog";
import { Mcp } from "@zz/mcp-client";

import { die, envRequired, optional, parseArgs, required } from "../lib/cli.js";

// `||`, not `??`: an unset variable arrives from a container as "", which `??` keeps.
const MODEL = process.env.JUDGE_MODEL || "sonnet";

interface Requirement {
  agency: string;
  title: string;
  brief: string;
  exercises?: { shape?: string; blocks?: string[] };
}

interface Dimension {
  name: string;
  five: string;
  one: string;
}

interface Rubric {
  step: string;
  role: string;
  derived_at: string;
  derived_from: string;
  dimensions: Dimension[];
}

interface Mark {
  dimension: string;
  score: number;
  quote: string;
  why: string;
}

interface Judgement {
  id: string;
  agency: string;
  marks: Mark[];
  worst: { quote: string; fix: string };
  mean: number;
  addressed: boolean;
}

/** One call to the judge, answered as JSON or not at all.
 *
 *  THROUGH THE LOCAL CLI, not an HTTP endpoint, and the reason is worth writing down. The
 *  platform's own cheap model sits behind LLM_BASE_URL, which is the right thing for a loop that
 *  runs in production — but that key currently answers 401, and more to the point a flash-tier
 *  model is a poor judge. Judging is the hardest reading task in this whole apparatus: it has to
 *  hold a brief and a document at once and say which parts of the document are load-bearing. A
 *  weak judge does not produce slightly worse scores, it produces confident uniform ones, which
 *  is the failure this tool exists to stop.
 *
 *  NO TOOLS. The judge marks the text in front of it. Given a filesystem it will go and read the
 *  skill it is marking, the corpus, and eventually this file, and mark the document against what
 *  it thinks the answer was supposed to be instead of against the requirement.
 *
 *  The answer is READ rather than trusted to be shaped right — a run that dies the first time a
 *  model wraps its reply in a code fence is a run that never finishes a corpus. */
async function ask(system: string, user: string, temperature = 0): Promise<Record<string, unknown>> {
  void temperature;
  // TWICE, THEN GIVE UP ON THIS ONE. A model occasionally answers with JSON it did not finish, or
  // with a stray quote inside a quoted passage. The first version of this called die() on that,
  // and one malformed reply out of thirty killed a run that had already paid for twenty-nine —
  // sm-intent's control died at position 2399 of one answer and returned nothing at all.
  //
  // A retry is honest here because the fault is in the reply, not in the question: the same
  // prompt asked again usually parses. What is NOT honest is silently scoring an unparseable
  // answer as a bad document, so a second failure raises rather than inventing a mark.
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const said = await new Promise<string>((resolve, reject) => {
      const child = execFile("claude",
        ["-p", "--model", MODEL, "--output-format", "json", "--disallowed-tools", "*"],
        { maxBuffer: 64 * 1024 * 1024, timeout: 600_000 },
        (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)));
      child.stdin?.end(`${system}\n\n---\n\n${user}`);
    }).catch((err: Error) => `__unreachable__${err.message}`);

    if (said.startsWith("__unreachable__")) { last = said.slice(15); continue; }

    let text = said;
    try {
      const frame = JSON.parse(said) as { result?: string; is_error?: boolean };
      // A refused call is not a retryable formatting slip. Running out of quota mid-corpus has to
      // stop the run and say so, not spend the rest of the corpus rediscovering it.
      if (frame.is_error) {
        const msg = String(frame.result ?? "");
        if (/limit|quota|rate/i.test(msg)) die(`the judge is out of quota: ${msg.slice(0, 200)}`);
        last = msg; continue;
      }
      text = frame.result ?? said;
    } catch { /* not the wrapper frame — treat the whole reply as the answer */ }

    const json = /\{[\s\S]*\}/.exec(text);
    if (!json) { last = `no JSON in: ${text.slice(0, 200)}`; continue; }
    try {
      return JSON.parse(json[0]) as Record<string, unknown>;
    } catch (err) {
      last = `${String((err as Error).message)} in: ${json[0].slice(0, 160)}`;
    }
  }
  return die(`the judge failed twice on the same question — ${last}`);
}

const EXPECT_SYSTEM = [
  "You are writing down what a good answer to this requirement WOULD look like, before anybody",
  "shows you the answer that was actually produced. You will never see that answer. Somebody else",
  "compares the two.",
  "",
  "You are given the requirement as the stakeholder stated it, and the contract for the kind of",
  "document that answers it.",
  "",
  "Write the expectation as three lists:",
  "- MUST DECIDE: the questions this document has no business leaving open. Name the question,",
  "  not your preferred answer, wherever the requirement genuinely permits more than one.",
  "- MUST SURFACE: what an expert reading the requirement would notice and raise — the trap, the",
  "  conflict between two things the stakeholder wants, the thing they have not thought about.",
  "- MUST NOT: what would be wrong to put in this document. Things that belong to a later step,",
  "  claims the requirement does not support, invented detail.",
  "",
  "Be specific to THIS requirement. 'Should be clear and complete' fits every requirement ever",
  "written and is therefore worth nothing as an expectation.",
  "",
  "Answer as JSON: {\"must_decide\": [string], \"must_surface\": [string], \"must_not\": [string]}",
].join("\n");

const COMPARE_SYSTEM = [
  "You are comparing what a document SHOULD have contained against what it does contain, and",
  "classifying every difference.",
  "",
  "The expectation was written by a reader who saw only the requirement, never this document. It",
  "is a careful opinion, not a specification — where the document does something different and",
  "BETTER, say so and do not record a deviation.",
  "",
  "For each real deviation, decide the thing that matters most here: is it SPECIFIC or GENERIC?",
  "",
  "- SPECIFIC: it is about this requirement's own subject matter. Another requirement would not",
  "  hit it. Missing a domain fact peculiar to this agency's process is specific.",
  "- GENERIC: it is a habit. The step would do the same thing on a different requirement in a",
  "  different domain, because the cause is how the step works rather than what it was asked",
  "  about. Restating a section, hedging a verdict, always reaching for the same tool.",
  "",
  "The test for GENERIC is a question you must actually ask yourself: strip out every noun that",
  "belongs to this domain — could you still describe the mistake? If yes it is generic. If the",
  "mistake disappears when the domain does, it is specific.",
  "",
  "Only generic deviations can justify changing a skill. A specific one is this document's",
  "problem and gets fixed by writing this document better.",
  "",
  "Answer as JSON: {\"deviations\": [{\"what\": string, \"class\": \"generic\"|\"specific\",",
  "\"why\": string, \"severity\": 1|2|3, \"quote\": string}]}",
  "`why` must say why it is generic or specific, in one sentence. `quote` is verbatim from the",
  "document, or empty when the deviation is that something is absent.",
].join("\n");

const PATTERN_SYSTEM = [
  "You are reading every GENERIC deviation found across a whole corpus of requirements, all",
  "answered by one skill, and turning the recurring ones into a guideline for that skill.",
  "",
  "A corpus exists so that this question can be asked at all: a fault seen once is a document's",
  "problem, and a fault seen in a third of the corpus, in unrelated domains, is the skill's.",
  "",
  "Rank the patterns by how many requirements show them. For the top pattern only, write the",
  "guideline that would prevent it. The guideline must be:",
  "- Written as WHEN and THEN, not as a prohibition. 'When the requirement names a fact that is",
  "  also an outcome, put it in one place and cross-reference' beats 'do not duplicate'.",
  "- Symmetric where the mistake is a choice: say when to do the thing AND when not to. A rule",
  "  that only ever says yes moves the failure instead of removing it.",
  "- Specific enough that two people would apply it the same way, and free of the domain nouns",
  "  of any one requirement in the corpus.",
  "",
  "If no pattern reaches a third of the corpus, say so and propose nothing. Inventing a rule for",
  "a fault seen twice adds words that will never fire, and every word in a skill is read on every",
  "run forever.",
  "",
  "Answer as JSON: {\"patterns\": [{\"pattern\": string, \"seen_in\": number, \"ids\": [string]}],",
  "\"guideline\": string, \"anchor\": string, \"propose\": boolean}",
  "`anchor` is a short exact line from the skill after which the guideline should be inserted.",
].join("\n");

const DERIVE_SYSTEM = [
  "You are defining how to tell a strong piece of work from a weak one, for one step of a",
  "software delivery flow. You are given that step's own instructions, and real examples of what",
  "it produced.",
  "",
  "Produce 3 to 5 dimensions. For each: a short name, what a 5 out of 5 looks like, and what a 1",
  "looks like. Both descriptions must be concrete enough that two readers marking the same",
  "document would land within a point of each other.",
  "",
  "THE HARD CONSTRAINT: every dimension must be something you could only judge by READING and",
  "THINKING. Anything a script can already check is banned — whether a heading exists, whether a",
  "word appears, how long the document is, whether a list has items. Those are checked elsewhere",
  "and a dimension that duplicates them wastes the only judge in the system on counting.",
  "",
  "Ask instead: is this the right answer, is it accurate, could somebody act on it, does it",
  "commit to anything, would an expert in this domain wince at it.",
  "",
  "Answer as JSON: {\"dimensions\": [{\"name\": string, \"five\": string, \"one\": string}]}",
].join("\n");

function judgeSystem(rubric: Rubric, capabilities: string): string {
  return [
    `You are marking one ${rubric.role} document against the requirement it was written for.`,
    "",
    "THE DIMENSIONS, and what each end of them looks like:",
    ...rubric.dimensions.map((d) => `- ${d.name}\n    5: ${d.five}\n    1: ${d.one}`),
    "",
    capabilities ? `THE TECHNOLOGY AVAILABLE, which you need in order to judge fit:\n\n${capabilities}\n` : "",
    "RULES.",
    "- Score each dimension 1 to 5, and quote the document VERBATIM as your evidence. If you",
    "  cannot find a quote that supports your score, the score is wrong.",
    "- Name the single most consequential weakness, quoted, with a concrete fix. Every document",
    "  has a weakest point, including a good one. Writing 'none' is refusing to do the job.",
    "- FIRST decide whether this document is even about the requirement you were given. If it",
    "  answers a different problem, set addressed to false and score everything 1. Do not credit",
    "  a document for being well written about the wrong thing.",
    "- Do not be generous. A 5 means you would ship it unchanged and defend it. Most work is a 3.",
    "",
    "Answer as JSON: {\"addressed\": boolean, \"marks\": [{\"dimension\": string, \"score\": number,",
    "\"quote\": string, \"why\": string}], \"worst\": {\"quote\": string, \"fix\": string}}",
  ].filter(Boolean).join("\n");
}

const REFLECT_SYSTEM = [
  "You are reading every weakness a judge found across one corpus, for one step of a flow.",
  "",
  "Your job is to find the ONE mistake that recurs — the thing this step does wrong repeatedly,",
  "not the worst single instance. A fault that appears once is that document's problem. A fault",
  "that appears in a third of them is the skill's problem, and it is the only kind worth changing",
  "a skill over.",
  "",
  "Then propose exactly one addition to the skill that would prevent it: a short passage, saying",
  "what to DO. Quote the judged weaknesses that earned it so a later reader can check you.",
  "",
  "If the weaknesses have nothing in common, say so and propose nothing. Scattered faults mean",
  "the step is behaving and these are the ordinary costs of writing; inventing a rule to cover",
  "them adds words that will never fire.",
  "",
  "Answer as JSON: {\"recurring\": boolean, \"pattern\": string, \"seen_in\": number,",
  "\"evidence\": [string], \"passage\": string}",
].join("\n");

/**
 * A path under the catalog flow named by --flow, or `die` with the path and the flow it came
 * from. Exit 2, the same code as a missing --flow itself: both are a bad ARGUMENT, not a runtime
 * failure, and the operator fixes them the same way — check the owner/flow spelling — rather than
 * reading a stack trace for `ENOENT` that names the file but not the flag that produced it.
 */
function flowPath(root: string, flow: string, ...segments: string[]): string {
  const p = join(root, "catalog", flow, ...segments);
  if (!existsSync(p)) die(`no ${p} — derived from --flow ${flow}`, 2);
  return p;
}

/** The document this role owes, from the flow's own manifest. Through manifestAt, the one reader:
 *  a cast accepts a manifest that says anything, and this needs to fail loudly rather than judge
 *  an empty string. */
function docFor(root: string, flow: string, role: string): { name: string; sections: string[] } {
  const file = flowPath(root, flow, "flow.json");
  const { manifest, why } = manifestAt(file);
  if (!manifest) die(`${file} ${why}`, 2);
  const doc = (manifest.documents ?? []).find((d: { role?: string }) => d.role === role);
  if (!doc) die(`the flow declares no document with role "${role}"`);
  return { name: doc.name, sections: (doc as { sections?: string[] }).sections ?? [] };
}

function mean(ns: number[]): number {
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, ["derive", "expect", "compare", "pattern", "control", "reflect", "json"]);
  // NO DEFAULT. Every other flag has a value that makes sense in its absence; a default flow does
  // not — it would judge a different flow's steps than the one an operator typed, silently, which
  // is worse than a tool that refuses to guess.
  const flow = required(args, "flow", "which catalog flow to judge, e.g. sdlc/sdlc-flow", 2);
  const step = required(args, "step", "which step's output to judge");
  // WRITING THE EXPECTATION NEEDS NO RUN. That is the entire point of it: it is authored from the
  // requirement alone, before and independently of anything a step produced, and a mode that
  // demanded a run directory would invite somebody to write it with the answer on screen.
  const out = args.flags.has("expect")
    ? (optional(args, "out", "not read when writing expectations") ?? "")
    : required(args, "out", "the run directory eval-step.sh wrote");
  const root = optional(args, "root", "the repository root") ?? process.cwd();
  // --corpus overrides the derived path ONLY: given, it is trusted as-is with no flow bookkeeping;
  // absent, it is resolved from --flow and held to the same existence check as every other
  // flow-derived path.
  const corpusOverride = optional(args, "corpus", "the requirements file");
  const corpusPath = corpusOverride ?? flowPath(root, flow, "tests/requirements.json");
  if (corpusOverride && !existsSync(corpusPath)) die(`no ${corpusPath}`, 2);
  const url = envRequired("ZZ_URL", "the gateway holding the documents").replace(/\/+$/, "");
  const pat = envRequired("ZZ_TOKEN", "reads the documents back");

  const steps = JSON.parse(readFileSync(flowPath(root, flow, "tests/steps.json"), "utf8"))
    .steps as Record<string, { role: string | null }>;
  const role = steps[step]?.role;
  if (!role) {
    die(`${step} owes no document, so there is nothing here to read and judge. It is graded on ` +
      "the calls it made and whether its work was accepted.");
  }

  const reqs = (JSON.parse(readFileSync(corpusPath, "utf8")) as
    { requirements: Record<string, Requirement> }).requirements;

  // Not resolved through flowPath: --expect creates this directory (mkdirSync below), so its
  // absence going in is the normal case, not a bad --flow.
  const expectDir = join(root, "catalog", flow, "tests/expected", step);

  if (args.flags.has("expect")) {
    const doc = docFor(root, flow, role);
    const skill = readFileSync(flowPath(root, flow, "skills", step, "SKILL.md"), "utf8");
    mkdirSync(expectDir, { recursive: true });
    const ids = Object.keys(reqs);
    const queue = [...ids];
    let written = 0;
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const r = reqs[id];
        const said = await ask(EXPECT_SYSTEM, [
          `THE REQUIREMENT (${r.agency} — ${r.title})`, "", r.brief, "",
          `THE DOCUMENT THAT ANSWERS IT: ${doc.name}, sections ${doc.sections.join(", ")}`, "",
          "THE STEP'S OWN CONTRACT, so the expectation asks for what this step owes and not what a",
          "later one does:", "", skill,
        ].join("\n"), 0.2);
        const list = (k: string): string[] =>
          (said[k] as string[] ?? []).map((x) => String(x).trim()).filter(Boolean);
        const expectation = {
          id, agency: r.agency, step, role,
          must_decide: list("must_decide"),
          must_surface: list("must_surface"),
          must_not: list("must_not"),
        };
        writeFileSync(join(expectDir, `${id}.json`), `${JSON.stringify(expectation, null, 2)}\n`);
        written++;
        console.log(`  ${id}  ${r.agency.slice(0, 26).padEnd(26)} decide ${expectation.must_decide.length}  surface ${expectation.must_surface.length}  must-not ${expectation.must_not.length}`);
      }
    }));
    console.log(`\n  ${written} expectations written to ${expectDir}`);
    console.log("  These were authored from the requirements alone. Nothing here has seen a document");
    console.log("  the step produced, and that blindness is the only reason a comparison against them");
    console.log("  means anything.\n");
    return 0;
  }

  const producedPath = join(out, "produced.txt");
  if (!existsSync(producedPath)) die(`no produced.txt in ${out} — nothing records what was written`);
  const ran = new Map<string, string>();
  for (const line of readFileSync(producedPath, "utf8").split("\n")) {
    // The runner records the DOCUMENT the requirement wrote — `<initiative>/<name>.md` — and the
    // initiative is its first segment. Taking the whole line as a directory asks the store for
    // `.../selection.md/selection.md`, which answers "not found" for all thirty and reads exactly
    // like a bad token.
    const [id, path] = line.trim().split(/\s+/);
    if (id && path) ran.set(id, path.split("/")[0]);
  }
  if (!ran.size) die(`${producedPath} is empty — no requirement wrote a document`);

  const docName = docFor(root, flow, role).name;
  // A DISTINCT CLIENT NAME, because the platform attributes a call to the step whose skill the
  // caller loaded last, and a caller is the token plus the client name. Judging under the
  // runner's name would file these reads against whichever step was measured most recently.
  const core = new Mcp(`${url}/core/mcp`, { pat, client: "zz-eval-judge" });
  const bodies = new Map<string, string>();
  for (const [id, initiative] of ran) {
    try {
      const body = await core.call("read_file", { path: `${initiative}/${docName}` });
      if (body && !/^ERROR/.test(body)) bodies.set(id, body);
    } catch { /* nothing written for this one, which eval-grade already reports */ }
  }
  if (!bodies.size) die(`read no documents at all from ${url} — check ZZ_TOKEN`);

  if (args.flags.has("compare")) {
    if (!existsSync(expectDir)) die(`no expectations at ${expectDir} — run with --expect first`);
    const queue = [...bodies.keys()].filter((id) => existsSync(join(expectDir, `${id}.json`)));
    if (!queue.length) die(`no requirement has both an expectation and a document`);
    const deviations: { id: string; agency: string; what: string; class: string; why: string; severity: number; quote: string }[] = [];
    const pending = [...queue];
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      for (let id = pending.shift(); id; id = pending.shift()) {
        const e = JSON.parse(readFileSync(join(expectDir, `${id}.json`), "utf8")) as
          { must_decide: string[]; must_surface: string[]; must_not: string[] };
        const said = await ask(COMPARE_SYSTEM, [
          `THE REQUIREMENT (${reqs[id].agency})`, "", reqs[id].brief, "",
          "WHAT A CAREFUL READER EXPECTED, knowing only that requirement", "",
          "MUST DECIDE:", ...e.must_decide.map((x) => `  - ${x}`),
          "MUST SURFACE:", ...e.must_surface.map((x) => `  - ${x}`),
          "MUST NOT:", ...e.must_not.map((x) => `  - ${x}`), "",
          `WHAT THE STEP ACTUALLY WROTE (${docName})`, "", bodies.get(id) ?? "",
        ].join("\n"));
        const found = (said.deviations as Record<string, unknown>[] ?? []).map((d) => ({
          id, agency: reqs[id].agency,
          what: String(d.what ?? "").trim(),
          class: String(d.class ?? "").trim().toLowerCase() === "generic" ? "generic" : "specific",
          why: String(d.why ?? "").trim(),
          severity: Math.max(1, Math.min(3, Number(d.severity) || 1)),
          quote: String(d.quote ?? "").trim(),
        })).filter((d) => d.what);
        deviations.push(...found);
        const g = found.filter((d) => d.class === "generic").length;
        console.log(`  ${id}  ${reqs[id].agency.slice(0, 24).padEnd(24)} ${found.length} deviation(s), ${g} generic`);
      }
    }));
    deviations.sort((a, b) => a.id.localeCompare(b.id));
    writeFileSync(join(out, "deviations.json"), `${JSON.stringify({ step, deviations }, null, 2)}\n`);
    const generic = deviations.filter((d) => d.class === "generic");
    console.log(`\n  ${deviations.length} deviations across ${queue.length} requirements`);
    console.log(`  ${generic.length} generic (the skill's habit)   ${deviations.length - generic.length} specific (this document's problem)`);
    console.log(`  written to ${join(out, "deviations.json")}`);
    console.log("\n  Only the generic ones can justify changing the skill. --pattern ranks them.\n");
    return 0;
  }

  if (args.flags.has("pattern")) {
    const devPath = join(out, "deviations.json");
    if (!existsSync(devPath)) die(`no deviations.json in ${out} — run --compare first`);
    const { deviations } = JSON.parse(readFileSync(devPath, "utf8")) as
      { deviations: { id: string; what: string; class: string; why: string; severity: number }[] };
    const generic = deviations.filter((d) => d.class === "generic");
    const corpus = new Set(deviations.map((d) => d.id)).size;
    if (!generic.length) {
      console.log(`\n  No generic deviations across ${corpus} requirements. Nothing to change at the`);
      console.log("  skill level: what went wrong went wrong in one document at a time.\n");
      return 0;
    }
    const said = await ask(PATTERN_SYSTEM, [
      `THE STEP: ${step}, across ${corpus} requirements in unrelated domains.`, "",
      "EVERY GENERIC DEVIATION FOUND", "",
      ...generic.map((d) => `  [${d.id}] (severity ${d.severity}) ${d.what} — ${d.why}`), "",
      "THE SKILL AS IT STANDS", "",
      readFileSync(flowPath(root, flow, "skills", step, "SKILL.md"), "utf8"),
    ].join("\n"), 0.2);

    console.log(`\n== ${step}: what goes wrong REPEATEDLY, across ${corpus} unrelated requirements\n`);
    for (const pt of (said.patterns as { pattern: string; seen_in: number; ids: string[] }[] ?? [])) {
      const share = corpus ? Math.round((pt.seen_in / corpus) * 100) : 0;
      console.log(`  ${String(pt.seen_in).padStart(2)}/${corpus} (${String(share).padStart(2)}%)  ${pt.pattern}`);
      console.log(`            ${(pt.ids ?? []).join(" ")}`);
    }
    if (!said.propose) {
      console.log("\n  No pattern reaches a third of the corpus. Proposing nothing — a rule written for");
      console.log("  a fault seen twice is read on every run forever and fires on almost none of them.\n");
      return 0;
    }
    console.log(`\n  PROPOSED GUIDELINE, after the line: ${String(said.anchor ?? "")}\n`);
    console.log(String(said.guideline ?? "").replace(/^/gm, "  | "));
    console.log("\n  This was read off THIS corpus. Measuring it on the same corpus fits the skill to");
    console.log("  the corpus and reports it as learning. Hold out requirements, or call it provisional.\n");
    return 0;
  }

  // The rubric lives beside the skill, not beside the run: it describes what good looks like for
  // the step, which outlives any one measurement of it. Not resolved through flowPath — --derive
  // writes it (below), so its absence going in is the normal case.
  const rubricPath = join(root, "catalog", flow, "skills", step, "evals/rubric.json");

  if (args.flags.has("derive")) {
    const skillPath = flowPath(root, flow, "skills", step, "SKILL.md");
    const samples = [...bodies.entries()].slice(0, 3)
      .map(([id, b]) => `--- example (${id}, ${reqs[id]?.agency}) ---\n${b.slice(0, 3000)}`);
    const said = await ask(DERIVE_SYSTEM, [
      "THE STEP'S OWN INSTRUCTIONS", "", readFileSync(skillPath, "utf8"), "",
      "WHAT IT ACTUALLY PRODUCED", "", ...samples,
    ].join("\n"), 0.3);
    const dims = (said.dimensions as Dimension[] ?? []).map((d) => ({
      name: String(d.name ?? "").trim(),
      five: String(d.five ?? "").trim(),
      one: String(d.one ?? "").trim(),
    })).filter((d) => d.name && d.five && d.one);
    if (dims.length < 3) die(`the judge proposed only ${dims.length} usable dimensions`);

    // ONE DIMENSION IS REQUIRED RATHER THAN DERIVED, and only for a selection. Asking a model to
    // read a step's own output and say what good looks like produces a rubric in that output's
    // own terms: the first derivation for sm-select produced five sharp dimensions about how a
    // fit ledger READS — verdict accuracy, candour about limits, specificity of rejections — and
    // not one about whether the blocks it picked were the right blocks. That is the circularity
    // of self-derivation. A step that always chose all three blocks would score full marks on
    // every derived dimension while being wrong every time, which is precisely the complaint
    // this tool was built to answer.
    //
    // It is marked as required so nobody later reads this rubric as five model opinions and one
    // smuggled-in opinion of mine wearing the same clothes.
    if (role === "selection") {
      dims.push({
        name: "Block choice (required, not derived)",
        five: "The set of blocks carried forward is the smallest set that covers the requirement. "
          + "Every block named is load-bearing — remove it and an acceptance criterion fails — and "
          + "no block that would have been load-bearing is missing. Where the requirement needs a "
          + "capability none of the blocks has, the answer is that it cannot be built, not the "
          + "nearest available assembly.",
        one: "Blocks are named that nothing in the requirement needs, or the requirement plainly "
          + "needs one that is absent. A requirement that no available block can meet is answered "
          + "with a combination of the blocks that exist. Judge the SET, not the prose about it: a "
          + "confident, well-argued ledger for the wrong three blocks scores 1 here.",
      });
    }
    const rubric: Rubric = {
      step, role,
      // Stamped from the run being read, not from the clock: a rubric derived from one corpus and
      // dated to another day reads as if it applied to both.
      derived_at: out,
      derived_from: `${bodies.size} documents at ${docName}`,
      dimensions: dims,
    };
    mkdirSync(dirname(rubricPath), { recursive: true });
    writeFileSync(rubricPath, `${JSON.stringify(rubric, null, 2)}\n`);
    console.log(`\n== RUBRIC for ${step} (${role}), derived from ${bodies.size} of its own documents\n`);
    for (const d of dims) {
      console.log(`  ${d.name}`);
      console.log(`    5 — ${d.five}`);
      console.log(`    1 — ${d.one}\n`);
    }
    console.log(`  written to ${rubricPath}`);
    console.log("  READ IT AND DISAGREE WITH IT before you trust a score that cites it. A rubric");
    console.log("  nobody argued with is one model's taste wearing the costume of a measurement.\n");
    return 0;
  }

  if (!existsSync(rubricPath)) die(`no rubric at ${rubricPath} — run with --derive first`);
  const rubric = JSON.parse(readFileSync(rubricPath, "utf8")) as Rubric;

  // A selection is judged on FIT, and fit is unjudgeable without knowing what the technology can
  // do. Every other role is judged on its own text.
  const capPath = join(root, "blocks/CAPABILITIES.md");
  const capabilities = role === "selection" && existsSync(capPath) ? readFileSync(capPath, "utf8") : "";

  if (args.flags.has("reflect")) {
    const judgedPath = join(out, "judged.json");
    if (!existsSync(judgedPath)) die(`no judged.json in ${out} — score the corpus before reflecting`);
    const judged = JSON.parse(readFileSync(judgedPath, "utf8")) as { judgements: Judgement[] };
    const weak = judged.judgements
      .flatMap((j) => [
        `${j.id}: ${j.worst.fix} — "${j.worst.quote.slice(0, 160)}"`,
        ...j.marks.filter((m) => m.score <= 3).map((m) => `${j.id} [${m.dimension} ${m.score}/5]: ${m.why}`),
      ]);
    const said = await ask(REFLECT_SYSTEM, [
      `THE STEP: ${step}, marked on ${judged.judgements.length} requirements.`, "",
      "EVERY WEAKNESS THE JUDGE FOUND", "", ...weak, "",
      "THE SKILL AS IT STANDS", "",
      readFileSync(flowPath(root, flow, "skills", step, "SKILL.md"), "utf8"),
    ].join("\n"), 0.2);
    console.log(`\n== THE RECURRING MISTAKE in ${step}, across ${judged.judgements.length} requirements\n`);
    if (!said.recurring) {
      console.log(`  None. ${String(said.pattern ?? "")}`);
      console.log("  Scattered faults are the ordinary cost of writing, not a skill defect.\n");
      return 0;
    }
    console.log(`  ${String(said.pattern ?? "")}`);
    console.log(`  seen in ${String(said.seen_in ?? "?")} of ${judged.judgements.length}\n`);
    for (const e of (said.evidence as string[] ?? []).slice(0, 6)) console.log(`    ${e}`);
    console.log("\n  PROPOSED ADDITION:\n");
    console.log(String(said.passage ?? "").replace(/^/gm, "  | "));
    console.log("\n  Measure it on requirements it was NOT derived from, or the next number is a fit.\n");
    return 0;
  }

  // THE CONTROL. Each document is marked against its NEIGHBOUR's brief. Nothing else changes —
  // same rubric, same judge, same temperature — so the only thing the score can be responding to
  // is whether the document actually answers the requirement in front of it.
  const ids = [...bodies.keys()];
  const control = args.flags.has("control");
  const briefFor = (id: string): string => {
    if (!control) return reqs[id].brief;
    return reqs[ids[(ids.indexOf(id) + 1) % ids.length]].brief;
  };

  const system = judgeSystem(rubric, capabilities);

  // FOUR AT A TIME. Each judgement is one long read by a capable model and takes minutes; a
  // thirty-requirement corpus done strictly one after another takes hours, and an evaluation
  // nobody will wait for is one that stops being run. Four is bounded on purpose — the judge is
  // the same account the flow itself runs under, and saturating it makes every OTHER measurement
  // on this machine slower and blames the slowness on whatever ran next.
  const judgements: Judgement[] = [];
  const judgeOne = async (id: string): Promise<Judgement> => {
    const r = reqs[id];
    const said = await ask(system, [
      `THE REQUIREMENT (${r.agency})`, "", briefFor(id), "",
      `THE ${role.toUpperCase()} THAT WAS WRITTEN FOR IT`, "", bodies.get(id) ?? "",
    ].join("\n"));
    const marks = (said.marks as Mark[] ?? []).map((m) => ({
      dimension: String(m.dimension ?? ""),
      score: Math.max(1, Math.min(5, Number(m.score) || 1)),
      quote: String(m.quote ?? "").trim(),
      why: String(m.why ?? "").trim(),
    })).filter((m) => m.dimension);
    const worst = (said.worst ?? {}) as { quote?: string; fix?: string };
    return {
      id, agency: r.agency, marks,
      worst: { quote: String(worst.quote ?? "").trim(), fix: String(worst.fix ?? "").trim() },
      mean: mean(marks.map((m) => m.score)),
      addressed: said.addressed !== false,
    };
  };

  const queue = [...ids];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const j = await judgeOne(next);
      judgements.push(j);
      const bar = "\u2588".repeat(Math.round(j.mean)).padEnd(5, "\u00b7");
      console.log(`  ${j.id}  ${bar} ${j.mean.toFixed(1)}  ${j.agency.slice(0, 28).padEnd(28)} ${j.worst.fix.slice(0, 60)}`);
    }
  }));
  // Finished out of order because they ran concurrently; the file should read in corpus order.
  judgements.sort((a, b) => a.id.localeCompare(b.id));

  const overall = mean(judgements.map((j) => j.mean));
  const perDim = rubric.dimensions.map((d) => ({
    name: d.name,
    mean: mean(judgements.flatMap((j) => j.marks.filter((m) => m.dimension === d.name).map((m) => m.score))),
  }));

  const file = join(out, control ? "judged-control.json" : "judged.json");
  writeFileSync(file, `${JSON.stringify({ step, version: rubric.step, control, overall, perDim, judgements }, null, 2)}\n`);

  console.log(`\n  ${control ? "CONTROL " : ""}overall ${overall.toFixed(2)} of 5 across ${judgements.length} requirements`);
  for (const d of perDim) console.log(`    ${d.name.padEnd(34)} ${d.mean.toFixed(2)}`);
  console.log(`  written to ${file}`);

  if (control) {
    console.log("\n  This run marked every document against the WRONG requirement. Compare it to the");
    console.log("  real run: a judge that reads collapses here. A judge that rewards confident prose");
    console.log("  scores about the same, and every quality number it produced is worthless.\n");
  } else {
    const off = judgements.filter((j) => !j.addressed).length;
    if (off) console.log(`  ${off} document(s) the judge says answer a different problem entirely`);
    console.log("\n  Run --control before believing any of this, then --reflect for the pattern.\n");
  }
  return 0;
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (err) {
  console.error(String((err as Error)?.message ?? err));
  process.exit(2);
}
