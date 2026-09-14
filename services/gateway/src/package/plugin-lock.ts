/**
 * WHAT EACH PLUGIN IS, computed from the catalog alone — no request, no caller, no database.
 *
 * A plugin declares a version in its flow.json and nothing has ever checked it:
 * `scripts/set-version.mjs` bumps every manifest in the workspace and never touches `catalog/`.
 * So a plugin's content could move under a frozen number indefinitely, and an evaluation of
 * "plugin X at version V" that cannot say what V contained is an evaluation of nothing.
 *
 * `skills.lock.json` already solves this one level down, and its own header says why: "the hash
 * is not an alternative to the version. It is what makes the version true: this file records
 * both, the gate compares them, and a skill whose text changed without its version changing is
 * refused." This is that argument applied to the unit people actually install.
 *
 * NO REQUEST, and that constraint shapes the whole module. It is called by a release script and
 * by the gate, both of which run on a laptop with no gateway, no identity and no database —
 * which is also why the two directory constants live HERE rather than in client-package.ts.
 * That file needs a caller to do anything; this one must not.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { catalogEntries } from "@zz/catalog";

import type { PackageFile } from "../client-package.js";
import { digestOfPlugin } from "./describe.js";
import { BASELINE, pluginName } from "./skills.js";

/** The platform's own skills — the `zz` plugin's content. Overridable because the gate builds
 *  real packages on a machine where /skills does not exist. */
export const SKILLS_DIR = process.env.ZZ_SKILLS_DIR || "/skills";

/** The `zz` plugin's own eval cases. Beside its skills for the same reason they are: `zz` is
 *  the one plugin everybody installs, which makes it the one most worth knowing about, and the
 *  only one whose content is not catalog-resident. Same override, same reason. */
export const EVALS_DIR = process.env.ZZ_EVALS_DIR || "/evals";

/** Where a skill's declared version and content hash are recorded. */
const SKILLS_LOCK = "skills.lock.json";

interface PluginSkill { name: string; version: string; sha: string }

interface PluginLockEntry {
  name: string;
  version: string;
  /** This plugin's own content identity — see digestOfPlugin. Not the shelf's. */
  digest: string;
  /** The eval suite this version shipped with, or "" when it has none. A Δ measured against
   *  four cases and a Δ measured against one are not the same measurement, so a score has to be
   *  able to name the suite it was taken against. */
  cases_digest: string;
  skills: PluginSkill[];
}

/** Every file under one directory, as package files rooted at `prefix`.
 *
 * DIRECTORIES only at the top level, the same rule client-package.ts keeps and for the same
 * reason its comment gives: a stray file there — a README, an editor's leftover — once threw
 * ENOTDIR and took package building down for everyone, from a file that is not a skill.
 *
 * AND A SUITE'S OUTPUT IS NOT PART OF ITS IDENTITY.
 *
 * `evals/results/` holds what running the suite produced — one directory per run, different on
 * every machine, and `.gitignore`d for exactly that reason. This walk had no exclusions, so it
 * hashed them into the committed `plugins.lock.json`, and the consequence was invisible to
 * whoever ran it: the digest reproduced fine on the machine that wrote it and could not be
 * reproduced anywhere else. A fresh clone recomputed a different value and was told "CHANGED
 * WITHOUT A VERSION BUMP — bump the version in its flow.json", which names the wrong cause
 * entirely; no version bump fixes a digest that depends on files git does not carry.
 *
 * The exclusion is STRUCTURAL rather than a `.gitignore` read, because this file is compiled
 * into the image, where there is no git and no working tree to ask. The principle holds in both
 * places and needs neither: a digest over a suite covers the cases, never the run. */
const OUTPUT_DIR = "results";

function walkTree(root: string, prefix: string): PackageFile[] {
  if (!existsSync(root)) return [];
  const out: PackageFile[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.name === OUTPUT_DIR) continue;
      const abs = join(dir, f.name);
      if (f.isDirectory()) walk(abs, `${rel}/${f.name}`);
      else out.push({ path: `${prefix}/${rel}/${f.name}`, content: readFileSync(abs, "utf8") });
    }
  };
  for (const e of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === OUTPUT_DIR) continue;
    if (e.isDirectory()) walk(join(root, e.name), e.name);
  }
  return out;
}

/** A digest over one file set, used for the eval suite. Empty when there are no files, so that
 *  "no suite" and "a suite that happens to hash to something" are distinguishable. */
function treeDigest(files: PackageFile[]): string {
  if (!files.length) return "";
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(f.path).update("\0").update(f.content).update("\0");
  }
  return h.digest("hex").slice(0, 8);
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
    throw new Error(`${SKILLS_LOCK} is missing — run \`node scripts/skill-versions.mjs --write\``);
  }
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, { version: string; sha: string }>;
  return names.map((name) => {
    const row = lock[name];
    if (!row) {
      // Named rather than skipped. A member silently dropped from a plugin's membership is a
      // member the profile cannot resolve an event to, and the symptom arrives much later as
      // "this plugin was never used".
      throw new Error(
        `skill "${name}" ships in plugin "${plugin}" and is absent from ${SKILLS_LOCK} — run ` +
        "`node scripts/skill-versions.mjs --write`");
    }
    return { name, version: row.version, sha: row.sha };
  });
}

/** The platform's version, from the gateway's own manifest.
 *
 * Resolved from `repoRoot` rather than through `serviceVersion(import.meta.url)`, which looks
 * exactly one directory up for a package.json. This module compiles to `dist/package/`, one
 * level deeper than `client-package.js` does, so that call finds nothing and returns its
 * "0.0.0" fallback — a wrong version that looks like a real one. The path below is right from a
 * checkout and from inside the image, both of which have the manifest where it says. */
function platformVersion(repoRoot: string): string {
  const f = join(repoRoot, "services", "gateway", "package.json");
  if (!existsSync(f)) throw new Error(`cannot read the platform version: ${f} does not exist`);
  return (JSON.parse(readFileSync(f, "utf8")) as { version: string }).version;
}

/** Every evaluable plugin, with its content identity and what it contained.
 *
 * `repoRoot` is where skills.lock.json lives; it is passed rather than derived because the gate
 * and the release script know their own root and this module must not guess at one.
 */
export function pluginLock(repoRoot: string): PluginLockEntry[] {
  const out: PluginLockEntry[] = [];

  // ── the catalog-resident plugins ───────────────────────────────────
  //
  // THE BASELINE IS SKIPPED HERE AND ADDED BELOW, because it is the one entry whose manifest
  // and whose content live in different places. Taking it from this loop would lock a plugin
  // whose `skills/` and `evals/` directories do not exist — an empty digest, no members, and a
  // second entry of the same name beside the real one.
  for (const e of catalogEntries()) {
    if (e.flow === BASELINE) continue;
    const name = pluginName(e.flow);
    const version = e.manifest.version;
    if (!version) {
      throw new Error(`${e.owner}/${e.flow}/flow.json declares no version — a plugin whose ` +
                      "number nobody set is a number nothing can vouch for");
    }
    const skillFiles = walkTree(join(e.dir, "skills"), "skills");
    const caseFiles = walkTree(join(e.dir, "evals"), "evals");
    out.push({
      name,
      version,
      digest: digestOfPlugin({
        name,
        description: e.manifest.description ?? "",
        required: false,
        servers: (e.manifest.servers ?? []).map((sv) => ({ name: sv.name, url: "" })),
        files: [...skillFiles, ...caseFiles],
      }),
      cases_digest: treeDigest(caseFiles),
      skills: lockedSkills(repoRoot, skillNames(join(e.dir, "skills")), name),
    });
  }

  // ── zz-core, the one plugin everybody installs ─────────────────────
  //
  // Its CONTENT is not catalog-resident: client-package.ts synthesises it per caller. Its
  // manifest is — `catalog/zz/zz-core/flow.json` — which is why the loop above skips it rather
  // than never seeing it. Excluding it altogether would be the easy call and the wrong one: it
  // is the plugin every account carries, so it is the one most worth knowing about.
  //
  // What makes it tractable is that its per-caller half is exactly one file. `routerSkill(flows)`
  // is GENERATED from this person's installed flows and is never on disk, so walking SKILLS_DIR
  // excludes it by construction rather than by a filter somebody has to remember. Commands are
  // derived from the skills too, so they add nothing a skill change would not already move.
  //
  // What is left is stable content: the platform's own skills, plus its eval suite. Include the
  // router and the digest differs per person, the gate fails for everybody at once, and the
  // number means nothing.
  const zzSkills = walkTree(SKILLS_DIR, "skills");
  if (zzSkills.length) {
    const zzCases = walkTree(EVALS_DIR, "evals");
    out.push({
      name: BASELINE,
      version: platformVersion(repoRoot),
      digest: digestOfPlugin({
        name: BASELINE,
        // The description interpolates the caller's target, so it is deliberately NOT hashed:
        // it is addressed to a person, not part of what the plugin is.
        description: "",
        required: true,
        servers: [{ name: "zz-core", url: "" }],
        files: [...zzSkills, ...zzCases],
      }),
      cases_digest: treeDigest(zzCases),
      skills: lockedSkills(repoRoot, skillNames(SKILLS_DIR), BASELINE),
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}
