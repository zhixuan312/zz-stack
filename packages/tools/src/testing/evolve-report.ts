/**
 * evolve-report — which STEP is not working, and the platform's own words for why.
 *
 *   zz-tool evolve-report [--since '30 days'] [--psql '<command>']
 *
 * The loop this serves: evidence arrives, something is found not to work, a skill or a
 * guardrail or a contract changes, the suite re-verifies, and the next round's evidence says
 * whether the change was right. Two of those steps already had tools — tool-report says which
 * TOOL is refused and flow-compare says which FLOW costs more — and the one in between did
 * not. Neither answers "ops-select is where this stalls", which is the only form of the answer
 * a skill can be edited from.
 *
 * ATTRIBUTION BY TRACE, NOT BY GUESS. Every `skill_view` says which skill an agent loaded;
 * everything it does next, it does while following that skill. So the refusals that follow a
 * load are attributable to the step being followed, per actor, in order. Nothing here infers
 * a stage from a document name — a flow may write the same document from more than one step,
 * and the point is to be wrong less often than prose is.
 *
 * The refusal TEXT is the output that matters, not the count. These are the platform's own
 * sentences, written to say which rule was broken, and grouped by class they are the natural
 * language feedback that reflective prompt evolution needs and most teams cannot produce. A
 * count says a step is expensive; the sentence says what to change.
 *
 * Run by an analyst, never installed beside the agent being measured. Improvement is a
 * service the platform owes its users, not homework it sets them — and letting the thing
 * under evaluation run its own evaluation is the fastest way to make one meaningless.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { parseEnvelope, refusalClass } from "@zz/contracts";

import { parseArgs } from "../lib/cli.js";
import { DEFAULT_PSQL, psqlRows } from "../lib/psql.js";

const SHOW = 3;

/** A row of zz.tool_call. Flat columns, because the table has them: this used to be a
 * `subject` string to split and a `detail` bag to reach into, and every reader spelled the
 * reaching-in slightly differently. */
interface CallRow {
  ts: string;
  /** A stable hash, never a person. Only used to correlate one conversation. */
  caller: string | null;
  surface: string;
  tool: string;
  step: string | null;
  step_version: string | null;
  step_sha: string | null;
  block: string | null;
  block_version: string | null;
  /** null on rows written before outcomes were recorded — an era, not a missing value. */
  ok: boolean | null;
  refusal: string | null;
  ids: Record<string, string> | null;
}

function calls(psql: string, since: string): CallRow[] {
  return psqlRows<CallRow>(psql,
    "select ts, caller, surface, tool, step, step_version, step_sha, block, block_version," +
    " ok, refusal, ids from zz.event" +
    " where kind = 'tool_call' and ts > now() - (:'since')::interval order by id", { since });
}

/** block -> the version our skill for it was verified against, read from the skills.
 *
 * From the files, never a list typed here: a second copy of which block a skill is pinned to
 * is a copy that goes stale on the first edit, and the whole point of this section is to catch
 * a number that moved. */
const VERIFIED_AGAINST: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === ".git" || e === "dist") continue;
      const full = join(dir, e);
      try {
        if (statSync(full).isDirectory()) { walk(full); continue; }
      } catch { continue; }
      if (e !== "SKILL.md") continue;
      const env = parseEnvelope(readFileSync(full, "utf8"));
      if (env.block && env.verified_against) {
        out[env.block] = env.verified_against.replace(/^["']|["']$/g, "");
      }
    }
  };
  walk("skills");
  walk("blocks");
  walk("catalog");
  return out;
})();

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
  /** What each block said it was, from its own handshake, as recorded on the calls to it. */
  const blockVersions = new Map<string, string>();
  /** step -> version -> {calls, refusals}. A step measured across two versions of itself is
   * the only shape in which "the change worked" is a statement about evidence. */
  const versions = new Map<string, Map<string, { calls: number; refusals: number }>>();

  for (const e of rows) {
    const tool = e.tool;
    const ids = e.ids ?? {};
    // THE ROW SAYS WHICH STEP, when it was written by a gateway that knew. Attribution is
    // decided at the door now — per conversation, with an expiry, and with the hash of the
    // skill text the model was actually served — so this reads a fact instead of re-deriving
    // a guess. Re-derivation keyed on the PERSON and never expired: one human running two
    // conversations had every call attributed to whichever skill either had loaded last.
    //
    // The trace below still runs for rows written before that existed. It is the same rule
    // the gateway now applies once, kept here only so old evidence stays readable — and it is
    // marked, because a number that mixes an exact attribution with a heuristic one and says
    // neither is the kind of measurement this whole report exists to replace.
    if (e.block && e.block_version) blockVersions.set(e.block, e.block_version);
    const stamped = e.step ?? "";
    if (tool === "skill_view" && !stamped) {
      if (ids.name) following.set(e.caller ?? "", ids.name);
      continue;
    }
    if (stamped) derivedFromRow += 1; else derivedByTrace += 1;
    const skill = stamped || following.get(e.caller ?? "");
    // Work done before any skill was loaded belongs to no step. Counted and reported rather
    // than folded into whichever step came first, which would blame a step for calls made
    // before anyone had read it.
    if (!skill) { if (e.refusal) unattributed += 1; continue; }
    const s = step(skill);
    s.calls += 1;
    // PER VERSION OF THE STEP. `step_sha` is the hash of the skill text the model was served,
    // so this table is the one that can say a change worked: the same step, two versions, two
    // refusal counts. Rows written before the gateway stamped it fall under `(unversioned)`
    // rather than being folded into whichever version came later — a change credited with a
    // result from before it existed is worse than no result.
    {
      const sha = e.step_sha || "(unversioned)";
      let per = versions.get(skill);
      if (!per) { per = new Map(); versions.set(skill, per); }
      let v = per.get(sha);
      if (!v) { v = { calls: 0, refusals: 0 }; per.set(sha, v); }
      v.calls += 1;
      if (e.refusal) v.refusals += 1;
    }
    // WHAT A PERSON SENT BACK, beside what the platform refused.
    //
    // A refusal is the platform saying a rule was broken. A revision is a PERSON saying the
    // document was wrong — the richest signal there is about a step, and the one this report
    // was blind to. `revise_document` exists precisely because somebody's words changed a
    // document, and `add_source` after a gate is material that arrived too late to have been
    // considered. Both are recorded on every run and neither reached the improvement loop.
    //
    // Counted, never quoted. The reasons live in the team's own store — a source document, a
    // no_signoff_reason — and reading those into a platform report would carry a tenant's
    // words across a boundary that is deliberately one-way: conclusions cross, files do not.
    // The count says WHICH STEP to go and read; the reading needs the team's own access.
    if (tool === "revise_document" && e.ok) s.revisions += 1;
    if (tool === "add_source" && e.ok) s.lateSources += 1;
    if (!e.refusal) continue;
    s.refusals += 1;
    const cls = refusalClass(e.refusal);
    s.classes.set(cls, (s.classes.get(cls) ?? 0) + 1);
    s.tools.set(tool, (s.tools.get(tool) ?? 0) + 1);
  }

  // Ranked by what a step COSTS, which is refusals plus the rounds a person spent sending it
  // back. Ranking on refusals alone put a step that never refuses and is rewritten three
  // times every run below one that refuses twice and is right the first time.
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

  // The change is a person's to make. This says which step and hands over the sentences; it
  // does not propose an edit, because a proposal generated from the same data that produced
  // the problem reads as evidence and is not.
  console.log("  Each ERROR line is the platform's own refusal, saying which rule was broken.");
  console.log("  A step SENT BACK is a person saying the document was wrong, which no refusal");
  console.log("  can tell you — go and read those revisions in the team's own store, with their");
  console.log("  access: the reason is in the source they attached, and it is theirs, not ours.");
  console.log("  That is the feedback to edit a skill, a guardrail or a block contract from —");
  console.log("  then re-run the suite, and the next round of this report says whether it worked.");
  if (unattributed) {
    console.log(`\n  ${unattributed} refusals happened before any skill was loaded, and belong to no step.`);
  }

  // DID THE CHANGE WORK. Every other table here says which step is expensive; this is the
  // only one that can say whether editing it helped, because it splits a step by the hash of
  // the skill text the model was actually served. Two versions, two refusal rates, same step.
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

  // THE GROUND MOVING UNDER US. A usage skill is written on top of a block nobody here
  // controls, and when that block changes every trap the skill records may have stopped being
  // true — silently, because nothing on our side moved. The block states its own version at
  // the MCP handshake and the platform stamps it on every call, so this is a query rather than
  // something anyone has to remember to check.
  //
  // What it CANNOT do is say the skill is now wrong. A version that moved is a reason to
  // re-verify, never a finding on its own — and reporting it as a defect would train the
  // reader to skip the line.
  if (blockVersions.size) {
    console.log(`\n  ── BLOCK VERSIONS SEEN, against what our skills were verified on ────`);
    for (const [b, seen] of [...blockVersions].sort()) {
      const pinned = VERIFIED_AGAINST[b];
      const state = !pinned ? "no skill of ours is pinned to this block"
        : pinned === seen ? `matches ${pinned} — the claims were checked against this`
        : `WAS VERIFIED AGAINST ${pinned} — re-verify what our skill says about it`;
      console.log(`  ${b.padEnd(14)} reports ${String(seen).padEnd(28)} ${state}`);
    }
  }

  // HOW THE ATTRIBUTION WAS MADE. An exact answer and a heuristic one reported as one number
  // is the failure this whole report exists to end, so the mix is stated rather than assumed.
  if (derivedByTrace || derivedFromRow) {
    console.log(`\n  Attribution: ${derivedFromRow} call(s) stamped by the gateway with the step`);
    console.log(`  they belonged to; ${derivedByTrace} recovered by replaying skill loads in order,`);
    console.log(`  which keys on the caller and cannot separate two conversations at once.`);
  }
  console.log();
  return 0;
}

process.exit(main());
