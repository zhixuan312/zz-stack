/**
 * The catalog, as PLUGINS — the unit a person actually installs.
 *
 * THIS SERVED TWO PAGES AND ONE SUBJECT. `/flows` listed agent methods, `/blocks` listed MCP
 * surfaces, and the console's own navigation defended the split: "a flow is an agent method,
 * a block is something reached over MCP, every skill belongs to one or the other." Every word
 * of that is true and the taxonomy was still wrong for a reader, because neither half is a
 * thing anybody installs. `claude plugin install sdlc@zz-stack` installs a flow's skills AND
 * the servers those skills call, together, under one version — and the two pages showed the
 * halves of it side by side with no line drawn between them.
 *
 * Migration 047 makes the same move in the schema for the same reason: the two properties that
 * decide whether a plugin is any good — can it recover from a bad stage, are its reachable
 * tools ever called — are properties of the whole and of neither half. So there is one subject
 * here now, and one route per question about it.
 *
 * THE CATALOG SAYS WHAT EXISTS; THE STORE SAYS WHAT HAPPENED. That division is the reason the
 * old flows route was catalog-first and it survives unchanged: a plugin in the catalog with no
 * telemetry reads as "never run", which is a true and useful answer, where a telemetry-first
 * listing rendered it as absent. sdlc-flow was invisible for exactly that reason.
 *
 * These are the reads that are about the PLATFORM rather than any team's work, which is why
 * they go through `teamless` — a plugin's manifest and its skills are the same facts for
 * everybody, and passing a scope nobody narrows by would imply otherwise.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { catalogEntries, isFlow } from "@zz/catalog";
import type { Express } from "express";

import { PLATFORM_VERSION } from "../client-package.js";
import { platformDb } from "../db.js";
import { BASELINE, pluginName } from "../package/skills.js";
import { teamless } from "./shared.js";
import { PLATFORM_SKILLS_DIR, type ShippedSkill, blockSkills, readSkillAt, skillsIn } from "./skill-source.js";

/** One plugin as it sits on disk, before the store is asked anything about it. */
interface DiskPlugin {
  plugin: string;
  /** The catalog owner directory. Null for `zz`, which is not catalog-resident. */
  owner: string | null;
  agentName: string | null;
  description: string | null;
  /** What the plugin DECLARES it is — flow.json, or the gateway's manifest for `zz`. */
  version: string | null;
  /** The MCP servers this plugin's skills reach. */
  servers: string[];
  documents: { name: string; role: string | null; gate: boolean; stage: string | null }[];
  /** IS IT A FLOW? Read from the manifest through the one classifier, never reconstructed
   * here. The console used to carry only `stages` and let the reader draw the conclusion from
   * its emptiness — which is inference, moved from the server to whoever is looking, and it
   * is what put a stepper on a package that had one stage and no method. */
  flow: boolean;
  /** Stage names in declared order; empty for a plugin that declares no method. */
  stages: string[];
  /** The front door, which `stages` never contains. */
  entry: string | null;
  skillsDir: string;
}

/**
 * EVERY PLUGIN THIS IMAGE SHIPS: the catalog's, plus `zz`.
 *
 * NO `stages.length > 0` FILTER, and that is the one deliberate difference from the flows
 * route this replaces. That filter existed to keep a toolbox out of a list of methods —
 * zz-admin declared no stages and shipped no skills directory, and sat beside ops-flow
 * inviting a reader to ask why nobody adopted it. A PLUGINS list has no such problem: a
 * package with no stages is still a plugin somebody installs, zz-access is exactly that, and
 * plugins.lock.json has always counted it. The distinction the old filter drew is still
 * carried, by the `flow` field on each row — declared by the manifest and read through
 * `isFlow`, rather than left for the reader to infer from an empty `stages`.
 *
 * `zz-core` IS A PLUGIN ROW LIKE ANY OTHER, and it is built BELOW rather than in the walk. It
 * has a flow.json — so the walk finds it — but client-package.ts synthesises its files per
 * caller, and its skills are the tree beside the catalog rather than that entry's `skills/`. A
 * row from the walk would therefore report the plugin every account carries as shipping nothing
 * at all, beside a second row of the same name. Its skills are read from the same directory
 * plugin-lock.ts walks to compute its digest, so the two cannot disagree about what it ships.
 */
function diskPlugins(): DiskPlugin[] {
  const out: DiskPlugin[] = catalogEntries().filter((e) => e.flow !== BASELINE).map((e) => {
    const docs = e.manifest.documents ?? [];
    return {
      plugin: pluginName(e.flow),
      owner: e.owner,
      agentName: e.manifest.agentName ?? null,
      description: e.manifest.description ?? null,
      version: e.manifest.version ?? null,
      // BOTH DECLARATIONS, because both become servers in the installed package.
      // client-package.ts maps `tools` to /p/<block>/mcp and `servers` to their own paths and
      // concatenates them; a console showing one of the two would be showing a plugin that
      // reaches fewer servers than the one on somebody's machine.
      //
      // AND zz-core, WHICH NO MANIFEST DECLARES. It arrives through the `zz` baseline plugin,
      // which is `required` and therefore on every account, so a plugin's own manifest has no
      // reason to name it — and it is where that plugin's store, gates and documents live.
      // The flows page learned this the hard way: listing only what the manifest declared
      // showed sdlc reaching nothing at all, which reads as a method that talks to no server.
      // Deduped, because three of the five DO declare it.
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
  /** EVERY PLUGIN, one row each — what it declares, what it ships, and what the store knows.
   *
   * THE DIGEST COMES FROM THE DATABASE, not from plugins.lock.json, and the reason is the
   * Dockerfile. The image copies `catalog`, `skills`, `blocks`, `packages` and `services`; it
   * copies neither lock file. So a route that read plugins.lock.json would work on a laptop
   * and return nothing at all in production — and `pluginLock()`, which computes the same
   * numbers live, throws on the missing skills.lock.json for the same reason. zz.plugin_version
   * is written at release, is present wherever the console runs, and is the only one of the
   * three that says what was actually RELEASED rather than what a checkout currently contains.
   *
   * JOINED ON THE DECLARED VERSION, never on the newest recorded one. The pair is the whole
   * point — the digest is not an alternative to the version, it is what makes the version
   * true — so the digest shown has to be the digest OF the number shown. A plugin whose
   * flow.json has moved past its last release shows its declared version with no digest, which
   * is the honest answer: nothing has vouched for that number yet.
   *
   * A ROW ARRIVES AT RELEASE and at no other moment: `zz-tool register-plugins` mirrors
   * plugins.lock.json into the registry after the gate has refused any release where a declared
   * version and its content digest disagree. So a deployment that has not released since these
   * tables landed answers null for every plugin, and so does a plugin whose flow.json has been
   * edited since. Both are facts a reader needs rather than faults to chase, which is why
   * nothing here treats an absent row as an error.
   */
  app.get("/api/console/plugins", teamless("plugins", async (_req, res) => {
    // NO TEAM DIMENSION: a plugin's manifest, its skills and its release digest are the same
    // rows for every reader. Which teams INSTALLED a flow was per-team data and went out with
    // the flows route — see the note in /api/console/teams, which is where a team's own
    // installs are answered from a scope that authorises them.
    const db = platformDb();
    const [ran, released, blocks] = await Promise.all([
      // EVERY SKILL THE STORE HAS SEEN, whatever kind it is. The flows route filtered
      // `kind = 'flow_step'`, which was right when the only subject was a flow's stages and
      // is wrong now: `zz` ships common skills (zz-platform) and a block ships block_usage
      // skills, and both are skills of a plugin here. A filter on kind would have shown them
      // all as never run.
      db.query(`select s.name,
                       (select count(*) from zz.skill_version v where v.skill_id = s.id) as versions,
                       (select count(*) from zz.event e
                         where e.kind = 'tool_call' and e.step = s.name)                  as calls,
                       (select count(*) from zz.event e
                         where e.kind = 'tool_call' and e.step = s.name and e.ok = false) as failed,
                       -- WHEN IT LAST RAN. The list sorts on it, so a plugin nobody has
                       -- touched in a month sinks below one in use rather than sitting
                       -- wherever the catalog walk happened to put it.
                       -- NO EVAL COUNT. This counted the rounds run against a skill, through
                       -- zz.eval.skill_version_id. 048 drops that column: an evaluation's
                       -- subject is a plugin version now, so "how many times was this SKILL
                       -- evaluated" is not a question the store can answer or will ever be
                       -- asked again. The plugin's own count is on the release row below.
                       (select to_char(max(e.ts) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') from zz.event e
                         where e.kind = 'tool_call' and e.step = s.name)                  as last_run
                  from zz.skill s`),
      // WHAT WAS RELEASED, and the most recent ablation run against it.
      //
      // The delta is read here in SQL and PARSED in zz-core. plugin-cases.ts owns
      // `parseCaseRun` — it knows which spellings of the two arm scores the CLI has used and
      // says so out loud when the shape moves. A second parser in the gateway would be a
      // second opinion about what a delta is, so this takes the mean of the one field both
      // agree on and nothing else. The `jsonb_typeof` guards are not decoration: `result` is
      // whatever the CLI printed, and a run whose shape moved must leave the row without a
      // number rather than throwing 22023 at every reader of the page.
      db.query(`select p.name as plugin, p.origin, pv.version, pv.digest, pv.cases_digest,
                       (select count(*) from zz.eval ev where ev.plugin_version_id = pv.id) as evals,
                       to_char(r.ran_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')     as ran_at,
                       r.cases_digest as run_cases, r.n_cases, r.mean_delta,
                       r.errored_runs, r.partial
                  from zz.plugin p
                  join zz.plugin_version pv on pv.plugin_id = p.id
                  left join lateral (
                    select (select count(*) from jsonb_array_elements(cr.result->'cases') c) as n_cases,
                           (select avg((c->>'delta')::numeric)
                              from jsonb_array_elements(cr.result->'cases') c
                             where jsonb_typeof(c->'delta') = 'number')                      as mean_delta,
                           -- HOW MUCH OF THE SUITE ACTUALLY RAN, beside the delta rather than
                           -- anywhere else. A mean taken over a suite that half fell over is
                           -- not a smaller measurement, it is a different one, and a page that
                           -- shows the number without the caveat invites exactly the reading
                           -- the caveat exists to prevent. zz-core learned this the expensive
                           -- way: errored_runs was counted after the skip that drops an
                           -- unreadable case, so a run in which nine of thirty-six runs died
                           -- reported a clean suite. Fixing it there and not here would have
                           -- left the same wrong answer on the surface people actually read.
                           --
                           -- NOT A SECOND PARSER, which is the rule this file already keeps
                           -- for the delta. Neither field is derived: the error key is a key the CLI
                           -- either wrote on a run or did not, and partial is its own
                           -- top-level flag. The typeof guards match the ones above for the
                           -- same reason they exist there — result is whatever the CLI
                           -- printed, and a shape that moved must leave the row without a
                           -- number rather than throwing at every reader of the page.
                           -- THE TYPE GUARDS ARE INSIDE THE CALLS, not in a where clause, and
                           -- the reason is narrower than it first looks. jsonb_each on a
                           -- non-object raises 22023 -- that much is certain, and a case whose
                           -- arms came back as an array is exactly the payload that would do
                           -- it. Written as where jsonb_typeof(c->'arms') = 'object' the
                           -- query nonetheless survives, because the planner pushes that qual
                           -- below the function expansion and never makes the call. Measured on
                           -- PostgreSQL 17.10, against both an all-bad row and a mixed one.
                           --
                           -- So this is not a bug fix. It is a refusal to depend on a planner
                           -- decision for correctness: nothing in the query says the qual must
                           -- be pushed down, and a future plan that evaluates the join first
                           -- takes the whole catalogue page down with a 22023 for one malformed
                           -- row. The CASE form cannot be planned into throwing. It costs a
                           -- line and removes the question.
                           (select count(*)
                              from jsonb_array_elements(cr.result->'cases') c
                              cross join lateral jsonb_each(
                                case when jsonb_typeof(c->'arms') = 'object'
                                     then c->'arms' else '{}'::jsonb end) arm
                              cross join lateral jsonb_array_elements(
                                case when jsonb_typeof(arm.value) = 'array'
                                     then arm.value else '[]'::jsonb end) run
                             where nullif(run->>'error', '') is not null)                    as errored_runs,
                           (cr.result->>'partial' = 'true')                                  as partial,
                           -- ran_at IS LAST IN THIS SELECT LIST, and it has to stay there.
                           -- The gate reads every timestamp column and asks whether anything
                           -- writes one it guards on; its test for "guarded" is a comparison
                           -- operator within a hundred characters, and jsonb's arrow contains
                           -- one. Written beside the extraction above, ran_at read as a column
                           -- deciding access that nothing can set -- a false finding about a
                           -- column Postgres defaults for us.
                           cr.cases_digest, cr.ran_at
                      from zz.plugin_case_run cr
                     where cr.plugin_version_id = pv.id
                       and jsonb_typeof(cr.result->'cases') = 'array'
                     order by cr.ran_at desc limit 1) r on true`),
      // A REGISTERED BLOCK IS A PLUGIN TOO, and its servers come from its registration rather
      // than from a manifest: the block IS the server it reaches. It declares no version and
      // ships through nobody's marketplace, so it carries no digest and never will — the
      // release columns are null for it by construction, not for want of a release.
      //
      // `origin = 'team'` rather than `origin <> 'stand_in'`. RuleMill and bookit are our own
      // mocks from the zz-blocks image and there is nobody on the other end of a puppet to
      // agree a change with; they stay in Overview and Activity, because those report what our
      // flows DID and hiding them would make a flow's totals stop adding up. `platform` is
      // excluded for a different reason — it is zz-core, which is the `zz` plugin's own server
      // and already has a row above.
      db.query(`select b.name as block, b.title, b.kind,
                       coalesce(e.calls,0) as calls, coalesce(e.failed,0) as failed,
                       e.last_seen
                  from zz.block b
                  left join (
                    select block, count(*) as calls,
                           count(*) filter (where ok = false) as failed,
                           to_char(max(ts) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_seen
                      from zz.event where kind = 'tool_call' and block is not null group by 1
                  ) e on e.block = b.name
                 where b.origin = 'team'
                 order by b.name`),
    ]);

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
      // EVERY SKILL IT SHIPS, not its stages. The flow routes allowed `stages` plus the entry,
      // which is the method's running order and not its contents: sdlc ships more skills than
      // it declares stages, so the difference — sdlc-method, sdlc-recall, the audit criteria —
      // were unlistable and unreadable in a console that packages them. Position is carried
      // where the method declares one, and is null where the skill is simply shipped.
      const shipped = skillsIn(p.skillsDir);
      const skills = shipped.map((s) => {
        const at = p.stages.indexOf(s.name);
        return skillRow(s, at >= 0 ? at + 1 : null, p.entry === s.name);
      });
      const rel = p.version ? release.get(`${p.plugin}@${p.version}`) : undefined;
      return {
        plugin: p.plugin,
        owner: p.owner,
        // OURS. Every catalog package in this image is written here, and so is `zz`; the
        // column exists because zz.plugin.origin decides what an evaluation DOES with its
        // findings — for our own plugins they feed a change, for somebody else's we assess
        // and stop. A registered block is the other value, below.
        origin: "platform" as const,
        agentName: p.agentName,
        description: p.description,
        title: null as string | null,
        kind: null as string | null,
        version: p.version,
        servers: p.servers,
        flow: p.flow,
        stages: p.stages,
        entry: p.entry,
        documents: p.documents,
        gates: p.documents.filter((d) => d.gate).length,
        skills,
        // ITS SKILLS' CALLS, SUMMED. A block row below counts calls the other way — by the
        // block column on the event — because a registered block has no skill of ours running
        // inside it. Two derivations of one word, and the difference is which end of the call
        // the plugin is on.
        calls: skills.reduce((a, s) => a + s.calls, 0),
        failed: shipped.reduce((a, s) => a + Number(stats.get(s.name)?.failed ?? 0), 0),
        lastRun: skills.map((s) => s.lastRun).filter(Boolean).sort().pop() ?? null,
        release: rel
          ? { version: rel.version as string, digest: rel.digest as string,
              casesDigest: (rel.cases_digest as string) || null, evals: +rel.evals }
          : null,
        eval: rel?.ran_at
          ? { ranAt: rel.ran_at as string, casesDigest: (rel.run_cases as string) || null,
              cases: +rel.n_cases,
              meanDelta: rel.mean_delta === null ? null : +rel.mean_delta,
              // TRAVELS WITH THE DELTA, never optional. Dropped from the object when zero, a
              // caller reading this JSON cannot tell "no runs died" from "this build of the
              // page does not report that", and the second is the reading that gets somebody to
              // trust a number they should not.
              //
              // A BARE UNARY PLUS, deliberately, and the same one `cases` above uses. The rule
              // console-nulls.ts enforces is that an aggregate which can be SQL null must not
              // reach JSON through `+`, because `+null` is 0 and a group nothing measured then
              // reports as measured. `errored_runs` is a count(*), not an avg: it is null only
              // when the lateral matched no run at all, and that case never reaches here
              // because `rel?.ran_at` has already sent it to `eval: null`. Guarding it anyway
              // would read as a null this branch can produce, and it cannot. `mean_delta` two
              // lines up is the field that genuinely needs the guard — avg over no matching row
              // is null with the run right there.
              erroredRuns: +rel.errored_runs,
              // Absent collapses to false, matching parseCaseRun's `root?.partial === true`
              // exactly. Two surfaces reading one payload must not disagree about what a
              // missing flag means, and this flag is one every run the CLI has ever written
              // carries.
              partial: rel.partial === true }
          : null,
      };
    });

    // ONE WALK OF /blocks for the whole response, not one per row: it reads a SKILL.md off
    // disk for every skill it finds, and calling it inside the map would re-read the shelf
    // once per registered block.
    const carried = blockSkills();
    const blockRows = blocks.rows.map((b) => {
      const skills = (carried.get(b.block as string) ?? []).map((s) => skillRow(s, null, false));
      return {
        plugin: b.block as string,
        owner: null,
        origin: "third_party" as const,
        agentName: null,
        description: null,
        // title and kind travel with the block, not in a map in the console — see migration
        // 034. Empty where nobody has described it, and the console shows the id then.
        title: (b.title as string) || null,
        kind: (b.kind as string) || null,
        version: null,
        servers: [b.block as string],
        // A registered block is somebody else's server, not a package of ours with a method.
        flow: false,
        stages: [] as string[],
        entry: null,
        documents: [] as DiskPlugin["documents"],
        gates: 0,
        skills,
        calls: +b.calls,
        failed: +b.failed,
        lastRun: (b.last_seen as string | null) ?? null,
        release: null,
        eval: null,
      };
    });

    // MOST RECENTLY USED FIRST. A plugin nobody has run has no date and sorts last, by name
    // among its own kind, so the tail is stable rather than arbitrary.
    const plugins = [...rows, ...blockRows].sort((a, b) => {
      const la = a.lastRun ?? "";
      const lb = b.lastRun ?? "";
      if (la !== lb) return lb.localeCompare(la);
      return a.plugin.localeCompare(b.plugin);
    });
    res.json({ plugins });
  }));

  /** ONE SKILL A PLUGIN SHIPS — its text, and everything shipped beside it.
   *
   * ONE ROUTE FOR THREE CONTAINERS, where there were two routes for two. A skill is the same
   * kind of thing whether a catalog package runs it as a stage, the platform loads it into
   * every flow, or a block team publishes it about their own server; the halves differed only
   * in how they FOUND the directory, which is not a difference a reader has a URL for.
   *
   * The listing page could say sdlc-plan scored what it scored and never show a line of what
   * sdlc-plan SAYS. Reading the skill is most of judging it: a score without the text is a
   * number about something the reader cannot see.
   *
   * RESOLVED THROUGH THE ENUMERATION, never by joining the route into a path. The walk that
   * lists a plugin's skills already resolved each one's directory, so this looks the name up
   * in that list and reads from the directory it finds. There is no path built from
   * `req.params` here, which is why there is no traversal guard either — the class of bug is
   * absent rather than defended against.
   *
   * References are inlined. The largest that exists is a few kilobytes, and a `file`
   * parameter with its own guard would be machinery for a problem nobody has yet. */
  app.get("/api/console/plugins/:plugin/skills/:skill", teamless("the plugin skill", async (req, res) => {
    // NO TEAM DIMENSION: this reads a skill's text off disk, the same file for every reader.
    const { plugin, skill } = req.params;
    const disk = diskPlugins().find((p) => p.plugin === plugin);
    const carried = disk ? undefined : blockSkills().get(plugin);
    const found = (disk ? skillsIn(disk.skillsDir) : carried ?? []).find((s) => s.name === skill);
    if (!found) {
      // NAMED SEPARATELY, because the two are different problems with different fixes: a
      // plugin nobody ships is a wrong address, and a skill missing from a plugin that does
      // exist is a renamed or deleted skill.
      if (!disk && !carried) {
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
