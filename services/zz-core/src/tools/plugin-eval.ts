/**
 * THE FACTS ABOUT ONE PLUGIN. Four tools, and not one of them returns a judgement.
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
 * READ-ONLY, with one exception that proves the rule. `plugin_cases_record` writes, because
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

import { logActivity } from "../persist.js";
import { pluginCases, parseCaseRun, worthRecording } from "../plugin-cases.js";
import { pluginTraces } from "../plugin-profile.js";
import { db } from "../platform-db.js";
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
 * found `knowledge_add` for sdlc on its first real round; zz-knowledge names `knowledge_add`
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
 * the gate states at skill-tools.mjs:182-183: "Reachable = the baseline (/core, in every agent
 * and the required package) plus whatever the manifest declares."
 *
 * Reading `manifest.servers` alone reported sdlc as reaching NOTHING while its seventeen skills
 * name eight zz-core tools between them. A plugin that names eight tools and reaches no server
 * is the "complete and unreachable" shape the gate exists to refuse — so the report said, of a
 * plugin that is entirely fine, the one thing this platform treats as most expensive.
 *
 * `tools` is folded in beside `servers` because client-package.ts concatenates both into what
 * a person installs: a block named there arrives as a server too. */
function serversOf(entry: ReturnType<typeof catalogEntries>[number] | undefined):
  { name: string; path: string; baseline?: true }[] {
  const declared = (entry?.manifest.servers ?? []).map((sv) => ({ name: sv.name, path: sv.path }));
  const blocks = (entry?.manifest.tools ?? []).map((b: string) => ({ name: b, path: `/p/${b}/mcp` }));
  const all = [...declared, ...blocks];
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
        "version of its own subject halfway through.",
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
          "versions began being recorded. `list_catalog` shows what exists.");
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
        "return is healthy re-grounding or thrash is the ruler's judgement, not this tool's.",
      inputSchema: { plugin: z.string(), version: z.string() },
    },
    async ({ plugin, version }) => {
      const pool = db();
      if (!pool) return noDb();
      const entry = entryOf(plugin);
      const stages: string[] = (entry?.manifest.stages ?? []).map((s) => s.name);
      const traces = await pluginTraces(pool, plugin, version, toolsNamedBy(plugin), stages);
      const cases = await pluginCases(pool, plugin, version);
      return json({
        plugin, version,
        traces,
        cases,
        // BOTH may be read, and only both being insufficient is a reason to stop. Cases need no
        // history at all, so a plugin nobody has run is still evaluable — which is the whole
        // reason the case half exists. Said here rather than left for a reader to infer.
        sufficient_for_judging: traces.sufficient || cases.sufficient,
      });
    },
  );

  server.registerTool(
    "plugin_cases_record",
    {
      description:
        "Record the JSON that `claude plugin eval <plugin>@zz-stack --json` produced. Run that " +
        "command yourself first — it is a CLI on this machine, spending this account's own " +
        "credential (roughly $0.40 per case), and nothing runs it for you. Pass its output " +
        "here whole. Recording is what gives a delta a timestamp, so a profile can say how old " +
        "the measurement is instead of presenting a three-week-old number as today's. Record a " +
        "run whose cases all timed out as well: it is still stored for what it cost, and that " +
        "answer is then free instead of costing another suite to find out.",
      inputSchema: {
        plugin: z.string(),
        version: z.string(),
        result: z.string().describe("the command's --json output, verbatim"),
      },
    },
    async ({ plugin, version, result }) => {
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
      await pool.query(
        `insert into zz.plugin_case_run (plugin_version_id, cases_digest, recorded_by, result)
         values ($1::uuid, $2, $3, $4::jsonb)`,
        [pv.id, pv.cases_digest, who, JSON.stringify(parsed)]);
      // Recorded, because this is the one tool here that changes anything. WHO ran a suite and
      // WHEN is provenance a later reader needs: a delta is only as good as the moment it was
      // measured, and the run cost somebody real money on their own credential.
      logActivity(await userRoot(), null,
        { user: who, action: "plugin_cases_record", plugin, version, cases: read.count });
      // THE COST GOES BACK ON EVERY PATH, at the one moment the person has just spent it.
      // And when no case parsed, `recorded: 0` alone reads to an LLM caller like a failure it
      // should retry — so that path says both facts in a sentence: what could not be read, and
      // what was kept anyway.
      const money = read.cost_usd === null
        ? "the payload carries no cost figure"
        : `it cost $${read.cost_usd} to run` +
          (read.judge_cost_usd === null ? "" : `, plus $${read.judge_cost_usd} to grade`);
      return json({
        recorded: read.count, mean_delta: read.mean_delta,
        cost_usd: read.cost_usd, judge_cost_usd: read.judge_cost_usd, plugin, version,
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
        "surface of its own, so the standard does not apply to it at all. Use what does come " +
        "back as a starting ruler for a third-party plugin with no run history.",
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
