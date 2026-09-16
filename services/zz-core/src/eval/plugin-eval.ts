/**
 * THE FACTS ABOUT ONE PLUGIN, and not one of these tools returns a judgement.
 *
 * A plugin is what a person installs — a flow's skills plus the MCP servers those skills call.
 * The platform used to evaluate the two halves separately and could therefore see neither of the
 * things that decide whether the whole is any good: whether a flow that goes wrong can return to
 * an earlier stage, and whether the tools it can reach are ever actually used.
 *
 * THE BOUNDARY THIS FILE KEEPS. Every field below is a count, a set, an ordering, a timing or a
 * difference. `returns: 3` is a fact. Whether three returns is a flow re-grounding well or one
 * thrashing is a JUDGEMENT, and it belongs to a ruler a person approved — the initiative that
 * produced this file returned three times and every one was healthy. So: the tool produces the
 * fact, the ruler says where the line is, and the tool may then apply that line. A field named
 * `healthy` here would be this file answering a question it cannot see the evidence for.
 *
 * READ-ONLY, with one exception that proves the rule. `case_record` writes, because
 * `claude plugin eval` is a CLI on the person's own machine spending their own credential and
 * this service cannot see its output. The skill runs it where it can be run and hands the result
 * over; recording it is how a delta acquires a timestamp, which is the field that stops a
 * three-week-old measurement being read as today's.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { catalogEntries } from "@zz/catalog";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { initiativeNameFor, recordOpen } from "../initiative-record.js";
import { logActivity } from "../persist.js";
import { pluginCases, parseCaseRun, worthRecording } from "./plugin-cases.js";
import { pluginTraces } from "./plugin-profile.js";
import { db, teamFor } from "../platform-db.js";
import { userRoot } from "../paths.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so nothing about a " +
                        "plugin's use can be read");

/** A plugin's catalog entry, by the name a person installs it under.
 *
 * pluginName's rule, applied here rather than imported: the gateway owns that function and this
 * service does not depend on the gateway. One line, and the alternative is a package boundary
 * crossed for a suffix strip. */
export function entryOf(plugin: string): ReturnType<typeof catalogEntries>[number] | undefined {
  return catalogEntries().find((e) => e.flow.replace(/-flow$/, "") === plugin);
}

/** The platform's own skills — the `zz-core` plugin's content. The same constant plugin-lock.ts
 *  keeps on the gateway side, spelled again here because zz-core does not depend on the
 *  gateway, and honouring the same override for the same reason: the gate runs on a machine
 *  where /skills does not exist. */
const SKILLS_DIR = process.env.ZZ_SKILLS_DIR || "/skills";

/** Where a plugin's skills are on disk, or "" if this deployment holds none.
 *
 * `zz-core` HAS A CATALOG ENTRY AND ITS SKILLS ARE NOT IN IT, which is why the baseline is
 * answered FIRST and not as a fallback. Every caller of toolsNamedBy used to guard the call
 * with a ternary on the catalog entry, falling back to the empty list. The consequence was not
 * an error anywhere: the baseline reported `tools_named: []`, so `reachable` was empty, so
 * `never_called` was empty, so the one finding this whole half exists to produce — a tool a
 * skill tells an agent to call and no agent ever called — was structurally impossible for the
 * plugin every account installs, and read as a clean bill of health. The `tool fit` dimension
 * found `knowledge_add` for sdlc on its first real round; zz-handover names `knowledge_add`
 * too, and the question could never have been asked of it.
 *
 * Asking the catalog first would restore that failure by a new route rather than by an absence:
 * `catalog/zz/zz-core/` carries the manifest and no `skills/`, so an entry-first order resolves
 * the baseline to a directory that does not exist and returns the same empty list.
 *
 * Resolved here rather than at each call site so there is one answer to it. */
function skillsDirOf(plugin: string): string {
  if (plugin === "zz-core") return SKILLS_DIR;
  const entry = entryOf(plugin);
  return entry ? join(entry.dir, "skills") : "";
}

/** The MCP surfaces this plugin can actually reach.
 *
 * THE BASELINE IS NOT OPTIONAL AND IS NOT DECLARED. `zz` is required by every package, so
 * `zz-core` arrives with every plugin whether or not a manifest mentions it — which is the rule
 * the gate states at skill-tools.ts:182-183: "Reachable = the baseline (/core, in every agent
 * and the required package) plus whatever the manifest declares."
 *
 * Reading `manifest.servers` alone reported sdlc as reaching NOTHING while the skills it ships
 * name eight zz-core tools between them. A plugin that names eight tools and reaches no server
 * is the "complete and unreachable" shape the gate exists to refuse — so the report said, of a
 * plugin that is entirely fine, the one thing this platform treats as most expensive.
 *
 * `tools` is folded in beside `servers` because client-package.ts concatenates both into what
 * a person installs. */
function serversOf(entry: ReturnType<typeof catalogEntries>[number] | undefined):
  { name: string; path: string; baseline?: true }[] {
  const all = (entry?.manifest.servers ?? []).map((sv) => ({ name: sv.name, path: sv.path }));
  // Marked, so a reader can tell what this plugin ASKED for from what every plugin gets.
  if (!all.some((sv) => sv.name === "zz-core")) {
    all.unshift({ name: "zz-core", path: "/core/mcp", baseline: true } as never);
  }
  return all;
}

/** Every tool this plugin's own skills tell an agent to call.
 *
 * NOT "every tool on the surfaces it declares", which was the first shape and the wrong
 * question. A plugin does not claim the whole surface; it claims what its skills name. So a
 * tool in this set that was never called is a sharp finding — the plugin TELLS an agent to call
 * it and no agent ever did — where a tool merely present on a shared door and unused says
 * nothing about this plugin at all.
 *
 * The static half of the same question is already settled elsewhere and is not recomputed here:
 * the gate refuses a release whose skill names a tool its package cannot reach. That is a
 * precondition of a plugin version existing, not an input to its evaluation. */
export function toolsNamedBy(plugin: string): string[] {
  const skills = skillsDirOf(plugin);
  if (!skills || !existsSync(skills)) return [];
  const named = new Set<string>();
  const walk = (d: string): void => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, f.name);
      if (f.isDirectory()) { walk(abs); continue; }
      if (f.name !== "SKILL.md") continue;
      const body = readFileSync(abs, "utf8");
      // `tool_name(` in prose or in a table. Snake case with at least one underscore, which is
      // what every tool on this platform is named and what ordinary English in a skill is not.
      for (const m of body.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*\(/g)) named.add(m[1]);
    }
  };
  walk(skills);
  return [...named].sort();
}

export function registerPluginEvalTools(server: McpServer): void {
  server.registerTool(
    "plugin_locate",
    {
      description:
        "IDENTIFY the plugin an evaluation is about: its released version, that version's own " +
        "content digest, the skill versions it shipped with, the MCP servers it declares and " +
        "the tools its skills name. Facts only. Call this first — every later tool takes the " +
        "plugin and version this returns, so that an evaluation cannot drift onto a different " +
        "version of its own subject halfway through. Call it when an evaluation begins, and " +
        "before any other tool on this door.",
      inputSchema: { plugin: z.string() },
    },
    async ({ plugin }) => {
      const pool = db();
      if (!pool) return noDb();
      const { rows } = await pool.query<{ version: string; digest: string; cases_digest: string; origin: string }>(`
        select pv.version, pv.digest, pv.cases_digest, p.origin
          from zz.plugin p join zz.plugin_version pv on pv.plugin_id = p.id
         where p.name = $1
         order by pv.version desc limit 1`, [plugin]);
      const row = rows[0];
      if (!row) {
        return text(
          `ERROR: no released version of "${plugin}" is recorded. A plugin version is written ` +
          "at release, so either the name is wrong or this plugin has not been released since " +
          "versions began being recorded. `catalog_list` shows what exists.");
      }
      const skills = (await pool.query<{ name: string; version: string }>(`
        select s.name, sv.version
          from zz.plugin_version pv
          join zz.plugin p on p.id = pv.plugin_id
          join zz.plugin_version_skill pvs on pvs.plugin_version_id = pv.id
          join zz.skill_version sv on sv.id = pvs.skill_version_id
          join zz.skill s on s.id = sv.skill_id
         where p.name = $1 and pv.version = $2
         order by s.name`, [plugin, row.version])).rows;
      const entry = entryOf(plugin);
      return json({
        plugin, version: row.version, digest: row.digest,
        cases_digest: row.cases_digest || null,
        origin: row.origin,
        // WHAT AN EVALUATION IS ALLOWED TO DO WITH ITS FINDINGS, and it follows from whose the
        // plugin is. Ours: the findings feed a change somebody makes. Somebody else's: we
        // assess and stop -- there is no recommendation to give a team that did not ask us for
        // one, and a "proposed_change" against a plugin we do not own is a finding pretending
        // to be an instruction.
        mode: row.origin === "third_party" ? "assess only" : "assess, then change",
        skills,
        servers: serversOf(entry),
        tools_named: toolsNamedBy(plugin),
      });
    },
  );

  server.registerTool(
    "plugin_profile",
    {
      description:
        "What this plugin version DID, as computed facts with no model anywhere in the " +
        "derivation. Two evidence blocks, each with its OWN sufficiency verdict: TRACES from " +
        "the event log (runs, stage paths, returns to an earlier stage, per-tool calls and " +
        "refusals, tools its skills name that were never called) and CASES from the recorded " +
        "ablation run (per-case delta against a no-plugin arm). Every figure carries the " +
        "coverage it was derived from. Returns are COUNTED AND NOT CLASSIFIED — whether a " +
        "return is healthy re-grounding or thrash is the ruler's judgement, not this tool's. " +
        "Call it when a ruler is being written, and again when its figures are read.",
      inputSchema: { plugin: z.string(), version: z.string() },
    },
    async ({ plugin, version }) => {
      const pool = db();
      if (!pool) return noDb();
      const entry = entryOf(plugin);
      const stages: string[] = (entry?.manifest.stages ?? []).map((s) => s.name);
      const traces = await pluginTraces(pool, plugin, version, toolsNamedBy(plugin), stages);
      const cases = await pluginCases(pool, plugin, version);
      const enough = traces.sufficient || cases.sufficient;
      return json({
        plugin, version,
        traces,
        cases,
        // BOTH may be read, and only both being insufficient is a reason to stop. Cases need no
        // history at all, so a plugin nobody has run is still evaluable — which is the whole
        // reason the case half exists. Said here rather than left for a reader to infer.
        sufficient_for_judging: enough,
        // AND WHAT TO DO ABOUT IT, in the same shape `initiative_status` answers with.
        //
        // The suite and this platform are ONE pipeline and were reachable only as two: the CLI
        // measures, `case_record` stores what it measured, and the stages after this one judge
        // what was stored. Nothing joined them. A person ran `claude plugin eval`, read the
        // numbers off their terminal, and stopped — because the recording step is a separate act
        // that nothing asks for and nothing notices the absence of. It happened on this platform:
        // four suites were run, eleven cases measured, and the platform went on holding a three-
        // week-old run with twelve errored cases in it, because nobody carried the JSON across.
        //
        // `sufficient_for_judging: false` was the whole answer, and a boolean is not an
        // instruction. This says which command, with which arguments, and what to do with its
        // output — so the next step is in the answer rather than in somebody's memory of the
        // skill. It is null when there is enough evidence, because a next action nobody needs
        // is noise on every profile that is already fine.
        next_action: enough ? null : {
          action: "record_a_suite_run",
          why: cases.reason
            ? `no case evidence: ${cases.reason}`
            : "neither the run history nor a recorded suite carries enough to judge against",
          run: `claude plugin eval ${plugin}@zz-stack --json <path>`,
          then: `case_record(plugin: "${plugin}", version: "${version}", result: <the JSON at that path, verbatim>)`,
          // Said before it is spent, not after. It is this account's own credential.
          costs: "roughly $0.40 per case, on this machine, against this account's credential",
          // The trap that produced a two-hour partial run reading as a plugin that helped with
          // nothing. Named here because this is where somebody is about to run the command.
          target: "ONE built plugin directory — marketplace/<plugin> — never the repository root",
        },
      });
    },
  );

  server.registerTool(
    "case_record",
    {
      description:
        "WHEN you have run `claude plugin eval <plugin>@zz-stack --json` yourself and hold " +
        "its output. Run that command first — it is a CLI on this machine, spending this " +
        "account's own credential (roughly $0.40 per case), and nothing runs it for you. Pass " +
        "its output here whole. RETURNS what was stored and what the run cost, which is what " +
        "gives a delta a timestamp, so a profile can say how old the measurement is instead of " +
        "presenting a three-week-old number as today's. REFUSES a payload carrying neither a " +
        "readable case nor a cost, and refuses nothing else: a run whose cases all timed out is " +
        "still stored for what it cost, and that answer is then free instead of costing another " +
        "suite to find out.",
      inputSchema: {
        plugin: z.string(),
        version: z.string(),
        result: z.string().describe("the command's --json output, verbatim"),
        // RUNNING A SUITE IS A PIECE OF WORK, so it belongs to an initiative like any other.
        //
        // Omit it and one is opened, named for what was measured, on the zz-plugin-eval flow —
        // which is the flow this run is the first evidence for. Before this, four suites could
        // be run and $15.76 spent while the platform's record of "what is this team doing" said
        // nothing had happened, and `findings.md` had nowhere to be written to because no
        // initiative existed to write it into.
        initiative: z.string().optional().describe(
          "The initiative this run belongs to. Omit to open one for it — which is the ordinary " +
          "case; pass one to record a second suite against a round already under way."),
      },
    },
    async ({ plugin, version, result, initiative }) => {
      const pool = db();
      if (!pool) return noDb();
      let parsed: unknown;
      try { parsed = JSON.parse(result); }
      catch (err) { return text(`ERROR: that is not JSON — ${String(err).slice(0, 160)}`); }
      // Validated BEFORE it is stored. A result whose shape moved is worth knowing about now,
      // at the moment somebody can re-run the command, rather than at read time weeks later.
      const read = parseCaseRun(parsed, new Date().toISOString(), "");
      // A CASE OR A COST IS ENOUGH TO STORE IT. This refused on `!read.count` alone, which
      // turned away the one kind of payload the raw column exists for: a suite that spent real
      // money and produced no readable delta. `worthRecording` owns the rule so it can be
      // tested; the refusal below still fires for a payload carrying neither.
      if (!worthRecording(read)) return text(`ERROR: nothing was recorded — ${read.reason}`);
      const { rows } = await pool.query<{ id: string; cases_digest: string }>(`
        select pv.id, pv.cases_digest from zz.plugin_version pv
          join zz.plugin p on p.id = pv.plugin_id
         where p.name = $1 and pv.version = $2`, [plugin, version]);
      const pv = rows[0];
      if (!pv) return text(`ERROR: no released version ${version} of "${plugin}" is recorded`);
      const who = parseCaller(requestHeaders()).email;

      // THE RUN BECOMES A PIECE OF WORK, not just a row. An initiative on the zz-plugin-eval
      // flow is what the stages after this one write into — `rulers.md` from define, and
      // `findings.md` from report — so recording a suite outside one left the flow's own first
      // evidence somewhere its later stages could not reach.
      //
      // OPENED ONLY WHEN NONE WAS GIVEN, and named for what was measured rather than for the
      // clock alone, so two rounds on the same plugin and version are the same initiative asked
      // for twice rather than two folders nobody can tell apart. `recordOpen` is the same act
      // `initiative_open` performs; this does not reimplement it.
      const team = await teamFor(who);
      const root = await userRoot();
      let round = initiative?.trim() || "";
      let opened = false;
      if (!round) {
        round = initiativeNameFor(`eval-${plugin}-${version}`.replace(/[^a-z0-9-]+/gi, "-").toLowerCase());
        if (!existsSync(join(root, round))) {
          recordOpen(root, round, "zz-plugin-eval", who);
          opened = true;
          logActivity(root, `${round}/_open.json`,
            { user: who, action: "initiative_open", initiative: round, flow: "zz-plugin-eval" });
        }
      }

      await pool.query(
        `insert into zz.plugin_case_run (plugin_version_id, cases_digest, recorded_by, result,
                                         team_slug, initiative)
         values ($1::uuid, $2, $3, $4::jsonb, $5, $6)`,
        [pv.id, pv.cases_digest, who, JSON.stringify(parsed), team, round]);
      // Recorded, because this is the one tool here that changes anything. WHO ran a suite and
      // WHEN is provenance a later reader needs: a delta is only as good as the moment it was
      // measured, and the run cost somebody real money on their own credential.
      logActivity(await userRoot(), null,
        { user: who, action: "case_record", plugin, version, cases: read.count });
      // THE COST GOES BACK ON EVERY PATH, at the one moment the person has just spent it.
      // And when no case parsed, `recorded: 0` alone reads to an LLM caller like a failure it
      // should retry — so that path says both facts in a sentence: what could not be read, and
      // what was kept anyway.
      const money = read.cost_usd === null
        ? "the payload carries no cost figure"
        : `it cost $${read.cost_usd} to run` +
          (read.judge_cost_usd === null ? "" : `, plus $${read.judge_cost_usd} to grade`);
      // HOW MUCH OF THE SUITE ACTUALLY RAN, said here rather than left for a reader to notice.
      // This is the only moment the caller can still do something about it: they have the
      // command in their shell and the money is already spent. The frozen 2.1.269 run is the
      // case that argues for it — twelve of its thirty-six runs died and the CLI marked the
      // whole suite `partial: "interrupted"`, and everything downstream of it went on treating
      // a mean over what survived as a measurement. A `mean_delta` taken across a suite that
      // half fell over is not a smaller measurement, it is a different one.
      //
      // Both fields go back unconditionally, and the sentence only when there is something to
      // say. A caller that reads fields gets them either way; one that reads prose is not made
      // to parse "errored_runs: 0" to learn that nothing went wrong.
      const damage = [
        read.errored_runs ? `${read.errored_runs} run${read.errored_runs === 1 ? "" : "s"} errored or timed out` : "",
        read.partial ? "`claude plugin eval` marked the suite partial — it did not finish" : "",
      ].filter(Boolean);
      return json({
        recorded: read.count, mean_delta: read.mean_delta,
        cost_usd: read.cost_usd, judge_cost_usd: read.judge_cost_usd,
        errored_runs: read.errored_runs, partial: read.partial, plugin, version,
        // WHICH INITIATIVE THIS IS NOW PART OF, and whether asking for it created it. A caller
        // that opened a round without meaning to should be told at the moment it happened,
        // rather than finding an initiative in the console later that nobody remembers opening.
        initiative: round,
        initiative_opened: opened,
        next_action: {
          action: "judge_the_round",
          why: "the suite is recorded; a delta is not a verdict until it is scored against a ruler somebody agreed",
          then: `ruler_read(plugin: "${plugin}") to see what it would be judged against, then ` +
                `ruler_record and round_judge against initiative "${round}"`,
        },
        ...(damage.length ? {
          warning: `${damage.join("; ")}. Whatever was recorded is a measurement of a suite ` +
                   "that did not fully run; re-run it before reading a delta off it.",
        } : {}),
        ...(read.count ? {} : {
          note: `no case was readable — ${read.reason}. The result was stored whole anyway ` +
                `and ${money}, so nothing has to be re-run to ask about it.`,
        }),
      });
    },
  );

  server.registerTool(
    "plugin_conform",
    {
      description:
        "This plugin against the building-block contract's R1-R14, THREE-VALUED: true, false, " +
        "or not_measured. Most clauses come back not_measured for most plugins, and that is " +
        "the honest answer rather than a gap: R1-R14 describes a BLOCK SERVER's tool surface, " +
        "and settling it needs that surface read through the gateway. A flow plugin serves no " +
        "surface of its own, so the standard does not apply to it at all. Call it when a " +
        "third-party plugin has no run history and a starting ruler has to come from " +
        "somewhere: what it returns is that starting point. It never guesses a clause it " +
        "cannot settle — that clause comes back not_measured.",
      inputSchema: { plugin: z.string(), version: z.string() },
    },
    async ({ plugin, version }) => {
      const entry = entryOf(plugin);
      if (!entry) return text(`ERROR: "${plugin}" is not in the catalog`);
      const named = toolsNamedBy(plugin);
      const servesOwnSurface = (entry.manifest.servers ?? []).length > 0;

      // WHAT THIS TOOL DOES NOT DO, said before what it does, because an earlier version of it
      // did the opposite and that was worse than doing nothing.
      //
      // It reported R4 as "8 tools named by this plugin's skills", R5 as "0 servers declared",
      // R6 as "7 stages declared", R9 as "declared version 0.1.0". Not one of those is what the
      // clause says. R4 asks whether the SERVER offers list_usage_skills() and
      // usage_skill_view(name); R5 asks whether its tool VERBS state the capability; R6 asks
      // whether its validation errors are prose that teach the rule; R9 asks for get_app_url.
      // A mapping was invented and labelled with the standard's clause numbers, which produced
      // a conformance report citing a standard it did not check.
      //
      // contract.md:196-199 names the failure exactly: "R1, R7, R12, R13 and R14 are
      // behavioural ... a battery that guessed would hand out passes this standard never
      // granted." The invented mapping WAS the guessing battery, one level worse than the
      // thing the contract warns about, because it guessed at the nine mechanical ones too.
      //
      // The mechanical battery that really settles R2-R6 and R8-R11 read each block's live tool
      // surface through the gateway. It went with zz-block-eval and is not reimplemented here.
      const notMeasured = (why: string) => ({ holds: "not_measured" as const, evidence: why });
      const BEHAVIOURAL = "the contract names this clause as behavioural and not mechanically measured";
      const NO_SURFACE =
        "R1-R14 describes a block server's tool surface; this plugin serves none of its own, so " +
        "the clause does not apply to it";
      const NO_BATTERY =
        "settling this needs the block's live tool surface read through the gateway. That " +
        "battery went with zz-block-eval and is not reimplemented here — not_measured rather " +
        "than a guess";

      const clauses = ["R1","R2","R3","R4","R5","R6","R7","R8","R9","R10","R11","R12","R13","R14"]
        .map((id) => {
          if (["R1","R7","R12","R13","R14"].includes(id)) return { id, ...notMeasured(BEHAVIOURAL) };
          if (!servesOwnSurface) return { id, ...notMeasured(NO_SURFACE) };
          // R5 is the one mechanical clause a tool NAME can settle: honest verbs that state the
          // capability, never do_action or submit. The rest need the live surface.
          if (id === "R5" && named.length) {
            const dishonest = named.filter((t) => /^(do_|submit$|submit_|perform_|handle_|process_)/.test(t));
            return { id, holds: dishonest.length === 0,
                     evidence: dishonest.length
                       ? `${dishonest.join(", ")} state no capability`
                       : `${named.length} tool name(s), every one stating a capability` };
          }
          return { id, ...notMeasured(NO_BATTERY) };
        });

      const settled = clauses.filter((c) => c.holds !== "not_measured").length;
      return json({
        plugin, version, clauses,
        settled,
        note: settled
          ? `${settled} of 14 settled mechanically; the rest need a surface this plugin does not serve or a battery that is not here.`
          : "Nothing was settled mechanically. R1-R14 is a block-server standard and this plugin serves no surface of its own — that is an answer about the standard's scope, not a gap in the plugin.",
      });
    },
  );
}
