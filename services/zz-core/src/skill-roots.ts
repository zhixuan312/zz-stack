/**
 * Where a skill can come from, and in what order two of one name are resolved.
 *
 * Three sources, and the order between them is the whole rule: the platform's own `/skills`,
 * then every flow in `/catalog` the caller's TEAM HAS INSTALLED, then the team's own store.
 * A flow installed today therefore serves without a restart, and one team cannot read
 * another team's method — which is what the installed-flows query is for, and why it is
 * cached per team rather than resolved once at startup.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseCaller } from "@zz/contracts";
import { catalogPackages, governingPlatformFlows } from "@zz/catalog";
import { requestHeaders } from "@zz/mcp-http";

import { userRoot } from "./paths.js";
import { db, teamFor } from "./platform-db.js";

/** Where a skill can come from before the catalog is consulted.
 *
 * Readable by everyone. A flow's skills are NOT here — those are served from /catalog, scoped
 * to what the caller's team has installed, which is what stops one team reading another team's
 * method.
 *
 * `/skills` is the platform's own — zz-backbone, zz-distil — true wherever this runs and ours.
 * `/blocks/<block>/skills` is a different kind of thing: written ABOUT somebody else's server,
 * from evidence gathered by calling it, and true only against the version it was checked on.
 * Mixed into one directory those two look identical and age completely differently, and when a
 * block is disconnected everything written about it has to be findable in one move.
 *
 * Discovered rather than listed, so connecting a block does not mean editing this file. */
const SKILL_ROOTS = ((): string[] => {
  const roots = ["/skills"];
  try {
    for (const e of readdirSync("/blocks", { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = join("/blocks", e.name, "skills");
      if (existsSync(dir)) roots.push(dir);
    }
  } catch { /* a deployment with no blocks connected is a deployment, not an error */ }
  return roots;
})();
/* Where the catalog IS, and how it is walked, are both @zz/catalog's. This file used to
 * carry `const CATALOG_DIR = "/catalog"` — a fourth spelling of one path, hardcoded, so
 * nothing could point this service at another catalog — and then, after that was fixed, went
 * on walking the directory itself for its skill roots. catalogPackages() is that walk: it
 * yields every package whether or not one ships a flow.json, which is the question
 * catalogEntries cannot answer and the reason the second walk existed. */

/** Packages owned by the platform rather than by a team. Everyone may read
 * these: they are how a person finds their access agent or builds a flow. */
const PLATFORM_OWNER = "zz";
/** Skill roots from the catalog (/catalog/<owner>/<package>/skills), scanned per
 * call so a newly synced package serves without a restart.
 *
 * Three kinds of package may reach a caller, and nothing else:
 *
 *   1. the platform's own (/catalog/zz/*) — how anyone finds their access agent
 *      or builds a flow, so everyone may read them;
 *   2. flows installed for the caller's team, from the registry;
 *   3. **the team's own packages** (/catalog/<team-slug>/*) — skills a team
 *      keeps for itself that are not part of any delivery flow. `zz-flow-builder`
 *      already writes to catalog/<team>/, so this is the existing convention,
 *      not a new one. A package needs no flow.json to serve: zz-access has no
 *      manifest at all and its skill is served today.
 *
 * `flows` null means "no limit", and is ONLY for local dev with no platform
 * database. With a database present the limit is what stops one team reading
 * another team's method by guessing a skill name.
 *
 * Order matters. skill_view returns the FIRST match, so a team package must
 * never shadow a platform skill or a flow stage skill of the same name — team
 * roots therefore go last.
 *
 * And the order is DECIDED here, not inherited from the filesystem. This walked
 * readdirSync unsorted, so which of two packages shipping a skill of one name
 * answered skill_view depended on directory order — different between two
 * containers of the same image, and not reproducible. @zz/catalog sorts its own
 * walk for exactly this reason. Nothing collides today; that is the argument for
 * fixing the order while nothing does, rather than the argument for leaving it.
 *
 * Platform first, then the flows the team installed, then the team's own: the
 * same rule the paragraph above states, applied to all three tiers instead of
 * the last one. */
function catalogSkillRoots(flows: Set<string> | null, team: string | null): string[] {
  const platform: string[] = [];
  const shared: string[] = [];
  const own: string[] = [];
  // The WALK is @zz/catalog's, and this had its own — the same two levels, sorted for the
  // same stated reason, but under a single try. So a FILE where an owner directory was
  // expected threw ENOTDIR, the catch below it said "no catalog mounted (local dev)", and
  // this returned whatever had accumulated: with a stray `.DS_Store`, which sorts first, the
  // empty list. No platform skills, no stage skills, no overlays, and skill_view finding
  // nothing, on any host running the build override that mounts the working tree.
  for (const { owner, name, dir: pkgDir } of catalogPackages()) {
    const ownedByCaller = !!team && owner === team;
    if (flows && owner !== PLATFORM_OWNER && !ownedByCaller && !flows.has(name)) continue;
    const dir = join(pkgDir, "skills");
    if (!existsSync(dir)) continue;
    if (owner === PLATFORM_OWNER) platform.push(dir);
    else if (ownedByCaller) own.push(dir);
    else shared.push(dir);
  }
  return [...platform, ...shared, ...own];
}
/** Which flows a team has installed. Cached like every other registry read;
 * a fresh install is visible within a minute without a restart. */
const flowsCache = new Map<string, { flows: Set<string>; expires: number }>();
async function installedFlows(team: string | null): Promise<Set<string> | null> {
  const p = db();
  if (!p) return null; // local dev, no registry to scope by
  if (!team) return new Set(); // no team yet -> platform packages only
  const hit = flowsCache.get(team);
  if (hit && hit.expires > Date.now()) return hit.flows;
  try {
    const { rows } = await p.query<{ flow: string }>(
      `SELECT f.flow FROM zz.flow_install f
       JOIN zz.team t ON t.id = f.team_id
       WHERE t.slug = $1`,
      [team],
    );
    const flows = new Set(rows.map((r) => r.flow));
    flowsCache.set(team, { flows, expires: Date.now() + 60_000 });
    return flows;
  } catch {
    if (hit) return hit.flows; // stale beats failing every skill read
    // THROWS rather than answering "none installed". Those are different facts and one
    // caller acts on the difference: flowDeclarationCheck refuses an initiative that names
    // no flow when the team runs more than one, and it read an empty set as "fewer than two"
    // and skipped itself. So during an outage a first document could be written with no
    // `flow:`, and the platform stamps every later document from that first one — leaving an
    // initiative permanently governed by nothing, which is the exact state this file's own
    // comment says is on this deployment already.
    //
    // GENUINELY INTERNAL, unlike teamsFor's and safePath's throws below — this stays a plain
    // `Error`, not a `Refusal`, so the tool boundary does not turn it into a text refusal on
    // its own. Both of its callers already catch it and decide for themselves: allSkillRoots
    // (above) degrades and serves what is on disk; flowDeclarationCheck, through
    // governingFlows(), turns it into its own house-style refusal that names the real cause
    // rather than a generic one. A third caller with no catch would need one added here, not
    // an exception carved out of this rule.
    throw new Error("flow registry unreachable — platform database");
  }
}
/** Every flow that could govern an initiative on this team: what they installed, PLUS the
 * platform flows the shelf ships to everyone.
 *
 * Kept apart from installedFlows() because the two answer different questions and one caller
 * needs each. Scoping which skills a team can read is a question about the registry, and a
 * platform package is outside it by design. Deciding whether an initiative must name its
 * flow is a question about what this team can actually RUN, and the answer has always
 * included zz-block-eval and zz-skill-eval — they were simply invisible to the check,
 * because they have no zz.flow_install row and never will.
 *
 * Both halves of that mattered on this deployment. team-one has one install, so the check
 * asked nothing, and a zz-block-eval initiative it opened was governed by ops-flow end to
 * end. zz-platform has none at all, so `flows.size < 2` skipped the check entirely for the
 * one team whose whole purpose is running these flows. */
export async function governingFlows(team: string | null): Promise<Set<string> | null> {
  const installed = await installedFlows(team);
  if (!installed) return null;
  return new Set([...installed, ...governingPlatformFlows()]);
}
/** Every place a skill can come from, in the order that decides which wins.
 *
 * Every flow's skills come from the catalog, scoped by what the CALLER's team has installed.
 * There is no separately mounted "the" flow: one deployment serves many, and a single
 * mounted default handed every caller that team's method whatever their membership.
 *
 * LAST is the team's OWN store — `<team root>/skills/<name>/SKILL.md` — and it is last for
 * the same reason the catalog's team packages are: skill_view returns the first match, so a
 * root that comes after can add a name but can never take one. A team cannot shadow
 * zz-backbone by accident, and cannot shadow a stage of the flow it runs.
 *
 * That it lives in the team's own store is the point. A team package under `catalog/<team>/`
 * works, and reaching it means a pull request into the product repository — so the cheapest
 * possible contribution, one skill that helps this team do one step better, costs a review
 * by us. Here it costs nothing: the store is already theirs, already a git repository, and
 * already the thing they take with them. The contribution path starts where the work is.
 *
 * Additive, never a replacement. What a team wants at `ops-select` is usually another
 * consideration alongside it, not a different ops-select — and the ordering means the
 * platform never has to decide whether they meant to replace one, because they cannot.
 *
 * Returns the roots AND whether the scoping behind them could be established.
 *
 * `degraded` is not decoration. teamFor THROWS when the platform database cannot be reached
 * and there is no cached answer — it says so rather than guessing, which is right — and this
 * function swallowed that into `team = null`, which resolves to platform packages only. So
 * during an outage skill_view answered "no skill named 'ops-select' is available to you —
 * either it does not exist, or its flow is not installed for your team", and the reader goes
 * to an admin to install a flow they already have. The one thing the caller needed to know
 * was the one thing the message could not say.
 */
export async function allSkillRoots(): Promise<{ roots: string[]; degraded: boolean }> {
  const email = parseCaller(requestHeaders()).email;
  let team: string | null = null;
  let degraded = false;
  try {
    team = await teamFor(email);
  } catch {
    // Reading a skill must not hard-fail on a database hiccup — the platform's own skills are
    // on disk and still worth serving. What changes is that the caller is told.
    degraded = true;
  }
  // Already degraded means teamFor failed, so there is nothing to ask the registry about.
  // If the registry itself fails, that is the same degradation one step later.
  let flows: Set<string> | null = null;
  if (!degraded) {
    try {
      flows = await installedFlows(team);
    } catch {
      degraded = true;
    }
  }
  const roots = [...SKILL_ROOTS, ...catalogSkillRoots(degraded ? new Set() : flows, team)];
  try {
    const own = join(await userRoot(), "skills");
    if (existsSync(own)) roots.push(own);
  } catch { /* no store yet: a person with nothing written has nothing to add */ }
  return { roots, degraded };
}
