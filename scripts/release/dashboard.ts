import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DASH_IMAGE, DASH_REMOTE, DASH_SRC, asExecError, published, run, ssh } from "../deployment.ts";
import { dashArg } from "./config.ts";

/** What this function can answer, across every path through it. `release` and `why` are
 *  always present; the rest name themselves only where the question that produced them was
 *  actually asked — `since` only once a last tag exists to diff against, `alreadyPublished`
 *  only once an image was actually checked for. */
export interface DashboardResolution {
  release: boolean;
  why: string;
  blocked?: boolean;
  current?: string | null;
  lastTag?: string;
  since?: string[];
  version?: string;
  alreadyPublished?: boolean;
}

export function resolveDashboard(): DashboardResolution {
  if (!existsSync(DASH_SRC)) {
    return { release: false, why: `no console checkout beside this repo at ${DASH_SRC}` };
  }
  const inDash = (a: string[]) => run("git", a, { cwd: DASH_SRC });
  const current = (() => {
    try { return JSON.parse(readFileSync(join(DASH_SRC, "package.json"), "utf8")).version || null; }
    catch { return null; }
  })();
  if (!current) return { release: false, why: "the console's package.json declares no version" };

  // A git that cannot answer is a blocked release, never an answer: read as empty output, a failed
  // `status` would be a clean tree and a failed `describe` a console that was never released.
  let dirty: string, tags: string, lastTag = "", since: string[] = [];
  try {
    dirty = inDash(["status", "--porcelain"]);
    tags = inDash(["tag", "--list"]);
    if (tags) {
      lastTag = inDash(["describe", "--tags", "--abbrev=0"]);
      since = inDash(["log", "--oneline", `${lastTag}..HEAD`]).split("\n").filter(Boolean);
    }
  } catch (err) {
    const e = asExecError(err);
    return { release: false, blocked: true, current,
             why: `git could not read the console's checkout at ${DASH_SRC}: ${(e.stderr || e.message).trim().slice(-200)}` };
  }
  if (dirty) {
    return { release: false, blocked: true, current,
             why: `the console's tree is dirty — commit or stash it, a release builds what is committed` };
  }
  if (!lastTag) {
    return { release: true, version: dashArg || current, current,
             why: "never released — no tag in zz-stack-dashboard" };
  }
  if (since.length === 0) {
    // The console is what people look at, so a host still on an older image than the one already
    // published is a difference nobody would attribute to the release: naming that published
    // version deploys it without a rebuild.
    if (dashArg) {
      if (published(`${DASH_IMAGE}:${dashArg}`)) {
        return { release: true, version: dashArg, current, lastTag, alreadyPublished: true,
                 why: `unchanged since ${lastTag}; ${DASH_IMAGE}:${dashArg} is already published, so it is deployed rather than rebuilt` };
      }
      return { release: false, blocked: true, current, lastTag,
               why: `unchanged since ${lastTag}, and no image exists at ${DASH_IMAGE}:${dashArg} — ` +
                    `either that release never finished or ${dashArg} is a number nothing was built for` };
    }
    return { release: false, current, lastTag,
             why: `unchanged since ${lastTag} — releasing it again would give an identical image a new number` };
  }
  if (!dashArg) {
    return { release: false, blocked: true, current, lastTag, since,
             why: `${since.length} commit(s) since ${lastTag}, so it NEEDS a release — pass --dashboard=<version>` };
  }
  return { release: true, version: dashArg, current, lastTag, since,
           why: `${since.length} commit(s) since ${lastTag}` };
}

/* What image the console is actually running, asked of compose rather than assumed from a
 * container name: the project name comes from the directory, so `zz-stack-dashboard-console-1`
 * holds only while the path is what it is today.
 * Empty string means nothing is running there, which is a fact and not an error. */
export function consoleImage() {
  return ssh(`cd ${DASH_REMOTE} 2>/dev/null && docker compose ps -q console 2>/dev/null | head -1 | ` +
             `xargs -r docker inspect --format '{{.Config.Image}}' || true`).trim();
}
