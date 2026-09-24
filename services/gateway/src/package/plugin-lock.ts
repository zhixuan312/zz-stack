/**
 * What each plugin is, computed from the catalog alone — no request, no caller, no database.
 *
 * A content hash beside the declared version is what makes the version true: without it a
 * plugin's content can move under a frozen number, and an evaluation of "plugin X at version
 * V" cannot say what V contained. `skills.lock.json` is the same argument one level down.
 *
 * DELIBERATE: no request, no caller. This is called by the release script and by the gate,
 * both of which run on a laptop with no gateway, no identity and no database — which is why
 * the two directory constants live here rather than in client-package.ts, which needs a
 * caller to do anything.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { catalogEntries, pluginName } from "@zz/catalog";

import { PLATFORM_VERSION } from "../client-package.js";

import type { PackageFile } from "../client-package.js";
import { digestOfPlugin } from "./describe.js";
import { BASELINE } from "./skills.js";

/** The platform's own skills — the `zz` plugin's content. Overridable because the gate builds
 *  real packages on a machine where /skills does not exist. */
export const SKILLS_DIR = process.env.ZZ_SKILLS_DIR || "/skills";

/** Where a skill's declared version and content hash are recorded. */
const SKILLS_LOCK = "skills.lock.json";

interface PluginSkill { name: string; version: string; sha: string }

interface PluginLockEntry {
  name: string;
  version: string;
  /** This plugin's own content identity — see digestOfPlugin. Not the shelf's. */
  digest: string;
  /** The skills this plugin ships, each with its declared version and content hash. */
  skills: PluginSkill[];
}

/** Every file under one directory, as package files rooted at `prefix`.
 *
 * COUPLED: directories only at the top level, the same rule client-package.ts keeps. A stray
 * file there throws ENOTDIR and takes package building down.
 */
function walkTree(root: string, prefix: string): PackageFile[] {
  if (!existsSync(root)) return [];
  const out: PackageFile[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, f.name);
      if (f.isDirectory()) walk(abs, `${rel}/${f.name}`);
      else out.push({ path: `${prefix}/${rel}/${f.name}`, content: readFileSync(abs, "utf8") });
    }
  };
  for (const e of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) walk(join(root, e.name), e.name);
  }
  return out;
}


/** The top-level directory names under a tree — one per skill. */
function skillNames(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function lockedSkills(root: string, names: string[], plugin: string): PluginSkill[] {
  const lockPath = join(root, SKILLS_LOCK);
  if (!existsSync(lockPath)) {
    throw new Error(`${SKILLS_LOCK} is missing — run \`node scripts/skill-versions.ts --write\``);
  }
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, { version: string; sha: string }>;
  return names.map((name) => {
    const row = lock[name];
    if (!row) {
      // Named rather than skipped: a member silently dropped from a plugin's membership is
      // one the profile cannot resolve an event to, and it surfaces much later as "this
      // plugin was never used".
      throw new Error(
        `skill "${name}" ships in plugin "${plugin}" and is absent from ${SKILLS_LOCK} — run ` +
        "`node scripts/skill-versions.ts --write`");
    }
    return { name, version: row.version, sha: row.sha };
  });
}

/** The platform's version, from the gateway's own manifest.
 *
 * DELIBERATE: resolved from `repoRoot`, not through `serviceVersion(import.meta.url)`, which
 * looks exactly one directory up. This module compiles to `dist/package/`, one level deeper
 * than client-package.js, so that call returns its "0.0.0" fallback. */
function platformVersion(repoRoot: string): string {
  const f = join(repoRoot, "services", "gateway", "package.json");
  if (!existsSync(f)) throw new Error(`cannot read the platform version: ${f} does not exist`);
  return (JSON.parse(readFileSync(f, "utf8")) as { version: string }).version;
}

/** Every evaluable plugin, with its content identity and what it contained.
 *
 * `repoRoot` is where skills.lock.json lives. It is passed rather than derived: the gate and
 * the release script know their own root, and this module must not guess at one.
 */
export function pluginLock(repoRoot: string): PluginLockEntry[] {
  const out: PluginLockEntry[] = [];

  // The catalog-resident plugins. The baseline is skipped here and added below: its manifest
  // is catalog-resident and its content is not, so taking it from this loop locks a plugin
  // whose `skills/` does not exist — an empty digest and a duplicate entry.
  for (const e of catalogEntries()) {
    if (e.flow === BASELINE) continue;
    const name = pluginName(e.flow);
    // COUPLED: one release version for every plugin, the platform's own, because
    // client-package stamps PLATFORM_VERSION into the plugin.json a person installs. A
    // manifest declaring its own gives "which version is installed" two answers, and
    // evaluation compares versions.
    const version = PLATFORM_VERSION;
    const skillFiles = walkTree(join(e.dir, "skills"), "skills");
    out.push({
      name,
      version,
      digest: digestOfPlugin({
        name,
        description: e.manifest.description ?? "",
        required: false,
        servers: (e.manifest.servers ?? []).map((sv) => ({ name: sv.name, url: "" })),
        files: skillFiles,
      }),
      skills: lockedSkills(repoRoot, skillNames(join(e.dir, "skills")), name),
    });
  }

  // zz-core, the one plugin everybody installs. Its manifest is catalog-resident and its
  // content is not — client-package.ts synthesises it per caller.
  //
  // DELIBERATE: the per-caller half is excluded by walking SKILLS_DIR. `routerSkill(flows)`
  // is generated from the person's installed flows and never on disk, and commands are
  // derived from the skills. Hashing the router makes the digest differ per person, which
  // fails the gate for everybody and means nothing.
  const zzSkills = walkTree(SKILLS_DIR, "skills");
  if (zzSkills.length) {
    out.push({
      name: BASELINE,
      version: platformVersion(repoRoot),
      digest: digestOfPlugin({
        name: BASELINE,
        // DELIBERATE: not hashed. The description interpolates the caller's target — it is
        // addressed to a person, not part of what the plugin is.
        description: "",
        required: true,
        servers: [{ name: "zz-core", url: "" }],
        files: zzSkills,
      }),
      skills: lockedSkills(repoRoot, skillNames(SKILLS_DIR), BASELINE),
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}
