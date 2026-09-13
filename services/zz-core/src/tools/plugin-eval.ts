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
import { pluginCases, parseCaseRun } from "../plugin-cases.js";
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
export function toolsNamedBy(dir: string): string[] {
  const skills = join(dir, "skills");
  if (!existsSync(skills)) return [];
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
        servers: entry?.manifest.servers ?? [],
        tools_named: entry ? toolsNamedBy(entry.dir) : [],
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
      const traces = await pluginTraces(pool, plugin, version, entry ? toolsNamedBy(entry.dir) : [], stages);
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
        "the measurement is instead of presenting a three-week-old number as today's.",
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
      if (!read.count) return text(`ERROR: nothing was recorded — ${read.reason}`);
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
      return json({ recorded: read.count, mean_delta: read.mean_delta, plugin, version });
    },
  );

  server.registerTool(
    "plugin_conform",
    {
      description:
        "This plugin against the building-block contract's R1-R14, THREE-VALUED: true, false, " +
        "or not_measured. R1, R7, R12, R13 and R14 are always not_measured because the " +
        "contract itself refuses to score them — 'a battery that guessed would hand out passes " +
        "this standard never granted'. Clauses that do not apply to a flow plugin come back " +
        "not_measured with that as the evidence, never true. Use it as a starting ruler for a " +
        "plugin with no history of its own.",
      inputSchema: { plugin: z.string(), version: z.string() },
    },
    async ({ plugin, version }) => {
      const entry = entryOf(plugin);
      if (!entry) return text(`ERROR: "${plugin}" is not in the catalog`);
      const servers = entry.manifest.servers ?? [];
      const named = toolsNamedBy(entry.dir);
      // The nine the contract settles mechanically, and the five it does not. Spelled out rather
      // than looped, because which clause is measurable is a fact about the STANDARD and a
      // reader has to be able to check this list against contract.md without running anything.
      const clauses = [
        { id: "R1",  holds: "not_measured", evidence: "the contract names R1 as not mechanically measured" },
        { id: "R2",  holds: "not_measured", evidence: "a server-transport clause; this is a flow plugin" },
        { id: "R3",  holds: "not_measured", evidence: "a server-transport clause; this is a flow plugin" },
        { id: "R4",  holds: named.length > 0,
          evidence: `${named.length} tool(s) named by this plugin's skills` },
        { id: "R5",  holds: servers.length > 0,
          evidence: `${servers.length} server(s) declared in the manifest` },
        { id: "R6",  holds: (entry.manifest.stages ?? []).length > 0,
          evidence: `${(entry.manifest.stages ?? []).length} stage(s) declared` },
        { id: "R8",  holds: Boolean(entry.manifest.description),
          evidence: entry.manifest.description ? "the manifest carries a description" : "no description" },
        { id: "R9",  holds: Boolean(entry.manifest.version),
          evidence: `declared version ${entry.manifest.version ?? "(none)"}` },
        { id: "R10", holds: existsSync(join(entry.dir, "skills")),
          evidence: "usage skills ship with the package" },
        { id: "R11", holds: (entry.manifest.documents ?? []).some((d) => d.gate),
          evidence: "at least one document is gated" },
        { id: "R7",  holds: "not_measured", evidence: "the contract names R7 as not mechanically measured" },
        { id: "R12", holds: "not_measured", evidence: "the contract names R12 as not mechanically measured" },
        { id: "R13", holds: "not_measured", evidence: "the contract names R13 as not mechanically measured" },
        { id: "R14", holds: "not_measured", evidence: "the contract names R14 as not mechanically measured" },
      ];
      return json({ plugin, version, clauses: clauses.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))) });
    },
  );
}
