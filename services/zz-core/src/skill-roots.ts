/**
 * Where a skill can come from, and in what order two of one name are resolved.
 *
 * Two sources, and the order between them is the whole rule: the platform's own `/skills`, then
 * every package in `/catalog`.
 *
 * DELIBERATE: there was a third — `<team root>/skills`, the team's own store — and it is gone
 * with the store. A team's own skills were files in a git repository the platform kept for them;
 * the store is retired, so a skill a team wrote for itself is no longer a place a skill can come
 * from, and a name it used to shadow resolves to the catalog's own or to nothing.
 *
 * Every catalog package is readable by everyone. The platform cannot see what is on a person's
 * machine, so it does not decide what they may read either.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { catalogPackages } from "@zz/catalog";

/** Where a skill can come from before the catalog is consulted. Readable by everyone. A flow's
 * skills are not here — those are served from /catalog.
 *
 * `/skills` is the platform's own, true wherever this runs. (`zz-platform` is also the platform
 * team's slug, in identity.ts and paths.ts. Different namespace: a team is a directory under
 * `teams/`, a skill is a directory under a skills root, and nothing resolves a bare slug against
 * both.)
 */
const SKILL_ROOTS = ["/skills"];
/* COUPLED: where the catalog is, and how it is walked, are both @zz/catalog's. catalogPackages()
 * is that walk — it yields every package whether or not one ships a flow.json, which is the
 * question catalogEntries cannot answer. */

/** Packages owned by the platform. Their skills come first, so no other package can shadow
 * one of them. */
const PLATFORM_OWNER = "zz";
/** Skill roots from the catalog (/catalog/<owner>/<package>/skills), scanned per call so a newly
 * synced package serves without a restart.
 *
 * Platform first, then every other package. skill_read returns the first match, and the order is
 * decided here rather than inherited from the filesystem: @zz/catalog sorts its walk, so which of
 * two packages shipping a skill of one name answers is the same in every container. */
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
 * The platform's own first, then the catalog's packages in `catalogSkillRoots`' order, because
 * skill_read returns the first match and the order is what decides which of two skills of one
 * name answers. */
export function allSkillRoots(): string[] {
  return [...SKILL_ROOTS, ...catalogSkillRoots()];
}
