/**
 * The catalog, as plugins — the unit a person actually installs. `claude plugin install
 * sdlc@zz-stack` installs a flow's skills and the servers those skills call, together, under
 * one version, so there is one subject here and one route per question about it.
 *
 * The catalog says what exists; the store says what happened. These reads are catalog-first: a
 * plugin in the catalog with no telemetry reads as "never run", where a telemetry-first listing
 * renders it as absent.
 *
 * They go through `teamless` — a plugin's manifest and its skills are the same facts for
 * everybody, and passing a scope nobody narrows by would imply otherwise.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { catalogEntries, isFlow, pluginName } from "@zz/catalog";
import { band } from "@zz/contracts";
import type { Express } from "express";

import { PLATFORM_VERSION } from "../client-package.js";
import { platformDb } from "../db.js";
import { BASELINE } from "../package/skills.js";
import { teamless } from "./shared.js";
import { PLATFORM_SKILLS_DIR, type ShippedSkill, readSkillAt, skillsIn } from "./skill-source.js";

/** One plugin as it sits on disk, before the store is asked anything about it. */
interface DiskPlugin {
  plugin: string;
  /** The catalog owner directory. Null for `zz`, which is not catalog-resident. */
  owner: string | null;
  agentName: string | null;
  description: string | null;
  /** What the plugin declares it is — flow.json, or the gateway's manifest for `zz`. */
  version: string | null;
  /** The MCP servers this plugin's skills reach. */
  servers: string[];
  documents: { name: string; role: string | null; gate: boolean; stage: string | null }[];
  /** Is it a flow? Read from the manifest through the one classifier, never reconstructed here.
   * Carrying only `stages` and letting the reader conclude from its emptiness moves the
   * inference from the server to whoever is looking. */
  flow: boolean;
  /** Stage names in declared order; empty for a plugin that declares no method. */
  stages: string[];
  /** The front door, which `stages` never contains. */
  entry: string | null;
  skillsDir: string;
}

/**
 * Every plugin this image ships: the catalog's, plus `zz`. No `stages.length > 0` filter — a
 * package with no stages is still a plugin somebody installs, and plugins.lock.json counts it.
 * The distinction is carried by each row's `flow` field, declared by the manifest and read
 * through `isFlow`.
 *
 * `zz-core` is built below rather than in the walk. It has a flow.json, so the walk finds it,
 * but client-package.ts synthesises its files per caller and its skills are the tree beside the
 * catalog rather than that entry's `skills/` — a row from the walk would report it as shipping
 * nothing, beside a second row of the same name.
 *
 * COUPLED: its skills are read from the directory `src/package/plugin-lock.ts` walks for its
 * digest.
 */
function diskPlugins(): DiskPlugin[] {
  const out: DiskPlugin[] = catalogEntries().filter((e) => e.flow !== BASELINE).map((e) => {
    const docs = e.manifest.documents ?? [];
    return {
      plugin: pluginName(e.flow),
      owner: e.owner,
      agentName: e.manifest.agentName ?? null,
      description: e.manifest.description ?? null,
      version: PLATFORM_VERSION,
      // The servers the installed package carries: each one the manifest declares, plus zz-core,
      // which no manifest declares — it arrives through the required baseline plugin and is
      // where a plugin's store, gates and documents live. Deduped, because some declare it.
      servers: [...new Set([
        "zz-core",
        ...(e.manifest.servers ?? []).map((sv) => sv.name),
      ])],
      documents: docs.map((d) => ({
        name: d.name, role: d.role ?? null, gate: d.gate === true, stage: d.stage ?? null,
      })),
      flow: isFlow(e.manifest),
      stages: (e.manifest.stages ?? []).map((x) => x.name),
      entry: e.manifest.entry ?? null,
      skillsDir: join(e.dir, "skills"),
    };
  });
  if (existsSync(PLATFORM_SKILLS_DIR)) {
    out.push({
      plugin: BASELINE,
      owner: null,
      agentName: null,
      description: "The platform itself: its MCP surface and the method for using it. Every account has it.",
      version: PLATFORM_VERSION,
      servers: ["zz-core"],
      documents: [],
      // The baseline governs no documents of its own, so it is not a flow — and its manifest
      // says so by declaring none, which is the same answer `isFlow` would give.
      flow: false,
      stages: [],
      entry: null,
      skillsDir: PLATFORM_SKILLS_DIR,
    });
  }
  return out.sort((a, b) => a.plugin.localeCompare(b.plugin));
}

export function mountCatalog(app: Express): void {
  /** Every plugin, one row each — what it declares, what it ships, and what the store knows.
   *
   * The digest comes from zz.plugin_version, not plugins.lock.json: the image copies `catalog`,
   * `skills`, `packages` and `services` and neither lock file, so a route reading the lock
   * works on a laptop and returns nothing in production. The table is written at release
   * and says what was released rather than what a checkout contains.
   *
   * Joined on the declared version, never the newest recorded one: the digest shown has to be
   * the digest of the number shown. A plugin whose flow.json has moved past its last release
   * shows its declared version with no digest — nothing has vouched for that number yet.
   *
   * A row arrives at release and at no other moment, so an absent row is a fact rather than an
   * error. */
  app.get("/api/console/plugins", teamless("plugins", async (_req, res) => {
    // No team dimension: a plugin's manifest, its skills and its release digest are the same
    // rows for every reader. The platform records no installs, so there is nothing per team.
    const db = platformDb();
    const [ran, released, evaluated] = await Promise.all([
      // Every skill the store has seen, whatever kind it is. `zz` ships common skills
      // (zz-platform), which are skills of a plugin here too, so a filter on
      // `kind = 'flow_step'` would show them as never run.
      db.query(`select s.name,
                       (select count(*) from zz.skill_version v where v.skill_id = s.id) as versions,
                       (select count(*) from zz.event e
                         where e.kind = 'tool_call' and e.step = s.name)                  as calls,
                       (select count(*) from zz.event e
                         where e.kind = 'tool_call' and e.step = s.name and e.ok = false) as failed,
                       -- When it last ran. The list sorts on it, so a plugin nobody has touched in a month
                       -- sinks below one in use rather than sitting wherever the catalog walk put it. No eval
                       -- count: an evaluation's subject is a plugin version, and the plugin's own count is on
                       -- the release row below.
                       (select to_char(max(e.ts) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') from zz.event e
                         where e.kind = 'tool_call' and e.step = s.name)                  as last_run
                  from zz.skill s`),
      // What was released, and how many evaluations each released version has.
      db.query(`select p.name as plugin, pv.version, pv.digest,
                       (select count(*) from zz.eval ev where ev.plugin_version_id = pv.id) as evals
                  from zz.plugin p
                  join zz.plugin_version pv on pv.plugin_id = p.id`),
      // The latest round that reached a verdict, one per plugin. `headroom_state is not null` is
      // the definition of evaluated: a historic round was minted first and got its verdict in a
      // later call, so an abandoned round has marks but nothing to report, and showing the
      // newest row regardless would put an empty score beside a perfectly good earlier one.
      //
      // Across versions, not within one: the answer is the last time anybody measured the
      // plugin, and pinning to the shelf version would blank the column on every release day.
      // The version that was measured travels with the figures.
      //
      // DELIBERATE: the columns are named rather than starred. A `select *` over these tables
      // would pull jsonb nobody asked for.
      db.query(`select distinct on (pv.plugin_id)
                       p.name as plugin, pv.version,
                       e.effectiveness, e.headroom_points, e.headroom_named, e.headroom_state,
                       e.initiative, e.team_slug,
                       to_char(e.started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
                  from zz.eval e
                  join zz.plugin_version pv on pv.id = e.plugin_version_id
                  join zz.plugin p on p.id = pv.plugin_id
                 where e.is_control is false and e.headroom_state is not null
                 order by pv.plugin_id, e.started_at desc`),
    ]);

    /** The newest scored round per plugin, by name.
     *
     *  The initiative is nullable; a round without one reads as a date with no report. */
    const verdict = new Map(evaluated.rows.map((r) => [r.plugin as string, {
      version: r.version as string,
      effectiveness: r.effectiveness === null ? null : Number(r.effectiveness),
      // COUPLED: the band is `band(score)` and the rule is in @zz/contracts, so the console and
      // the report cannot print different words for one number. Named here, not read off a column.
      band: band(r.effectiveness === null ? null : Number(r.effectiveness)),
      headroomPoints: r.headroom_points === null ? null : Number(r.headroom_points),
      headroomNamed: r.headroom_named === null ? null : Number(r.headroom_named),
      headroomState: r.headroom_state as string,
      // Both, or neither. zz.doc is keyed (team_slug, initiative): a slug with no team cannot
      // be addressed, and a link built from half of a key is a 404 waiting for a reader.
      initiative: r.initiative && r.team_slug
        ? { team: r.team_slug as string, slug: r.initiative as string }
        : null,
      at: r.at as string,
    }]));

    const stats = new Map(ran.rows.map((r) => [r.name as string, r]));
    const release = new Map(released.rows.map((r) => [`${r.plugin as string}@${r.version as string}`, r]));
    const skillRow = (s: ShippedSkill, position: number | null, isEntry: boolean) => {
      const st = stats.get(s.name);
      return {
        name: s.name, position, isEntry,
        origin: s.origin, version: s.version, description: s.description, source: s.source,
        versions: st ? +st.versions : 0,
        calls: st ? +st.calls : 0,
        // A skill the plugin ships and the store has never seen. Not an error — a plugin
        // nobody has run yet is a plugin, and saying so is the point.
        everRun: !!st && +st.calls > 0,
        lastRun: (st?.last_run as string | null) ?? null,
      };
    };

    const rows = diskPlugins().map((p) => {
      // Every skill it ships, not its stages: sdlc ships more skills than it declares stages,
      // and the difference would be unlistable in a console that packages them. Position is
      // carried where the method declares one, and null where the skill is simply shipped.
      const shipped = skillsIn(p.skillsDir);
      const skills = shipped.map((s) => {
        const at = p.stages.indexOf(s.name);
        return skillRow(s, at >= 0 ? at + 1 : null, p.entry === s.name);
      });
      const rel = p.version ? release.get(`${p.plugin}@${p.version}`) : undefined;
      return {
        plugin: p.plugin,
        owner: p.owner,
        agentName: p.agentName,
        description: p.description,
        version: p.version,
        servers: p.servers,
        flow: p.flow,
        stages: p.stages,
        entry: p.entry,
        documents: p.documents,
        gates: p.documents.filter((d) => d.gate).length,
        skills,
        // Its skills' calls, summed.
        calls: skills.reduce((a, s) => a + s.calls, 0),
        failed: shipped.reduce((a, s) => a + Number(stats.get(s.name)?.failed ?? 0), 0),
        lastRun: skills.map((s) => s.lastRun).filter(Boolean).sort().pop() ?? null,
        release: rel
          ? { version: rel.version as string, digest: rel.digest as string,
              evals: +rel.evals }
          : null,
        latestEval: verdict.get(p.plugin) ?? null,
      };
    });

    const plugins = [...rows].sort((a, b) => {
      const la = a.lastRun ?? "";
      const lb = b.lastRun ?? "";
      if (la !== lb) return lb.localeCompare(la);
      return a.plugin.localeCompare(b.plugin);
    });
    res.json({ plugins });
  }));

  /** One skill a plugin ships — its text, and everything shipped beside it.
   *
   * One route for both containers: a skill is the same kind of thing whether a catalog package
   * runs it as a stage or the platform loads it into every flow. They differ only in how the
   * directory is found.
   *
   * DELIBERATE: resolved through the enumeration, never by joining the route into a path. The
   * walk that lists a plugin's skills already resolved each one's directory, so this looks the
   * name up in that list. No path is built from `req.params`, which is why there is no traversal
   * guard.
   *
   * References are inlined; the largest that exists is a few kilobytes. */
  app.get("/api/console/plugins/:plugin/skills/:skill", teamless("the plugin skill", async (req, res) => {
    // No team dimension: this reads a skill's text off disk, the same file for every reader.
    const { plugin, skill } = req.params;
    const disk = diskPlugins().find((p) => p.plugin === plugin);
    const found = disk ? skillsIn(disk.skillsDir).find((s) => s.name === skill) : undefined;
    if (!found) {
      // Named separately: a plugin nobody ships is a wrong address, and a skill missing from a
      // plugin that does exist is a renamed or deleted skill.
      if (!disk) {
        res.status(404).json({ error: `no plugin '${plugin}'` });
        return;
      }
      res.status(404).json({ error: `plugin '${plugin}' ships no skill '${skill}'` });
      return;
    }
    res.json({
      plugin,
      isEntry: disk?.entry === skill,
      ...readSkillAt(found.dir, found.name, found.origin, found.source),
    });
  }));
}
