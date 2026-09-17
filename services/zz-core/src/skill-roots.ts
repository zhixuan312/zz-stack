/**
 * Where a skill can come from, and in what order two of one name are resolved.
 *
 * Three sources, and the order between them is the whole rule: the platform's own `/skills`,
 * then every package in `/catalog`, then the team's own store.
 *
 * EVERY CATALOG PACKAGE IS READABLE BY EVERYONE. Reading used to be scoped to the flows a
 * team had "installed", from a registry the platform no longer keeps: it cannot see what is
 * on a person's machine, so it does not decide what they may read either.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { catalogPackages } from "@zz/catalog";

import { userRoot } from "./paths.js";

/** Where a skill can come from before the catalog is consulted.
 *
 * Readable by everyone. A flow's skills are NOT here — those are served from /catalog.
 *
 * `/skills` is the platform's own — the SKILLS zz-platform and zz-distil — true wherever this
 * runs and ours. (`zz-platform` is also the platform TEAM's slug, at :158 below and in
 * identity.ts/paths.ts. Different namespace: a team is a directory under `teams/`, a skill is
 * a directory under a skills root, and nothing resolves a bare slug against both.)
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

/** Packages owned by the platform. Their skills come first, so no other package can shadow
 * one of them. */
const PLATFORM_OWNER = "zz";
/** Skill roots from the catalog (/catalog/<owner>/<package>/skills), scanned per call so a
 * newly synced package serves without a restart.
 *
 * Platform first, then every other package. skill_read returns the FIRST match, and the order
 * is DECIDED here rather than inherited from the filesystem: @zz/catalog sorts its walk, so
 * which of two packages shipping a skill of one name answers is the same in every container. */
function catalogSkillRoots(): string[] {
  const platform: string[] = [];
  const shared: string[] = [];
  for (const { owner, dir: pkgDir } of catalogPackages()) {
    const dir = join(pkgDir, "skills");
    if (!existsSync(dir)) continue;
    (owner === PLATFORM_OWNER ? platform : shared).push(dir);
  }
  return [...platform, ...shared];
}
/** Every place a skill can come from, in the order that decides which wins.
 *
 * LAST is the team's OWN store — `<team root>/skills/<name>/SKILL.md` — because skill_read
 * returns the first match, so a root that comes after can add a name but can never take one. A
 * team cannot shadow the zz-platform SKILL by accident, and cannot shadow a stage of a flow.
 *
 * That it lives in the team's own store is the point: the store is already theirs, already a
 * git repository, and already the thing they take with them. The contribution path starts
 * where the work is. Additive, never a replacement. */
export async function allSkillRoots(): Promise<string[]> {
  const roots = [...SKILL_ROOTS, ...catalogSkillRoots()];
  try {
    const own = join(await userRoot(), "skills");
    if (existsSync(own)) roots.push(own);
  } catch { /* no store yet: a person with nothing written has nothing to add */ }
  return roots;
}
