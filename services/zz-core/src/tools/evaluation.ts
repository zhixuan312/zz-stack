/**
 * The evaluation surface: eight read-only tools that measure skills and blocks.
 *
 * An agent here has MCP tools and no shell, so an evaluation stage that says "run
 * scripts/profile.mjs" is a stage the agent cannot perform — the evaluation flows were
 * unrunnable by the thing meant to run them. These are the same queries behind the door an
 * agent actually has. Read-only, every one: evaluation measures and never writes.
 *
 * JUDGING IS DELIBERATELY NOT HERE. That runs a pinned model outside the conversation,
 * because a judge an agent can invoke is a judge that varies with the agent.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { text } from "@zz/mcp-http";
import { z } from "zod";

import { tableRow } from "../document-rules.js";
import * as evalq from "../evaluation.js";
import { affirmRuler, enumerate, judgeSkill } from "../judge-skill.js";
import { sanitize } from "../paths.js";
import { ARTIFACTS_DIR, db } from "../platform-db.js";

export function registerEvaluationTools(server: McpServer): void {
  // ── the evaluation surface ──────────────────────────────────────────────────
  //
  // An agent here has MCP tools and no shell, so an evaluation stage that says "run
  // scripts/profile.mjs" is a stage an agent cannot perform — the evaluation flows were
  // unrunnable by the thing meant to run them. These are the same queries, behind the door
  // an agent actually has. Read-only, every one: evaluation measures and never writes.
  //
  // JUDGING IS DELIBERATELY NOT HERE. That runs a pinned model outside the conversation,
  // because a judge an agent can invoke is a judge that varies with the agent.
  server.registerTool(
    "eval_skill_profile",
    {
      description:
        "Statistics for one skill: its versions and which is latest, reach and cost (loads, " +
        "calls, refusals, runs, initiatives), the documents THIS VERSION produced, the runs " +
        "of that version, refusal classes, and — for a block skill — the runs that used its " +
        "block without opening it. The same numbers for every skill, document-writing or not.",
      inputSchema: { skill: z.string(), version: z.string().optional() },
    },
    async ({ skill, version }) => {
      const p = db();
      if (!p) return text("ERROR: no platform database configured");
      const versions = await evalq.skillVersions(p, skill);
      if (!versions.length) return text(`ERROR: zz.skill has no version rows for ${skill}`);
      const chosen = version ? versions.find((v) => v.version === version) : versions[0];
      if (!chosen) {
        return text(`ERROR: ${skill} has no version ${version}; it has ` +
                    versions.map((v) => v.version).join(", "));
      }
      const vid = String(chosen.version_id);
      const [counts, documents, runs, refusals] = await Promise.all([
        evalq.skillCounts(p, skill), evalq.skillDocuments(p, vid),
        evalq.skillRuns(p, vid), evalq.skillRefusals(p, skill),
      ]);
      const blind = chosen.kind === "block_usage" && chosen.owner
        ? await evalq.skillBlind(p, skill, String(chosen.owner)) : [];
      return text(JSON.stringify({
        skill, chosen, versions, counts: counts[0], documents, runs: runs[0], refusals,
        blind: blind[0] ?? null,
        note: "Counts are per SKILL except documents and runs, which are per version — the " +
              "event log records the step by name and carries no version.",
      }, null, 2));
    },
  );

  server.registerTool(
    "eval_skill_ruler",
    {
      description:
        "Is the definition of good confirmed for this skill's latest version? Returns every " +
        "version with its body hash (so a frontmatter-only bump is visible as unchanged), " +
        "every rubric the skill has, and which version declares which. The gate of the " +
        "skill-evaluation flow reads this.",
      inputSchema: { skill: z.string() },
    },
    async ({ skill }) => {
      const p = db();
      if (!p) return text("ERROR: no platform database configured");
      const [versions, rubrics] = await Promise.all([
        evalq.skillVersions(p, skill), evalq.skillRubrics(p, skill),
      ]);
      if (!versions.length) return text(`ERROR: no versions registered for ${skill}`);
      return text(JSON.stringify({
        skill, versions,
        // EVERY RULER THE SKILL HAS, not only the affirmed one. `versions[].rubric_version`
        // reads through skill_version.rubric_id and is null until somebody affirms — so a
        // rubric the catalog ships and nobody has affirmed looked like no rubric at all, and
        // the stage that reads this went off and derived one beside it.
        rubrics,
        note: "body_hash equal between two versions means the skill itself did not change — " +
              "the bump was frontmatter, and there is no ruler decision to put to anybody." +
              (rubrics.length && !versions.some((v) => v.rubric_version)
                ? ` REUSE, DO NOT DERIVE: this skill already has ${rubrics.length} ruler(s) ` +
                  "from the catalog and no version has been affirmed against one yet. That is " +
                  "an unaffirmed ruler, not a missing one — read it, decide whether it still " +
                  "holds, and affirm it. Writing a new one beside it splits the skill's " +
                  "history into two scales that can never be compared."
                : ""),
      }, null, 2));
    },
  );

  server.registerTool(
    "eval_skill_affirm",
    {
      description:
        "Record that a skill version is judged by its skill's current ruler — the decision " +
        "zz-skill-define's gate exists to make. Call it AFTER the stakeholder approves " +
        "rulers.md, never before: it records their decision, it does not make it. Nothing " +
        "can be judged against a ruler no version declares.",
      inputSchema: { skill: z.string(), version: z.string() },
    },
    async ({ skill, version }) => {
      const p = db();
      if (!p) return text("ERROR: no platform database configured");
      return text(await affirmRuler(p, skill, version));
    },
  );

  server.registerTool(
    "eval_skill_judge",
    {
      description:
        "Score one version of one skill against the ruler it declares, and store every mark. " +
        "Subjects are whatever the version left behind: the documents it produced, or — for " +
        "a skill that writes none — its run traces, which are artifacts a judge reads the " +
        "same way. YOU ARE NOT THE JUDGE: this runs a pinned model on artifacts assembled " +
        "here, and you cannot supply the ruler, the artifact or the model. Run it once " +
        "plainly and once with control: true — the control scores a DIFFERENT skill's work " +
        "under this ruler, and a judge that is reading collapses on it. One without the " +
        "other is not a measurement. IT JUDGES ONE SUBJECT PER CALL and tells you what is " +
        "left: call it again with the `eval_id` it returns until `remaining` is 0.",
      inputSchema: {
        skill: z.string(),
        version: z.string(),
        control: z.boolean().optional()
          .describe("Judge another skill's work under this ruler, stored as the control."),
        eval_id: z.string().optional()
          .describe("Continue an evaluation this tool started, from its `eval_id`. Omit to begin one."),
        take: z.number().int().min(1).max(4).optional()
          .describe("How many subjects to judge in THIS call. Default 1: each takes about thirty seconds, and a call still running at two minutes returns nothing at all."),
      },
    },
    async ({ skill, version, control, eval_id, take }) => {
      const p = db();
      if (!p) return text("ERROR: no platform database configured");
      try {
        // The document body comes from the artifact store by team and path, resolved HERE
        // rather than passed in: the caller names a skill and a version and nothing else,
        // which is what keeps the judge's input out of the conversation.
        const got = await judgeSkill(p, skill, version, control === true, take ?? 1,
          eval_id ?? null,
          (team: string, initiative: string, path: string) => {
            try {
              const f = join(ARTIFACTS_DIR, "teams", sanitize(team), initiative, path);
              return existsSync(f) ? readFileSync(f, "utf8") : null;
            } catch { return null; }
          });
        return text(JSON.stringify(got, null, 2));
      } catch (err) {
        return text(`ERROR: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "eval_skill_scores",
    {
      description:
        "The report's numbers, as MARKDOWN TABLES TO PASTE VERBATIM into findings.md — " +
        "coverage (how many subjects were judged and how many there were), every score the " +
        "skill has been given, the judge on trial against its control, what the " +
        "skill actually did (loads, calls, refusals, tools, blocks, run length), and the " +
        "refusal classes. Cumulative, never a delta; grouped by rubric version AND judge, " +
        "which must never be averaged across. Do not retype these numbers or reformat the " +
        "tables — a number an agent retypes is a number that drifts.",
      inputSchema: {
        skill: z.string(),
        version: z.string().optional()
          .describe("Which version's coverage to report. Default: the latest."),
      },
    },
    async ({ skill, version }) => {
      const p = db();
      if (!p) return text("ERROR: no platform database configured");
      const versions = await evalq.skillVersions(p, skill);
      if (!versions.length) return text(`ERROR: zz.skill has no version rows for ${skill}`);
      const chosen = version ? versions.find((v) => v.version === version) : versions[0];
      if (!chosen) {
        return text(`ERROR: ${skill} has no version ${version}; it has ` +
                    versions.map((v) => v.version).join(", "));
      }
      const [evaluations, dimensions, control, counts, runs, refusals, surface, scored] =
        await Promise.all([
          evalq.skillEvaluations(p, skill), evalq.skillDimensions(p, skill),
          evalq.skillControl(p, skill), evalq.skillCounts(p, skill),
          evalq.skillRuns(p, String(chosen.version_id)), evalq.skillRefusals(p, skill),
          evalq.skillSurface(p, skill), evalq.judgedSubjects(p, String(chosen.version_id)),
        ]);
      // THE SAME ENUMERATION THE JUDGE USED. A second query here would answer a slightly
      // different question and the denominator would stop matching what was actually scored.
      const pop = await enumerate(p, String(chosen.version_id),
                                  (chosen.rubric_subject as never) ?? "auto");
      const c = (counts[0] ?? {}) as Record<string, string>;
      const r = (runs[0] ?? {}) as Record<string, string>;
      const sf = (surface[0] ?? {}) as Record<string, string>;
      // ACROSS EVERY ROUND OF THIS VERSION, not the last round's tally. A resumed evaluation
      // splits into two rows — ops-verify v1.0 has one of 3 and one of 7 because a call timed
      // out and finished server-side — and reading the last one reported 3 of 7 judged when
      // all 7 were.
      const judged = Number((scored[0] ?? {}).judged ?? 0);
      const n = (v: unknown) => Number(v ?? 0);
      const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
      const out: string[] = [];

      out.push(`### Coverage`, "");
      out.push("| | |", "|---|---|");
      const row = (...c: (string | number)[]) => out.push(tableRow(...c).trimEnd());
      // TWO FACTS, MEASURED AT DIFFERENT TIMES, and the line says so rather than dividing one
      // by the other. What was JUDGED is history — the subjects a round actually scored, at
      // whatever the store looked like that day. What is AVAILABLE is now. The link between a
      // document and the version that produced it runs through zz.run, and reconcileRuns
      // rebuilds runs from the event log, so a document can change hands between versions
      // after it was judged. ops-verify reads 9 judged against 7 available for exactly that
      // reason, and a coverage line that printed "9 of 7" as a ratio would be inventing
      // precision the data does not have.
      row("Judged", `${judged} — ${pop.population.what.replace(/^the /, "")}, ` +
                    "counted across every round of this version");
      row("Available now", `${pop.population.eligible} that could be judged today, out of ` +
                           `${pop.population.total} this version is currently credited with`);
      if (judged > pop.population.eligible) {
        row("Note", "More were judged than are available now. A document is tied to a version " +
            "through its run, and runs are rebuilt from the event log, so a subject can move " +
            "between versions after it was scored. The scores stand; the coverage ratio does " +
            "not, and no percentage is given here for that reason.");
      }
      // BOTH GAPS, and they mean different things. total - eligible is work the round could
      // never have looked at; eligible - judged is work it could have and did not — a round
      // that stopped early, or subjects whose judge call failed. Reporting only the first
      // read as full coverage of 15 when 13 were scored.
      if (pop.population.total > pop.population.eligible) {
        row("Out of reach", `${pop.population.total - pop.population.eligible} — ` +
            (pop.kind === "trace"
              ? "recorded no events, so there is no trace to read"
              : "no longer present, or written by another version"));
      }
      if (pop.population.eligible > judged && judged > 0) {
        row("Left unjudged", `${pop.population.eligible - judged} — the round did not score ` +
            "them: it stopped before the end, or those subjects failed and were skipped. " +
            "The mean below is over what WAS scored.");
      }
      if (pop.population.capped) {
        out.push("| Cap | 20 subjects per round, and it was reached — this is a SAMPLE, not a census |");
      }
      row("Window", `${c.first_seen ?? "—"} to ${c.last_seen ?? "—"}`);
      row("Subject kind", pop.kind);
      out.push("");

      out.push(`### The judge on trial`, "");
      if (control.length) {
        for (const k of control) {
          const gap = Number(k.real_mean) - Number(k.control_mean);
          row(`rubric ${k.rubric}, judge ${k.judge}`, "");
          out.push("|---|---|");
          row("real", String(k.real_mean));
          row("control", `${k.control_mean} — another skill's work of the same kind, scored ` +
                         "under THIS skill's ruler");
          row("gap", `**${gap.toFixed(2)}** — ` +
                     `${gap >= 1.5 ? "above" : "BELOW"} the 1.5 collapse line`);
          out.push("");
        }
        out.push(control.some((k) => Number(k.real_mean) - Number(k.control_mean) < 1.5)
          ? "**The judge scored the wrong artifact about as well as the right one, so the " +
            "scores below establish nothing about this skill.** Fix the measurement before " +
            "drawing any conclusion. Usually the ruler is the problem: a dimension that " +
            "another skill's work can satisfy is not measuring this skill."
          : "The judge marked the wrong artifact down, so it was reading the ruler against " +
            "the subject rather than rewarding fluent prose.", "");
      } else {
        out.push("**NO CONTROL was run, so nothing establishes the judge was reading.** " +
                 "Treat every number below as unverified.", "");
      }

      out.push(`### Scores by dimension`, "");
      out.push("| rubric | judge | dimension | n | mean | worst | best |", "|---|---|---|---|---|---|---|");
      for (const d of dimensions) {
        row(String(d.rubric), String(d.judge), String(d.dimension), String(d.n),
            String(d.mean), String(d.worst), String(d.best));
      }
      out.push("", `### Every round so far`, "");
      out.push("| when | version | rubric | judge | subjects | mean |", "|---|---|---|---|---|---|");
      for (const e of evaluations) {
        row(`${e.on_date}${e.unfinished ? " (never marked finished)" : ""}`,
            String(e.version), String(e.rubric), String(e.judge),
            String(e.subjects), String(e.mean));
      }
      if (evaluations.length < 2) {
        out.push("", "One round only, so no number here is a rise or a fall. It is a first reading.");
      }

      out.push("", `### What the skill actually did`, "");
      out.push("| | |", "|---|---|");
      row("Times loaded", c.loads ?? "0");
      row("Tool calls", `${c.stamped ?? 0} — ${c.ok_calls ?? 0} answered, ` +
                        `${c.refused ?? 0} refused (${pct(n(c.refused), n(c.stamped))})`);
      row("Distinct tools", `${sf.tools ?? 0}` +
          (Number(sf.blocks ?? 0) ? `, across ${sf.blocks} building block(s): ${sf.block_names}` : ""));
      row("Runs", `${r.runs ?? 0}, averaging ${r.avg_minutes ?? "—"} minutes, ` +
                  `longest ${r.max_minutes ?? "—"}`);
      row("Initiatives", c.initiatives ?? "0");
      out.push("");
      out.push("Stamped by the last skill served to the caller, so a call made after this " +
               "skill was loaded is counted here even when a later stage made it. Read these " +
               "as the scale of the skill's work, not as an exact ledger.", "");

      if (refusals.length) {
        out.push(`### Refusals by class`, "");
        out.push("| refusal | n |", "|---|---|");
        for (const f of refusals) {
          row(String(f.refusal).slice(0, 120), String(f.n));
        }
        out.push("", "A refusal is not a defect on its own — a guard firing is a guard " +
                 "working. A class that recurs across unrelated initiatives is the finding.");
      }
      return text(out.join("\n"));
    },
  );

  server.registerTool(
    "eval_block_surface",
    {
      description:
        "What a block offers today and WHAT MOVED since the version before: tools recorded, " +
        "the observed schema cost of each from real calls, and any tool removed or renamed. " +
        "A removed tool breaks every skill and plan that named it silently, with no error " +
        "until the next call, and most blocks publish no version number to catch it.",
      inputSchema: { block: z.string() },
    },
    async ({ block }) => {
      const p = db();
      if (!p) return text("ERROR: no platform database configured");
      const versions = await evalq.blockSurface(p, block);
      if (!versions.length) return text(`ERROR: no recorded surface for ${block}`);
      const [cur, prev] = versions;
      const tools = await evalq.blockTools(p, String(cur.version_id));
      const moved = prev ? await evalq.blockMoved(p, String(cur.version_id), String(prev.version_id)) : [];
      return text(JSON.stringify({
        block, current: cur, previous: prev ?? null, tools, moved,
        versions_recorded: versions.length,
        note: prev ? "`moved` compares the two most recent recorded surfaces."
                   : "Only one surface has ever been recorded, so what moved cannot be answered.",
      }, null, 2));
    },
  );

  server.registerTool(
    "eval_block_usage",
    {
      description:
        "Is this block's surface any good to use, as MARKDOWN TABLES TO PASTE VERBATIM into " +
        "findings.md — coverage (how many tools were exercised and how many calls), then tool " +
        "by tool ORDERED BY USAGE LOAD with calls, refusals, the rate and how many unrelated " +
        "initiatives met each refusal class. The unit is the tool: a team can fix a tool and " +
        "nobody can fix a block. Do not retype these numbers or reformat the tables.",
      inputSchema: { block: z.string() },
    },
    async ({ block }) => {
      const p = db();
      if (!p) return text("ERROR: no platform database configured");
      const [tools, refusals] = await Promise.all([
        evalq.blockUsage(p, block), evalq.blockRefusals(p, block),
      ]);
      if (!tools.length) return text(`ERROR: no calls recorded against ${block}`);
      // MARKDOWN, TO PASTE. The same reason eval_skill_scores emits it: a table an agent
      // rebuilds from JSON is a table whose numbers it retyped, and this one runs to dozens
      // of rows. The report's job is the sentence about the numbers, not the numbers.
      const out: string[] = [];
      const row = (...c: (string | number)[]) => out.push(tableRow(...c).trimEnd());
      const totals = tools.reduce<{ calls: number; refused: number }>((a, t) => ({
        calls: a.calls + Number(t.calls), refused: a.refused + Number(t.refused),
      }), { calls: 0, refused: 0 });
      out.push(`### Coverage`, "");
      out.push("| | |", "|---|---|");
      row("Tools exercised", `${tools.length} — this is what was CALLED, not what ${block} publishes`);
      row("Calls", `${totals.calls}, of which ${totals.refused} refused ` +
                   `(${totals.calls ? ((totals.refused / totals.calls) * 100).toFixed(1) : "0"}%)`);
      row("Window", `${tools[tools.length - 1]?.first_seen ?? "—"} to ${tools[0]?.last_seen ?? "—"}`);
      out.push("", "A tool with no calls says nothing about the tool — nobody reached for it. " +
               "eval_block_surface lists what the block publishes; the gap between the two is " +
               "surface this round did not exercise, and it is not a finding about quality.", "");
      out.push(`### Tool by tool, heaviest first`, "");
      out.push("| tool | calls | refused | rate | initiatives | first | last |",
               "|---|---|---|---|---|---|---|");
      for (const t of tools) {
        row(String(t.tool), String(t.calls), String(t.refused), `${t.pct_refused}%`,
            String(t.initiatives), String(t.first_seen), String(t.last_seen));
      }
      out.push("", `### Refusal classes`, "");
      out.push("| class | n | initiatives |", "|---|---|---|");
      for (const f of refusals) {
        row(String(f.refusal ?? f.class ?? "").slice(0, 120), String(f.n ?? ""),
            String(f.initiatives ?? ""));
      }
      out.push("", "**A refusal class in two or more unrelated initiatives is the block's; " +
               "one confined to a single initiative may be our payload.** The status code " +
               "decides the audience: 401/403 is authorization and almost always ours, " +
               "422/400 is the payload we sent, 5xx is theirs.", "",
               "**Report, do not grade.** One real block is no baseline, so nothing here says " +
               "whether a 17% refusal rate is good or bad — only what happened, at what rate, " +
               "and where it recurred.");
      return text(out.join("\n"));
    },
  );

  server.registerTool(
    "eval_block_defects",
    {
      description:
        "What has been recorded against a block: knowledge nodes under EITHER tag convention " +
        "(`block:casebox` and bare `casebox`), superseded ones excluded, each with the block version it " +
        "was checked against. A snapshot of what is true now, not the triage history — a " +
        "claim, its correction and the correction's refinement are one fact and two dead ends.",
      inputSchema: { block: z.string() },
    },
    async ({ block }) => {
      const p = db();
      if (!p) return text("ERROR: no platform database configured");
      const [nodes, surface] = await Promise.all([
        evalq.blockNodes(p, block), evalq.blockSurface(p, block),
      ]);
      const running = surface[0]?.version ?? null;
      const confirmed = nodes.filter((n) => n.verified_against && n.verified_against === running);
      const unverified = nodes.filter((n) => !confirmed.includes(n));
      return text(JSON.stringify({
        block, running_version: running, confirmed, unverified,
        note: "Only `confirmed` is true of the version the block is running. `unverified` are " +
              "claims nobody has re-checked — re-test before any of them goes in a report.",
      }, null, 2));
    },
  );
}
