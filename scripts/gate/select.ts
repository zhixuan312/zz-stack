/**
 * Which gate modules a change affects, for `test:t1` and `test:t2`.
 *
 * This gate has no import graph to ask: a check reads the tree, spawns a check script or starts a
 * database, and nothing records what it touched. So the mapping is written down in
 * `scripts/gate/test-groups.json`: a path pattern maps to the gate modules (`scripts/gate/checks/
 * <subject>.ts`) that judge it. A path the map does not cover selects the whole gate — a smaller
 * run must never be a run that skipped the check which would have failed.
 *
 * "Since the last green run" is a marker file at `.gate-last-green` (gitignored) holding the
 * commit of the last passing run. With no marker, the change set is the diff against master plus
 * the working tree, which is what a branch holds before its first passing run. Writing the marker
 * after every pass is what keeps a per-change run from growing with the branch.
 *
 * Only `select()` and the marker helpers are exported; everything else here is how they answer.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { root } from "./read.ts";

export type Tier = 1 | 2;

interface Rule {
  readonly paths: readonly string[];
  readonly modules?: readonly string[];
  readonly all?: boolean;
}

interface GroupFile {
  readonly tier2: readonly string[];
  readonly groups: readonly Rule[];
}

/** The marker the test commands write after a passing run and read before the next. */
export const MARKER = ".gate-last-green";

const readGroups = (): GroupFile => {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "scripts/gate/test-groups.json"), "utf8"));
  if (parsed === null || typeof parsed !== "object") throw new Error("test-groups.json did not parse to an object");
  return parsed as GroupFile;
};

/** The gate's modules, read from `scripts/gate.ts` itself: the one file that says what the gate is. */
export function gateModules(): string[] {
  const source = readFileSync(join(root, "scripts/gate.ts"), "utf8");
  const loaded = [...source.matchAll(/await\s+load\(\s*"\.\/gate\/checks\/([A-Za-z0-9._-]+)\.ts"\s*\)/g)]
    .map((m) => m[1]);
  // `build` is the static import, not a `load` call, and every run needs it.
  return ["build", ...loaded];
}

const git = (args: readonly string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const isCommit = (ref: string): boolean => {
  try { git(["cat-file", "-e", `${ref}^{commit}`]); return true; } catch { return false; }
};

const isAncestor = (ref: string): boolean => {
  try { git(["merge-base", "--is-ancestor", ref, "HEAD"]); return true; } catch { return false; }
};

/**
 * Every path that changed since `base`, tracked or not, repo-relative.
 *
 * `git diff` compares the working tree to `base`, so staged and unstaged edits are both in it;
 * untracked files are not, and a new file is exactly the change a selection must not miss.
 */
function changedSince(base: string): string[] {
  const tracked = git(["diff", "--name-only", base]).split("\n").filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

/** The last green commit, when the marker names one this checkout can still reach. */
function lastGreen(): string | null {
  const marker = join(root, MARKER);
  if (!existsSync(marker)) return null;
  const ref = readFileSync(marker, "utf8").trim();
  // A rebase or a fresh clone can leave the marker naming a commit that is gone or off this
  // branch. Both mean "no usable marker", and the fallback below is the answer.
  return ref && isCommit(ref) && isAncestor(ref) ? ref : null;
}

/** The change set and how it was found, for the line the runner prints. */
export function changedPaths(): { paths: string[]; basis: string } {
  const green = lastGreen();
  if (green) return { paths: changedSince(green), basis: `since the last green run (${green.slice(0, 12)})` };
  for (const base of ["master", "origin/master"]) {
    if (!isCommit(base)) continue;
    try {
      const mergeBase = git(["merge-base", base, "HEAD"]);
      return { paths: changedSince(mergeBase), basis: `against ${base}` };
    } catch { /* not a related history; try the next ref */ }
  }
  return { paths: [], basis: "with no git history to compare — the whole gate" };
}

/** A path pattern as a regular expression: `**` crosses directories, `*` and `?` do not. */
const glob = (pattern: string): RegExp => {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      // `**/` also matches no directory at all, so `deploy/**` covers `deploy` itself.
      if (pattern[i + 2] === "/") { out += "(?:.*/)?"; i += 2; } else { out += ".*"; i += 1; }
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
};

const matchedBy = (path: string, rule: Rule): boolean =>
  rule.paths.some((p) => glob(p).test(path));

/** The check files the gate registers a child process for, and which module registers each. */
function registeredChecks(): Map<string, string[]> {
  const dir = join(root, "scripts/gate/checks");
  if (!existsSync(dir)) return new Map();
  const byFile = new Map<string, string[]>();
  for (const entry of readFileSync(join(root, "scripts/gate.ts"), "utf8").matchAll(
    /await\s+load\(\s*"\.\/gate\/checks\/([A-Za-z0-9._-]+)\.ts"\s*\)/g)) {
    const module = entry[1];
    const source = readFileSync(join(dir, `${module}.ts`), "utf8");
    for (const m of source.matchAll(/runs(?:Check|Shell)\(\s*"([A-Za-z0-9._-]+\.(?:ts|sh))"\s*\)/g)) {
      byFile.set(m[1], [...(byFile.get(m[1]) ?? []), module]);
    }
  }
  return byFile;
}

/** A check file's relative imports under `checks/`, resolved to repo-relative paths. */
function checkImports(file: string): string[] {
  const full = join(root, file);
  if (!existsSync(full)) return [];
  const source = readFileSync(full, "utf8");
  return [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)].flatMap((m) => {
    let spec = join(dirname(file), m[1]).replace(/\\/g, "/");
    if (!spec.endsWith(".ts") && !spec.endsWith(".sh")) spec += ".ts";
    return existsSync(join(root, spec)) ? [spec] : [];
  });
}

/**
 * The modules affected by a change to the check files themselves.
 *
 * A changed check file is affected when it is registered, or when a registered check file imports
 * it — directly or through the fixtures they share. A file nothing reaches selects the whole gate:
 * a check nobody registers is a check the gate already refuses, and a smaller run must not be the
 * one that hides it.
 */
function modulesForChecks(changed: readonly string[], all: string[]): string[] {
  const registered = registeredChecks();
  if (registered.size === 0) return all;
  // Which registered check files reach each changed file.
  const wanted = new Set<string>();
  for (const file of changed) {
    const name = file.replace(/^checks\//, "");
    if (registered.has(name)) { wanted.add(name); continue; }
    for (const candidate of registered.keys()) {
      const seen = new Set<string>();
      const stack = [`checks/${candidate}`];
      let reaches = false;
      while (stack.length && !reaches) {
        const at = stack.pop()!;
        if (seen.has(at)) continue;
        seen.add(at);
        for (const next of checkImports(at)) {
          if (next === file) { reaches = true; break; }
          if (next.startsWith("checks/")) stack.push(next);
        }
      }
      if (reaches) wanted.add(candidate);
    }
  }
  if (wanted.size === 0) return all;
  return [...new Set([...wanted].flatMap((f) => registered.get(f) ?? []))].sort();
}

export interface Selection {
  readonly modules: string[];
  readonly basis: string;
  readonly changed: string[];
  readonly whole: boolean;
}

/**
 * The modules `tier` should run.
 *
 * Tier 1 never runs a Tier 2 module: the tier-2 file convention is `<name>.perf.ts`, so `test:t1`
 * cannot quietly become the timed run. Tier 2 adds them. A repository with no such file has the
 * same selection in both tiers, which is honest rather than absent.
 */
export function select(tier: Tier): Selection {
  const groups = readGroups();
  const all = gateModules();
  const { paths, basis } = changedPaths();
  const isTier2 = (module: string): boolean =>
    groups.tier2.some((p) => glob(p).test(module));
  const allow = (modules: readonly string[]): string[] =>
    modules.filter((m) => tier === 2 || !isTier2(m));

  if (paths.length === 0) {
    // Nothing changed, so nothing is affected. The build still runs: it is the one check every
    // later check depends on, and a run that tested nothing should say so by doing only that.
    return { modules: allow(["build"]), basis: `${basis}; nothing changed`, changed: paths, whole: false };
  }

  const selected = new Set<string>(["build"]);
  let whole = false;
  const uncovered: string[] = [];
  for (const path of paths) {
    if (path.startsWith("checks/")) {
      for (const m of modulesForChecks([path], all)) selected.add(m);
      continue;
    }
    const rules = groups.groups.filter((r) => matchedBy(path, r));
    if (rules.length === 0) { uncovered.push(path); continue; }
    for (const rule of rules) {
      if (rule.all) whole = true;
      for (const m of rule.modules ?? []) selected.add(m);
    }
  }

  if (whole || uncovered.length > 0) {
    return {
      modules: allow(all),
      basis: whole ? `${basis}; a path that decides which checks run`
        : `${basis}; ${uncovered.length} path(s) the map does not cover`,
      changed: paths,
      whole: true,
    };
  }

  for (const m of selected) {
    if (!all.includes(m)) throw new Error(`test-groups.json names "${m}", which scripts/gate.ts does not load`);
  }
  return { modules: allow([...selected].sort()), basis, changed: paths, whole: false };
}

/** Record a passing run, so the next one starts from here. */
export function markGreen(): string {
  const head = git(["rev-parse", "HEAD"]);
  writeFileSync(join(root, MARKER), `${head}\n`);
  return head;
}
