/**
 * loop-eval — did each skill REACH the work, and is there a definition of good for it.
 *
 *   zz-tool loop-eval [--since '7 days'] [--team <slug>] [--psql '<command>'] [--json]
 *
 * WHAT THIS ANSWERS THAT eval-store CANNOT. The eval pipeline judges DOCUMENTS: a rubric, a
 * judge, a score per dimension. That is the right instrument for the six ops-flow steps, and
 * it is blind to most of the platform. Of 40 registered skills, 5 produce a gated document.
 * The other 35 — every block_usage skill, every sdlc step, casebox-assist — can be excellent or
 * never read at all, and a document-only pipeline reports the same thing either way: nothing.
 *
 * So this measures REACH rather than quality, from telemetry the gateway already writes.
 * Between them the two instruments cover the estate: eval-store says whether the output was
 * good, loop-eval says whether the skill was in the room.
 *
 * THE THREE VERDICTS, and the third is the one worth building a tool for:
 *
 *   not exercised   Zero loads, zero calls stamped to it, in this window. Says nothing about
 *                   the skill — the work it covers did not come up. Not a defect.
 *
 *   NOT CONSULTED   Its block was called, repeatedly, and the skill was never loaded in any
 *                   of those runs. This is the finding that motivated the tool. On 2026-09-04
 *                   an agent made eight casebox calls while choosing casebox for a case-management
 *                   requirement and loaded none of casebox's four published skills — including
 *                   `using-casebox`, whose own when_to_use says to read it FIRST in
 *                   any session that touches the block. Nothing refused, nothing scored
 *                   badly, and the document came out at 4.67. The skill was simply never in
 *                   the room, and no existing instrument could say so.
 *
 *   consulted       Loaded. Refusals stamped to it are then worth reading, because a refusal
 *                   under a skill that WAS read is evidence about the skill; the same refusal
 *                   under one that was not is evidence about routing.
 *
 * WHY REACH IS A PLATFORM PROBLEM, NOT A BLOCK'S. A block team writes skills, we vendor them,
 * the gateway serves them — and then one of OUR skills decides whether anyone reads them.
 * In the run above the step stamp on all eight calls was `blocks-capabilities`, ours, which
 * teaches discovery by probing `read_api_spec` and the getters. Probing SUBSTITUTES for
 * reading what the block team already wrote down. That is a fine-tuning target with a
 * precise address, and it is invisible without this join.
 *
 * NOT ERRORING IS NOT SUCCEEDING. An empty window exits 2, never 0: a platform with users
 * does not have a silent week, so seeing nothing means this is pointed at the wrong database
 * far more often than it means all is well. Same rule watch-results is built on.
 *
 * Exit status is the interface: 0 every skill with a block was consulted, 1 at least one was
 * not, 2 it could not tell.
 */
import { refusalClass } from "@zz/contracts";

import { optional, parseArgs } from "../lib/cli.js";
import { DEFAULT_PSQL, psqlRows } from "../lib/psql.js";

/** Below this many calls, "never consulted" is not yet a pattern — one probe of a block is
 *  how you find out you do not need it, and reporting that as a failure would train the
 *  reader to ignore the report. */
const CALLS_BEFORE_IT_MEANS_SOMETHING = 3;

interface SkillRow {
  name: string; kind: string; owner: string | null; origin: string | null;
  loads: number; stamped: number; refused: number; rubrics: number; blind_runs: number;
  retired: boolean;
}
interface BlockRow {
  block: string; origin: string; skills: number;
  runs_calling: number; runs_not_consulting: number; calls: number;
}
interface RefusalRow { step: string; refusal: string }

/** The window, as one interval every query shares. A window that differed between two
 *  sections of one report would make the sections disagree for a reason no reader could see. */
function since(args: ReturnType<typeof parseArgs>): string {
  return optional(args, "since", "a postgres interval, e.g. '7 days'") ?? "7 days";
}

function main(argv: string[]): number {
  const args = parseArgs(argv, ["json"]);
  const psql = optional(args, "psql", "how to reach the database") ?? DEFAULT_PSQL;
  const win = since(args);
  const team = optional(args, "team", "one team's activity only");
  // The team filter is a predicate rather than a second query, so every section narrows
  // together or not at all.
  const scope = team ? `and e.team_slug = '${team.replace(/'/g, "''")}'` : "";

  // `blind_runs` is the whole point, and the first version of this file did not have it: it
  // counted loads GLOBALLY, so `using-casebox` reported "consulted" on 10 loads while
  // the one run that actually called casebox read nothing. Both numbers were true and the verdict
  // was false — a skill read in some other session did not help the session that needed it.
  // Reach is a per-run question or it is not a question.
  const skills = psqlRows<SkillRow>(psql, `
    with calling as (
      select distinct e.detail->>'run' as run, e.block
        from zz.event e
       where e.ts > now() - :'win'::interval and e.kind = 'tool_call'
         and e.block is not null and e.detail ? 'run' ${scope}
    ),
    loaded as (
      select distinct e.detail->>'run' as run, e.detail->'ids'->>'name' as name
        from zz.event e
       where e.ts > now() - :'win'::interval and e.kind = 'tool_call'
         and e.subject = 'core:skill_view' and e.detail ? 'run' ${scope}
    )
    select s.name, s.kind, coalesce(s.flow, b.name) as owner, b.origin,
           (select count(*) from calling c
              left join loaded lo on lo.run = c.run and lo.name = s.name
             where c.block = b.name and lo.run is null) as blind_runs,
           (select count(*) from zz.event e
             where e.ts > now() - :'win'::interval and e.kind = 'tool_call'
               and e.subject = 'core:skill_view'
               and e.detail->'ids'->>'name' = s.name ${scope}) as loads,
           (select count(*) from zz.event e
             where e.ts > now() - :'win'::interval and e.step = s.name ${scope}) as stamped,
           (select count(*) from zz.event e
             where e.ts > now() - :'win'::interval and e.step = s.name
               and e.ok is false ${scope}) as refused,
           (select count(*) from zz.rubric r where r.skill_id = s.id) as rubrics,
           s.retired
      from zz.skill s left join zz.block b on b.id = s.block_id
     order by s.kind, coalesce(s.flow, b.name), s.name`, { win });

  // THE JOIN THAT MATTERS: runs that CALLED a block, against runs that LOADED one of that
  // block's skills. `detail->>'run'` is the gateway's own run id, so a "run" here is one
  // agent session — the unit in which reading a skill would actually have helped.
  const blocks = psqlRows<BlockRow>(psql, `
    with calling as (
      select distinct e.detail->>'run' as run, e.block
        from zz.event e
       where e.ts > now() - :'win'::interval and e.kind = 'tool_call'
         and e.block is not null and e.detail ? 'run' ${scope}
    ),
    loading as (
      select distinct e.detail->>'run' as run, b.name as block
        from zz.event e
        join zz.skill s on s.name = e.detail->'ids'->>'name'
        join zz.block b on b.id = s.block_id
       where e.ts > now() - :'win'::interval and e.kind = 'tool_call'
         and e.subject = 'core:skill_view' ${scope}
    )
    select c.block, bk.origin,
           (select count(*) from zz.skill s where s.block_id = bk.id) as skills,
           count(*) as runs_calling,
           count(*) filter (where l.run is null) as runs_not_consulting,
           (select count(*) from zz.event e
             where e.ts > now() - :'win'::interval and e.block = c.block ${scope}) as calls
      from calling c
      join zz.block bk on bk.name = c.block
      left join loading l on l.run = c.run and l.block = c.block
     where exists (select 1 from zz.skill s where s.block_id = bk.id)
     group by c.block, bk.origin, bk.id
     order by 5 desc, 1`, { win });

  const refusals = psqlRows<RefusalRow>(psql, `
    select e.step, e.refusal
      from zz.event e
     where e.ts > now() - :'win'::interval and e.ok is false
       and e.refusal is not null and e.step is not null ${scope}`, { win });

  const activity = skills.reduce((n, s) => n + Number(s.loads) + Number(s.stamped), 0);

  // Enough calls on the block for a blind run to mean anything. Held per block so one probe
  // of a block nobody ended up using is not reported as a failure to read its manual.
  const busy = new Map(blocks.map((b) => [b.block, Number(b.calls)]));

  /** The verdict, decided ONCE and before the output branches. It was computed inside the
   *  human-readable loop, so `--json` — the mode cron consumes — returned 0 on a run whose
   *  headline finding was five skills nobody read. "Exit status is the interface" has to hold
   *  in the machine-readable mode first of all. */
  const verdictFor = (s: SkillRow): string => {
    const loads = Number(s.loads), stamped = Number(s.stamped), blind = Number(s.blind_runs ?? 0);
    // A RETIRED skill is not a routing failure. It no longer ships, so nothing could have
    // loaded it; counting it would inflate every block that ever renamed a skill.
    if (s.retired) return "retired — kept for the documents it attributes";
    const blockBusy = s.owner ? (busy.get(s.owner) ?? 0) >= CALLS_BEFORE_IT_MEANS_SOMETHING : false;
    if (s.kind === "block_usage" && blind > 0 && blockBusy) {
      return `NOT CONSULTED in ${blind} run(s) that used ${s.owner}`;
    }
    if (loads === 0 && stamped === 0) return "not exercised";
    if (loads === 0) return "stamped but never loaded";
    return "consulted";
  };
  const notConsulted = skills.filter((s) => verdictFor(s).startsWith("NOT CONSULTED")).length;

  if (args.flags.has("json")) {
    console.log(JSON.stringify({
      window: win, team: team ?? null, notConsulted,
      skills: skills.map((s) => ({ ...s, verdict: verdictFor(s) })), blocks, refusals,
    }, null, 2));
    return activity === 0 ? 2 : notConsulted ? 1 : 0;
  }

  console.log(`\n  loop-eval — last ${win}${team ? `, team ${team}` : ""}\n`);
  if (activity === 0) {
    console.log("  NO SKILL ACTIVITY AT ALL in this window.\n");
    console.log("  That is an alert, not an all-clear. A platform with users does not have a");
    console.log("  silent week — check --since and --psql before believing this.\n");
    return 2;
  }

  // Refusals grouped by the shared classifier, so the same refusal reads the same way here,
  // in watch-results, in tool-report and in the console.
  const byStep = new Map<string, Map<string, number>>();
  for (const r of refusals) {
    const cls = refusalClass(r.refusal).slice(0, 90);
    const m = byStep.get(r.step) ?? new Map<string, number>();
    m.set(cls, (m.get(cls) ?? 0) + 1);
    byStep.set(r.step, m);
  }

  console.log("  REACH — was the skill in the room\n");
  console.log(`    ${"skill".padEnd(22)}${"owner".padEnd(16)}${"loads".padStart(6)}` +
              `${"calls".padStart(7)}${"refused".padStart(9)}  verdict`);
  for (const s of skills) {
    const loads = Number(s.loads), stamped = Number(s.stamped);
    const verdict = verdictFor(s);
    console.log(`    ${s.name.padEnd(22)}${(s.owner ?? "").padEnd(16)}` +
                `${String(loads).padStart(6)}${String(stamped).padStart(7)}` +
                `${String(s.refused).padStart(9)}  ${verdict}`);
    for (const [cls, n] of byStep.get(s.name) ?? []) {
      console.log(`      ${String(n).padStart(4)}x ${cls}`);
    }
  }

  console.log("\n  BLOCKS — runs that used a block without reading its skills\n");
  if (!blocks.length) {
    console.log("    No block with published skills was called in this window.");
  } else {
    console.log(`    ${"block".padEnd(14)}${"origin".padEnd(11)}${"skills".padStart(7)}` +
                `${"calls".padStart(7)}${"runs".padStart(6)}${"blind".padStart(7)}`);
    for (const b of blocks) {
      const blind = Number(b.runs_not_consulting);
      const flag = blind > 0 && Number(b.calls) >= CALLS_BEFORE_IT_MEANS_SOMETHING ? "  <—" : "";
      console.log(`    ${b.block.padEnd(14)}${b.origin.padEnd(11)}${String(b.skills).padStart(7)}` +
                  `${String(b.calls).padStart(7)}${String(b.runs_calling).padStart(6)}` +
                  `${String(blind).padStart(7)}${flag}`);
    }
    console.log("\n    'blind' = runs that called the block and never loaded one of its skills.");
  }

  // WHAT GOOD IS. A skill with no rubric cannot be scored, improved against a target, or
  // shown to have regressed — so this is reported as a gap in the platform rather than as a
  // property of the skill. It is the list to work down, in call order: the most-used skill
  // with no definition of good is the most expensive thing here.
  // Retired skills are excluded: a skill that no longer ships cannot be improved, so asking
  // for a definition of good for one is asking for work that can never pay off.
  const undefined_ = skills.filter((s) => Number(s.rubrics) === 0 && !s.retired)
    .sort((a, b) => (Number(b.loads) + Number(b.stamped)) - (Number(a.loads) + Number(a.stamped)));
  const live = skills.filter((s) => !s.retired).length;
  console.log(`\n  NO DEFINITION OF GOOD — ${undefined_.length} of ${live} live skills have no rubric\n`);
  for (const s of undefined_.slice(0, 12)) {
    const used = Number(s.loads) + Number(s.stamped);
    console.log(`    ${s.name.padEnd(22)}${(s.owner ?? "").padEnd(16)}` +
                `${used ? `${used} use(s) in window` : "unused in window"}`);
  }
  if (undefined_.length > 12) console.log(`    … and ${undefined_.length - 12} more`);
  console.log("");

  if (notConsulted) {
    console.log(`  ${notConsulted} skill(s) NOT CONSULTED. Their block was used without them.`);
    console.log("  Look at the skill that DID get loaded in those runs — routing is the cause,");
    console.log("  and it is usually one of ours.\n");
    return 1;
  }
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  console.error(String((err as Error)?.message ?? err));
  process.exit(2);
}
