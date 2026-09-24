/**
 * The facts about one plugin — a flow's skills plus the MCP servers those skills call. No tool
 * here returns a judgement.
 *
 * DELIBERATE: every field below is a count, a set, an ordering, a timing or a difference.
 * `returns: 3` is a fact; whether three returns is healthy belongs to a ruler a person
 * approved. A field named `healthy` here would answer a question this file cannot see the
 * evidence for.
 *
 * DELIBERATE: read-only, without exception. The evidence is what the platform's own doors
 * recorded — which tools were called, on whose door, how often, what they refused and whose
 * refusal it was — so it needs no second runner and no credential, and cannot fall out of step
 * with the plugin.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { catalogEntries, pluginName } from "@zz/catalog";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { text } from "@zz/mcp-http";
import { z } from "zod";

import { pluginTraces } from "./plugin-profile.js";
import { db } from "../platform-db.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so nothing about a " +
                        "plugin's use can be read");

/** A plugin's catalog entry, by the name a person installs it under.
 *
 * Through pluginName, the one rule for what a flow is called as a plugin. */
export function entryOf(plugin: string): ReturnType<typeof catalogEntries>[number] | undefined {
  return catalogEntries().find((e) => pluginName(e.flow) === plugin);
}

/** The platform's own skills — the `zz-core` plugin's content.
 *
 *  COUPLED: the gateway's plugin-lock.ts keeps the same constant and the same override.
 *  zz-core does not depend on the gateway, so it is spelled twice. The override exists because
 *  the gate runs where /skills does not. */
const SKILLS_DIR = process.env.ZZ_SKILLS_DIR || "/skills";

/** Where a plugin's skills are on disk, or "" if this deployment holds none.
 *
 * DELIBERATE: the `zz-core` baseline is answered first and not as a fallback. It has a catalog
 * entry whose directory carries the manifest and no `skills/`, so an entry-first order
 * resolves it to a directory that does not exist and returns an empty list — which makes
 * `never_called` empty and reads as a clean bill of health for the plugin every account
 * installs.
 *
 * Resolved here rather than at each call site so there is one answer to it. */
function skillsDirOf(plugin: string): string {
  if (plugin === "zz-core") return SKILLS_DIR;
  const entry = entryOf(plugin);
  return entry ? join(entry.dir, "skills") : "";
}

/** The MCP surfaces this plugin can actually reach: the baseline plus whatever the manifest
 * declares.
 *
 * DELIBERATE: the baseline is neither optional nor declared. `zz` is required by every
 * package, so `zz-core` arrives with every plugin whether or not a manifest mentions it.
 * Reading `manifest.servers` alone reports a flow as reaching nothing.
 *
 * COUPLED: `tools` is folded in beside `servers` because client-package.ts concatenates both
 * into what a person installs. */
function serversOf(entry: ReturnType<typeof catalogEntries>[number] | undefined):
  { name: string; path: string; baseline?: true }[] {
  const all = (entry?.manifest.servers ?? []).map((sv) => ({ name: sv.name, path: sv.path }));
  // Marked, so a reader can tell what this plugin asked for from what every plugin gets.
  if (!all.some((sv) => sv.name === "zz-core")) {
    all.unshift({ name: "zz-core", path: "/core/mcp", baseline: true } as never);
  }
  return all;
}

/** Does this plugin declare a server of its own? One that declares `servers` owns a door and
 * its evidence is that door's traffic; one that declares none rides the baseline and is a
 * flow, whose evidence is the runs of its own skills. */
export function servesOwnDoor(plugin: string): boolean {
  return (entryOf(plugin)?.manifest.servers?.length ?? 0) > 0;
}

/** Every tool this plugin's own skills tell an agent to call — not every tool on the surfaces
 * it declares. A tool in this set that was never called is a finding; a tool merely present on
 * a shared door and unused says nothing about this plugin.
 *
 * COUPLED: the static half is the gate's, which refuses a release whose skill names a tool its
 * package cannot reach. It is a precondition of a version existing, not an input here. */
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
      // `tool_name(` in prose or in a table: snake case with at least one underscore, which
      // every tool here is named and ordinary English in a skill is not.
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
      const { rows } = await pool.query<{ version: string; digest: string; origin: string }>(`
        select pv.version, pv.digest, p.origin
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
        origin: row.origin,
        // What an evaluation may do with its findings follows from whose the plugin is. Ours:
        // the findings feed a change somebody makes. A third party's: assess and stop, because
        // a proposed change against a plugin we do not own is a finding pretending to be an
        // instruction.
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
        "derivation: TRACES from the event log (runs, stage paths, returns to an earlier " +
        "stage, per-tool calls and refusals, tools its skills name that were never called), " +
        "with their own sufficiency verdict. Every figure carries the " +
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
      const traces = await pluginTraces(pool, plugin, version, toolsNamedBy(plugin), stages, servesOwnDoor(plugin));
      return json({
        plugin, version,
        traces,
        // DELIBERATE: the run history is the only evidence. It is what the platform's own
        // doors recorded — which tools were called, on whose door, how often, what they
        // refused and whose refusal it was — rather than an agent's vocabulary, and it needs
        // no second runner, no credential and no suite kept in step with the plugin.
        sufficient_for_judging: traces.sufficient,
        // And what to do about it, in the same shape `initiative_status` answers with.
        //
        // DELIBERATE: never null, even when the evidence is sufficient. A caller follows
        // `next_action` from plugin_locate to here; a null ends the chain and the caller goes
        // on from memory of the skill instead.
        next_action: traces.sufficient ? {
          action: "read_the_contract_then_define",
          why: "the evidence is enough to judge against, so this stage's remaining question is " +
               "the one plugin_conform answers: does the package hold to the building-block " +
               "contract it is shipped under. It reads the catalog entry and calls no model.",
          run: `plugin_conform(plugin: "${plugin}", version: "${version}")`,
          then: `ruler_read(plugin: "${plugin}", version: "${version}") — everything the ruler ` +
                "is written FROM, which is the define stage's input",
        } : {
          action: "wait_for_use",
          why: traces.reason
            ? `no usable run history: ${traces.reason}`
            : "this version's run history does not carry enough to judge against",
          // No command to offer: this evidence is a by-product of the plugin being used, and
          // nothing run on demand produces it.
          then: "let the plugin be used, then profile it again. A ruler whose subject is the " +
                "document or the initiative may already have subjects even when the trace " +
                "history is thin — ruler_read says what is there.",
        },
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

      // DELIBERATE: every clause but R5 reports `not_measured` rather than a stand-in.
      // Settling R2-R6 and R8-R11 needs a server's live tool surface read through the gateway,
      // which this door does not do, and the building-block standard names R1, R7, R12, R13 and
      // R14 as behavioural. A mapping from whatever this door can count would hand out
      // passes the standard never granted, under the standard's own clause numbers.
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
          // R5 is the one mechanical clause a tool name can settle: honest verbs that state
          // the capability, never do_action or submit.
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
