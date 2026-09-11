/**
 * The catalog: the flows a team can run and the blocks they can reach, with the skills each
 * one ships.
 *
 * These are the reads that are about the PLATFORM rather than any team's work, which is why
 * they go through `teamless` — a flow's manifest and a block's skills are the same facts for
 * everybody, and passing a scope nobody narrows by would imply otherwise.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { catalogEntries, catalogEntry } from "@zz/catalog";
import type { Express } from "express";

import { platformDb } from "../db.js";
import { handler, teamless } from "./shared.js";
import { blockSkills, readSkillAt } from "./skill-source.js";

export function mountCatalog(app: Express): void {
  /** EVERY FLOW IN THE CATALOG, with what the store knows about each one.
  *
  * The console listed SKILLS, from `zz.skill` — which records what has RUN. So sdlc-flow,
  * installed on zz-team since August, was invisible: nineteen skills nobody has called yet,
  * and a page reading the telemetry could not know they exist. casebox-assist had the same
  * problem for the same reason.
  *
  * Two authorities, and they answer different questions. The CATALOG says what exists —
  * a flow, its stages in order, the documents it gates. The STORE says what happened —
  * versions served, evals, calls. A flow in the catalog with no telemetry reads as "never
  * run", which is a true and useful answer; the old shape rendered it as absent.
  *
  * Ordered by stages, from the manifest, so the sequence shown is the flow's own and not
  * an alphabetical accident. That is also why `zz.skill.ordinal` stays null: the order is
  * declared in one place already, and a copy in the database is a copy that drifts.
  */
  app.get("/api/console/flows", handler("flows", async (_req, res, scope) => {
    const db = platformDb();
    // WHICH TEAMS INSTALLED WHICH FLOW is per-team data — a department's flow adoption is
    // not every other department's business. A team scope narrows the installs list to the
    // caller's own team; the `ran` stats below stay global because they count calls by
    // skill name, not by team, and carry no team column to leak.
    //
    // TWO COMPLETE STATEMENTS, not one assembled from `scope` — see the note in
    // /api/console/initiatives above; `check:sql` can only PREPARE a literal it can read
    // whole.
    const installsQuery = scope.kind === "platform"
      ? db.query(`select f.flow, f.version, f.agent_name, t.slug as team
                  from zz.flow_install f join zz.team t on t.id = f.team_id
                 order by f.flow, t.slug`)
      : db.query(`select f.flow, f.version, f.agent_name, t.slug as team
                  from zz.flow_install f join zz.team t on t.id = f.team_id
                 where t.slug = $1 order by f.flow, t.slug`, [scope.slug]);
    const [installs, ran] = await Promise.all([
      installsQuery,
      db.query(`select s.name, s.flow,
                       (select count(*) from zz.skill_version v where v.skill_id = s.id) as versions,
                       (select count(*) from zz.event e
                         where e.kind = 'tool_call' and e.step = s.name)                 as calls,
                       -- WHEN IT LAST RAN. The list sorts on it, so a flow nobody has
                       -- touched in a month sinks below one in use rather than sitting
                       -- wherever the catalog walk happened to put it.
                       (select to_char(max(e.ts) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') from zz.event e
                         where e.kind = 'tool_call' and e.step = s.name)                 as last_run,
                       (select count(*) from zz.eval ev
                          join zz.skill_version v on v.id = ev.skill_version_id
                         where v.skill_id = s.id)                                        as evals
                  from zz.skill s where s.kind = 'flow_step'`),
    ]);
    const stats = new Map(ran.rows.map((r) => [r.name as string, r]));
    const teams = new Map<string, { team: string; version: string; agent: string }[]>();
    for (const i of installs.rows) {
      const got = teams.get(i.flow as string) ?? [];
      got.push({ team: i.team as string, version: i.version as string, agent: i.agent_name as string });
      teams.set(i.flow as string, got);
    }
    // EVERY flow, including the platform's own, each saying which it is.
    //
    // This filtered `kind` out entirely — "a platform capability everyone already has, not a
    // method a team adopts" — which is a true distinction and the wrong conclusion for a
    // console. Five capabilities were invisible here: zz-access, zz-admin, zz-flow-builder
    // and both evaluation flows. They have skills, versions, runs and refusals like anything
    // else, and a page that omits them shows a platform smaller than the one running.
    //
    // `platform: true` carries the distinction to the reader instead of deciding for them.
    //
    // A FLOWS PAGE LISTS FLOWS, and a package is a flow when it SAYS it is one. `stages` is
    // the declaration and there is no other. zz-admin declared none and shipped no skills
    // directory at all — installing it granted an MCP tool surface and that was the whole of
    // it. It sat in this table beside ops-flow with "never run" against both, which invites
    // the reader to compare a toolbox with a method and ask why one was never adopted. It
    // was never adopted because there was nothing in it to adopt. The package is gone now,
    // folded into zz-access, but the rule it produced is the load-bearing part.
    //
    // The first attempt at this filtered on `entry || stages`, and that was inference wearing
    // a filter's clothes: it happened to give the right answer for the eight packages that
    // exist, and it would have kept giving an answer for a ninth that declared nothing.
    // Guessing is wrong even when it guesses right, because the day it guesses wrong there is
    // nothing to point at. The gate now refuses a manifest that declares `entry` without
    // `stages`, so a flow cannot reach this line undeclared — see
    // docs/repository-architecture.md.
    const flows = catalogEntries()
      .filter((e) => (e.manifest.stages ?? []).length > 0)
      .map((e) => {
      const stages = (e.manifest.stages ?? []).map((x) => x.name);
      const docs = e.manifest.documents ?? [];
      // THE FRONT DOOR, which `stages` does not contain. ops-flow declares six stages
      // and is itself a seventh skill — the one that describes the whole method — so
      // a console listing only the stages listed everything except the flow.
      const entryName = e.manifest.entry ?? null;
      const entryStat = entryName ? stats.get(entryName) : undefined;
      return {
        flow: e.flow,
        owner: e.owner,
        agentName: e.manifest.agentName ?? null,
        version: e.manifest.version ?? null,
        description: e.manifest.description ?? null,
        // EVERY FLOW USES THE PLATFORM BLOCK. A manifest's `tools` names the blocks a
        // flow reaches OUT to, and ours is not one of those — it is where the flow's own
        // skills, store and gates live, so no manifest declares it and every flow needs
        // it. Listing only `tools` showed sdlc-flow using no blocks at all, which reads
        // as a flow that talks to nothing.
        // OWNERSHIP, NOT SHAPE. `shelved` says ZZ owns this and every account already has
        // it, so a team cannot install it. It says nothing about whether it is a flow —
        // zz-skill-eval is shelved and has five stages — and the reader is told which
        // rather than having the two conflated for them.
        platform: e.manifest.shelved === true,
        blocks: ["platform", ...(e.manifest.tools ?? [])],
        gates: docs.filter((d) => d.gate === true).length,
        documents: docs.map((d) => ({ name: d.name, role: d.role ?? null, gate: d.gate === true })),
        installs: teams.get(e.flow) ?? [],
        entry: entryName && !stages.includes(entryName)
          ? {
            name: entryName,
            versions: entryStat ? +entryStat.versions : 0,
            calls: entryStat ? +entryStat.calls : 0,
            evals: entryStat ? +entryStat.evals : 0,
            everRun: !!entryStat && +entryStat.calls > 0,
            lastRun: (entryStat?.last_run as string | null) ?? null,
          }
          : null,
        steps: stages.map((name, i) => {
          const st = stats.get(name);
          return {
            name, position: i + 1,
            versions: st ? +st.versions : 0,
            calls: st ? +st.calls : 0,
            evals: st ? +st.evals : 0,
            // A step the catalog declares and the store has never seen. Not an error —
            // a flow nobody has run yet is a flow, and saying so is the point.
            everRun: !!st && +st.calls > 0,
            lastRun: (st?.last_run as string | null) ?? null,
          };
        }),
      };
    });
    // MOST RECENTLY USED FIRST. The order was the catalog walk's — owner then name,
    // alphabetical — which put casebox-assist above ops-flow for no reason a reader could
    // see. A flow nobody has run has no date and sorts last, by name among its own
    // kind, so the tail is stable rather than arbitrary.
    for (const f of flows) {
      (f as typeof f & { lastRun: string | null }).lastRun =
        f.steps.map((s) => s.lastRun).filter(Boolean).sort().pop() ?? null;
    }
    flows.sort((a, b) => {
      const la = (a as { lastRun?: string | null }).lastRun ?? "";
      const lb = (b as { lastRun?: string | null }).lastRun ?? "";
      if (la !== lb) return lb.localeCompare(la);
      return a.flow.localeCompare(b.flow);
    });
    res.json({ flows });
  }));

  /** Every block, one row each — never averaged together. */
  app.get("/api/console/blocks", teamless("blocks", async (_req, res) => {
    // NO TEAM DIMENSION: a block is platform infrastructure — its registry entry and its
    // call volume are the same for every reader, the same census category as /overview.
    const db = platformDb();
    // FROM THE REGISTRY, NOT FROM THE TELEMETRY. This grouped zz.event, so the list
    // was "every surface that has ever been called" — and a stand-in we are about to
    // stop showing is called constantly, so it would come straight back. The registry
    // says what exists and where it came from; the telemetry says what happened to it.
    //
    // `origin <> 'stand_in'` is the whole point. RuleMill and bookit are our own mocks
    // from the zz-blocks image and this page is where a block's skills get improved —
    // there is nobody on the other end of a puppet. They stay in Overview, Activity
    // and a skill's own call mix, because those report what our flows DID and hiding
    // them would make a flow's totals stop adding up.
    const { rows } = await db.query(
      // title and kind travel with the block, not in a map in the console — see migration 034.
      `select b.name as block, b.origin, b.title, b.kind,
              coalesce(e.calls,0) as calls, coalesce(e.failed,0) as failed,
              coalesce(e.tools,0) as tools, coalesce(e.steps,0) as steps,
              coalesce(e.versions,0) as versions, e.first_seen, e.last_seen
         from zz.block b
         left join (
           select coalesce(block,'platform') as block, count(*) as calls,
                  count(*) filter (where ok = false) as failed,
                  count(distinct subject) as tools, count(distinct step) as steps,
                  count(distinct block_version_id) as versions,
                  to_char(min(ts),'YYYY-MM-DD') as first_seen,
                  to_char(max(ts),'YYYY-MM-DD') as last_seen
             from zz.event where kind = 'tool_call' group by 1
         ) e on e.block = b.name
        where b.origin <> 'stand_in'
        order by (b.origin = 'platform') desc, coalesce(e.calls,0) desc`);
    // Which skills each block has, and whose they are. Two different things share
    // this shelf: what the block team published (vendored, `source:` in every one)
    // and what we worked out by calling them.
    const skills = blockSkills();
    res.json({ blocks: rows.map((r) => ({
      block: r.block, origin: r.origin,
      // Empty where nobody has described the block. The console shows the id then, which is
      // what it already did for any block missing from its hand-written map.
      title: r.title || null, kind: r.kind || null,
      calls: +r.calls, failed: +r.failed,
      failureRate: +r.calls ? +(( +r.failed / +r.calls) * 100).toFixed(1) : 0,
      tools: +r.tools, steps: +r.steps, versions: +r.versions,
      firstSeen: r.first_seen, lastSeen: r.last_seen,
      // `dir` is deliberately dropped here: a filesystem path is not something a
      // browser needs and not something a console should hand out.
      skills: (skills.get(r.block as string) ?? []).map(({ dir: _dir, ...rest }) => rest),
    })) });
  }));

/** ONE SKILL A FLOW RUNS — the same shape as a block's, because it is the same thing.
 *
 * The flow page could say ops-intent scored 3.42 and never show a line of what ops-intent
 * SAYS. Reading the skill is most of judging it: a score without the text is a number
 * about something the reader cannot see.
 *
 * Resolved through the catalog entry for the flow, then an exact name match among the
 * directories it ships — not by joining the route into a path.
 *
 * `includePlatform` IS ON, and the comment it replaces is why this broke. It said the flag
 * stayed off "so a platform capability like zz-flow-builder is unreachable here, which
 * matches it being absent from the flow list" — a guard justified entirely by a fact about
 * another route. When /api/console/flows stopped filtering on `kind`, platform flows joined
 * the list, the page began linking to their skills, and every one of those links landed on a
 * 404 from here. zz-skill-eval's five stages were unreadable in the console that ran them.
 *
 * A guard whose reason lives in another file's behaviour is a guard that stops being right
 * without anybody touching it.
 *
 * ENTRY SKILLS ARE REACHABLE. A flow's `stages` do not include its own front door —
 * ops-flow declares six stages and is itself a seventh skill — so the entry is accepted
 * alongside them or the one skill describing the whole method could be read nowhere. */
  app.get("/api/console/flows/:flow/skills/:skill", teamless("the flow skill", async (req, res) => {
    // NO TEAM DIMENSION: this reads a skill's text off disk, resolved through the flow's
    // own catalog entry — the same file for every reader, whatever their scope.
    const { flow, skill } = req.params;
    const entry = catalogEntry(flow, true);
    const stages = (entry?.manifest.stages ?? []).map((x) => x.name);
    const allowed = new Set([...stages, entry?.manifest.entry].filter(Boolean) as string[]);
    if (!entry || !allowed.has(skill)) {
      res.status(404).json({ error: `no skill '${skill}' in flow '${flow}'` });
      return;
    }
    const dir = join(entry.dir, "skills", skill);
    if (!existsSync(join(dir, "SKILL.md"))) {
      res.status(404).json({ error: `'${flow}' declares '${skill}' and ships no SKILL.md for it` });
      return;
    }
    res.json({
      flow,
      isEntry: entry.manifest.entry === skill,
      // A flow's own skills are ours: we write them, we version them, we evolve them.
      ...readSkillAt(dir, skill, "ours", null),
    });
  }));

/** ONE SKILL A BLOCK CARRIES — the text itself, and whatever it ships beside it.
   *
   * A block's skills are its method, and until now the console could say a block had
   * four of them and not a word of what any one said. That is the same gap the document
   * reader closed for initiatives: knowing a thing exists is not reading it.
   *
   * RESOLVED THROUGH THE ENUMERATION, never by joining the route into a path. The walk
   * that lists a block's skills already resolved each one's directory, so this looks the
   * name up in that map and reads from the directory it finds. There is no path built
   * from `req.params` here, which is why there is no traversal guard either — the class
   * of bug is absent rather than defended against. It also means the platform's skills
   * work for free: they come from two roots, `/skills` and every catalog package the
   * platform owns, and only the enumeration knows that.
   *
   * References are inlined. The one that exists is five kilobytes, and a `file`
   * parameter with its own guard would be machinery for a problem nobody has yet. */
  app.get("/api/console/blocks/:block/skills/:skill", teamless("the block skill", async (req, res) => {
    // NO TEAM DIMENSION: same reasoning as the flow-skill reader above — this reads a
    // skill's text off disk, the same file for every reader.
    const { block, skill } = req.params;
    const found = blockSkills().get(block)?.find((s) => s.name === skill);
    if (!found) {
      res.status(404).json({ error: `no skill '${skill}' on block '${block}'` });
      return;
    }
    res.json({ block, ...readSkillAt(found.dir, found.name, found.origin, found.source) });
  }));

  /** One block, in isolation: its tools, its refusals, which steps call it, and
   * its own event log. `platform` means zz-core's own tools and is deliberately
   * addressable the same way — the worst-refusing tool on the platform is ours,
   * and a view that only covered third parties would never have shown it. */
  app.get("/api/console/blocks/:block", teamless("the block", async (req, res) => {
    // NO TEAM DIMENSION: `zz.event` here is filtered by block, not by team — the same
    // platform-wide call log every reader sees for any other block.
    const db = platformDb();
    const raw = req.params.block;
    // `platform` is the label for "no block", so it maps to a null filter rather
    // than to a block named "platform", which does not exist.
    const isPlatform = raw === "platform";
    // TWO COMPLETE STATEMENTS PER QUERY, not one assembled from `isPlatform` — see the note
    // in /api/console/initiatives above; `check:sql` can only PREPARE a literal it can read
    // whole.
    const [tools, refusals, steps, feed, versions] = await Promise.all([
      isPlatform
        ? db.query(`select subject as tool, count(*) as calls,
                       count(*) filter (where ok = false) as failed
                  from zz.event where kind='tool_call' and block is null
                 group by 1 order by count(*) desc limit 25`)
        : db.query(`select subject as tool, count(*) as calls,
                       count(*) filter (where ok = false) as failed
                  from zz.event where kind='tool_call' and block = $1
                 group by 1 order by count(*) desc limit 25`, [raw]),
      isPlatform
        ? db.query(`select subject as tool, count(*) as n, min(refusal) as refusal
                  from zz.event where kind='tool_call' and ok = false and block is null
                 group by 1, refusal order by count(*) desc limit 25`)
        : db.query(`select subject as tool, count(*) as n, min(refusal) as refusal
                  from zz.event where kind='tool_call' and ok = false and block = $1
                 group by 1, refusal order by count(*) desc limit 25`, [raw]),
      isPlatform
        ? db.query(`select step, count(*) as calls, count(*) filter (where ok=false) as failed,
                       count(distinct subject) as tools
                  from zz.event where kind='tool_call' and block is null
                    and step is not null and step <> ''
                 group by 1 order by count(*) desc`)
        : db.query(`select step, count(*) as calls, count(*) filter (where ok=false) as failed,
                       count(distinct subject) as tools
                  from zz.event where kind='tool_call' and block = $1
                    and step is not null and step <> ''
                 group by 1 order by count(*) desc`, [raw]),
      isPlatform
        ? db.query(`select to_char(ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as ts, subject as tool,
                       coalesce(step,'') as step, ok, refusal
                  from zz.event where kind='tool_call' and block is null
                 order by ts desc limit 25`)
        : db.query(`select to_char(ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as ts, subject as tool,
                       coalesce(step,'') as step, ok, refusal
                  from zz.event where kind='tool_call' and block = $1
                 order by ts desc limit 25`, [raw]),
      isPlatform
        ? Promise.resolve({ rows: [] })
        : db.query(`select bv.version, count(bt.*) as tools,
                           count(*) filter (where bt.verdict='preferred')      as preferred,
                           count(*) filter (where bt.verdict='use_with_care')  as care,
                           count(*) filter (where bt.verdict='avoid')          as avoid
                      from zz.block_version bv
                      join zz.block b on b.id = bv.block_id
                      left join zz.block_tool bt on bt.block_version_id = bv.id
                     where b.name = $1 group by 1 order by 1 desc`, [raw]),
    ]);
    res.json({
      block: raw,
      tools: tools.rows.map((t) => ({ tool: t.tool, calls: +t.calls, failed: +t.failed })),
      refusals: refusals.rows.map((r) => ({ tool: r.tool, n: +r.n, refusal: r.refusal })),
      steps: steps.rows.map((s) => ({ step: s.step, calls: +s.calls, failed: +s.failed, tools: +s.tools })),
      feed: feed.rows,
      versions: versions.rows.map((v) => ({ version: v.version, tools: +v.tools,
        preferred: +v.preferred, useWithCare: +v.care, avoid: +v.avoid })),
    });
  }));
}
