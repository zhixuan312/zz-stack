/**
 * evolve-report — which step is not working, and the platform's own words for why.
 *
 *   zz-tool evolve-report [--since '30 days'] [--psql '<command>']
 *
 * tool-report says which tool is refused; it does not answer "sdlc-spec is where this stalls",
 * which is the only form of the answer a skill can be edited from.
 *
 * Attribution is by trace, not by guess. Every `skill_read` says which skill an agent loaded, and
 * everything it does next it does while following that skill, so the refusals that follow a load are
 * attributable to the step being followed, per actor, in order. Nothing here infers a stage from a
 * document name — a flow may write the same document from more than one step.
 *
 * The refusal text is the output that matters, not the count: these are the platform's own sentences
 * saying which rule was broken. A count says a step is expensive; the sentence says what to change.
 *
 * Run by an analyst, never installed beside the agent being measured.
 */
import { refusalClass, resolveStep, resolveTool } from "@zz/contracts";

import { parseArgs } from "../lib/cli.js";
import { DEFAULT_PSQL, psqlRows } from "../lib/psql.js";

const SHOW = 3;

/** A row of zz.tool_call. Flat columns, because the table has them. */
interface CallRow {
  ts: string;
  /** A stable hash, never a person. Only used to correlate one conversation. */
  caller: string | null;
  surface: string;
  tool: string;
  step: string | null;
  step_version: string | null;
  step_sha: string | null;
  /** null on rows written before outcomes were recorded — an era, not a missing value. */
  ok: boolean | null;
  refusal: string | null;
  ids: Record<string, string> | null;
}

function calls(psql: string, since: string): CallRow[] {
  return psqlRows<CallRow>(psql,
    "select ts, caller, surface, tool, step, step_version, step_sha," +
    " ok, refusal, ids from zz.event" +
    " where kind = 'tool_call' and ts > now() - (:'since')::interval order by id", { since });
}


interface Step {
  skill: string;
  calls: number;
  refusals: number;
  classes: Map<string, number>;
  tools: Map<string, number>;
  /** A person said something and the document went to the next version. */
  revisions: number;
  /** Material a person attached after a gate had already closed. */
  lateSources: number;
}

function main(): number {
  const { flags } = parseArgs(process.argv.slice(2));
  const psql = flags.get("psql") || DEFAULT_PSQL;
  const since = flags.get("since") || "30 days";

  const rows = calls(psql, since);
  if (!rows.length) {
    console.log(`\n  No tool calls in the last ${since}. Nothing to learn from yet.\n`);
    return 1;
  }

  const steps = new Map<string, Step>();
  const step = (skill: string): Step => {
    let s = steps.get(skill);
    if (!s) {
      s = { skill, calls: 0, refusals: 0, classes: new Map(), tools: new Map(),
            revisions: 0, lateSources: 0 };
      steps.set(skill, s);
    }
    return s;
  };

  // The skill each actor is currently following. In event order, so this is the trace as it
  // happened rather than a reconstruction.
  const following = new Map<string, string>();
  let unattributed = 0;

  // How each row's step was decided. Printed, because mixing an exact attribution with a
  // heuristic one without saying so is the failure this report was built to end.
  let derivedFromRow = 0;
  let derivedByTrace = 0;
  /** step -> version -> {calls, refusals}. A step measured across two versions of itself is
   * the only shape in which "the change worked" is a statement about evidence. */
  const versions = new Map<string, Map<string, { calls: number; refusals: number }>>();

  for (const e of rows) {
    // Resolved through the alias for its surface so a window spanning a rename does not read
    // as a second tool — the same fold `tool-report` applies to `subject`, applied here to
    // `surface`/`tool` kept as separate columns.
    const tool = resolveTool(e.surface, e.tool);
    const ids = e.ids ?? {};
    // The row says which step, when it was written by a gateway that knew: attribution is decided at
    // the door — per conversation, with an expiry, and with the hash of the skill text the model was
    // actually served. Re-deriving it keys on the person and never expires, so one human running two
    // conversations has every call attributed to whichever skill either loaded last.
    //
    // The trace below still runs for rows written before that existed, and is marked, because a
    // number mixing an exact attribution with a heuristic one and saying neither is what this report
    // exists to replace.
    // Resolved through SKILL_ALIAS so a step renamed mid-window is one series, not two.
    const stamped = e.step ? resolveStep(e.step) : "";
    if (tool === "skill_read" && !stamped) {
      if (ids.name) following.set(e.caller ?? "", resolveStep(ids.name));
      continue;
    }
    if (stamped) derivedFromRow += 1; else derivedByTrace += 1;
    const skill = stamped || following.get(e.caller ?? "");
    // Work done before any skill was loaded belongs to no step. Counted and reported rather than
    // folded into whichever step came first, which would blame a step for calls made before anyone
    // had read it.
    if (!skill) { if (e.refusal) unattributed += 1; continue; }
    const s = step(skill);
    s.calls += 1;
    // Per version of the step. `step_sha` is the hash of the skill text the model was served, so
    // this table is the one that can say a change worked: same step, two versions, two refusal
    // counts. Rows written before the gateway stamped it fall under `(unversioned)` rather than
    // being folded into whichever version came later.
    {
      const sha = e.step_sha || "(unversioned)";
      let per = versions.get(skill);
      if (!per) { per = new Map(); versions.set(skill, per); }
      let v = per.get(sha);
      if (!v) { v = { calls: 0, refusals: 0 }; per.set(sha, v); }
      v.calls += 1;
      if (e.refusal) v.refusals += 1;
    }
    // What a person sent back, beside what the platform refused. A refusal is the platform saying a
    // rule was broken; a revision is a person saying the document was wrong. `source_add` after a
    // gate is material that arrived too late to have been considered.
    //
    // Counted, never quoted. The reasons live in the team's own store — a source document, a
    // no_signoff_reason — and reading those into a platform report would carry a tenant's words
    // across a boundary that is deliberately one-way: conclusions cross, files do not. The count
    // says which step to go and read.
    if (tool === "document_revise" && e.ok) s.revisions += 1;
    if (tool === "source_add" && e.ok) s.lateSources += 1;
    if (!e.refusal) continue;
    s.refusals += 1;
    const cls = refusalClass(e.refusal);
    s.classes.set(cls, (s.classes.get(cls) ?? 0) + 1);
    s.tools.set(tool, (s.tools.get(tool) ?? 0) + 1);
  }

  // Ranked by what a step costs: refusals plus the rounds a person spent sending it back. Ranking on
  // refusals alone puts a step that never refuses and is rewritten three times every run below one
  // that refuses twice and is right the first time.
  const ranked = [...steps.values()]
    .filter((s) => s.refusals > 0 || s.revisions > 0)
    .sort((a, b) => (b.refusals + b.revisions) - (a.refusals + a.revisions)
                 || a.skill.localeCompare(b.skill));

  if (!ranked.length) {
    console.log(`\n  ${rows.length} calls in the last ${since}, and no refusal followed any skill.`);
    console.log("  Nothing here says a step needs changing.\n");
    return 0;
  }

  console.log(`\n  Where the work stalls, last ${since}\n`);
  for (const s of ranked) {
    const rate = s.calls ? ((s.refusals / s.calls) * 100).toFixed(1) : "0.0";
    console.log(`  ${s.skill}  —  ${s.refusals} refused of ${s.calls} calls (${rate}%)` +
      (s.revisions ? `, ${s.revisions} sent back by a person` : "") +
      (s.lateSources ? `, ${s.lateSources} arrived after a gate` : ""));
    const worst = [...s.classes].sort((a, b) => b[1] - a[1]).slice(0, SHOW);
    for (const [cls, n] of worst) {
      const tools = [...s.tools].sort((a, b) => b[1] - a[1]).slice(0, 2).map((t) => t[0]).join(", ");
      console.log(`      ${String(n).padStart(3)} x  ${cls.slice(0, 150)}`);
      if (tools) console.log(`             on ${tools}`);
    }
    console.log();
  }

  // The change is a person's to make. This says which step and hands over the sentences; it does not
  // propose an edit, because a proposal generated from the same data that produced the problem reads
  // as evidence and is not.
  console.log("  Each ERROR line is the platform's own refusal, saying which rule was broken.");
  console.log("  A step SENT BACK is a person saying the document was wrong, which no refusal");
  console.log("  can tell you — go and read those revisions in the team's own store, with their");
  console.log("  access: the reason is in the source they attached, and it is theirs, not ours.");
  console.log("  That is the feedback to edit a skill or a guardrail from —");
  console.log("  then re-run the suite, and the next round of this report says whether it worked.");
  if (unattributed) {
    console.log(`\n  ${unattributed} refusals happened before any skill was loaded, and belong to no step.`);
  }

  // Did the change work. The only table here that can say whether editing a step helped, because it
  // splits a step by the hash of the skill text the model was actually served.
  const multi = [...versions].filter(([, per]) => per.size > 1);
  if (multi.length) {
    console.log(`\n  ── THE SAME STEP, ACROSS VERSIONS OF ITSELF ─────────────────────────`);
    console.log(`  A version is the hash of the skill text the model was served, not a number`);
    console.log(`  anybody typed. Rows written before the gateway recorded it are (unversioned)`);
    console.log(`  and are kept apart: a change credited with a result from before it existed`);
    console.log(`  is worse than no result at all.\n`);
    for (const [skill, per] of multi) {
      console.log(`  ${skill}`);
      for (const [sha, v] of [...per].sort((a, b) => b[1].calls - a[1].calls)) {
        const rate = v.calls ? ((v.refusals / v.calls) * 100).toFixed(1) : "0.0";
        console.log(`    ${sha.padEnd(14)} ${String(v.calls).padStart(5)} calls  ${String(v.refusals).padStart(4)} refused  ${rate}%`);
      }
    }
  } else if (versions.size) {
    console.log(`\n  Every step has been seen under ONE version only, so nothing here can say`);
    console.log(`  whether a change helped. Change a skill, run the flow again, and this table`);
    console.log(`  becomes the comparison.`);
  }

  // How the attribution was made. An exact answer and a heuristic one reported as one number is what
  // this report exists to end, so the mix is stated rather than assumed.
  if (derivedByTrace || derivedFromRow) {
    console.log(`\n  Attribution: ${derivedFromRow} call(s) stamped by the gateway with the step`);
    console.log(`  they belonged to; ${derivedByTrace} recovered by replaying skill loads in order,`);
    console.log(`  which keys on the caller and cannot separate two conversations at once.`);
  }
  console.log();
  return 0;
}

process.exit(main());
