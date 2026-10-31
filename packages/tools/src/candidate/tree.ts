/**
 * What a catalog candidate's build needs beside the clone that the clone cannot carry: the console
 * checkout the gate reads, and the docker CLI plugins it runs. Both are READ-ONLY inside the
 * build's sandbox — the build writes only the clone and its own home (candidate/build.ts) — so a
 * patched build script can read them and change neither. Dependencies are not here: the clone
 * installs its own from its release's lockfile (`npm ci`, build.ts).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

import { GIT_EXEC_TIMEOUT_MS, GIT_HARDENED_ARGS, hardenedGitEnv } from "./git.js";

/** The operator's docker CLI plugins, linked into the build's own home: the gate runs
 *  `docker compose config` (no daemon), and docker finds `compose` only under
 *  `$HOME/.docker/cli-plugins`, which is the throwaway home here. Each link points at the
 *  plugin's real file, never at `~/.docker` itself — its `config.json` holds registry
 *  credentials. Returns the plugin files that live under the operator's home, which the sandbox
 *  denies as a whole: each is re-allowed for reading by its exact path, and nothing beside it. */
export function linkDockerPlugins(homeRoot: string): string[] {
  const src = join(userInfo().homedir, ".docker", "cli-plugins");
  if (!existsSync(src)) return [];
  const home = realpathSync(userInfo().homedir);
  const dest = join(homeRoot, ".docker", "cli-plugins");
  mkdirSync(dest, { recursive: true });
  const underHome: string[] = [];
  for (const name of readdirSync(src)) {
    let target: string;
    try { target = realpathSync(join(src, name)); } catch { continue; } // a dangling link
    symlinkSync(target, join(dest, name));
    if (target.startsWith(`${home}/`)) underHome.push(target);
  }
  return underHome;
}

/** A clone of `--repo`'s sibling console checkout beside the tree, where the gate looks for it
 *  (`../zz-stack-dashboard`, scripts/gate/checks/console.ts), and fails without it. A clone, never
 *  a link to the operator's own checkout: the build may read it, and nothing it does reaches the
 *  real one. Returns the clone's path for the sandbox to re-allow, or null when `--repo` has no
 *  sibling — the gate then fails and names the missing repository itself. */
export function cloneConsoleSibling(repoRoot: string, treePath: string): string | null {
  const src = resolve(repoRoot, "..", "zz-stack-dashboard");
  if (!existsSync(join(src, ".git"))) return null;
  const dest = join(dirname(treePath), "zz-stack-dashboard");
  execFileSync("git", [...GIT_HARDENED_ARGS, "clone", "--quiet", "--no-hardlinks", "--", src, dest], {
    env: hardenedGitEnv(process.env), timeout: GIT_EXEC_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"],
  });
  return dest;
}
