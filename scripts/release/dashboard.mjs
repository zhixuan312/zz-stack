
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DASH_IMAGE, DASH_REMOTE, DASH_SRC, published, run, ssh } from "../deployment.mjs";
import { dashArg, version } from "./config.mjs";

export function resolveDashboard() {
  if (!existsSync(DASH_SRC)) {
    return { release: false, why: `no console checkout beside this repo at ${DASH_SRC}` };
  }
  const inDash = (a) => {
    try { return run("git", a, { cwd: DASH_SRC }); } catch { return ""; }
  };
  const current = (() => {
    try { return JSON.parse(readFileSync(join(DASH_SRC, "package.json"), "utf8")).version || null; }
    catch { return null; }
  })();
  if (!current) return { release: false, why: "the console's package.json declares no version" };

  const dirty = inDash(["status", "--porcelain"]).trim();
  if (dirty) {
    return { release: false, blocked: true, current,
             why: `the console's tree is dirty — commit or stash it, a release builds what is committed` };
  }
  const lastTag = inDash(["describe", "--tags", "--abbrev=0"]);
  if (!lastTag) {
    return { release: true, version: dashArg || current, current,
             why: "never released — no tag in zz-stack-dashboard" };
  }
  const since = inDash(["log", "--oneline", `${lastTag}..HEAD`]).split("\n").filter(Boolean);
  if (since.length === 0) {
    // It matters here: the console is what people look at, so a
    // production that quietly kept the previous one while UAT moved is a difference nobody
    // would attribute to the release.
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
 * container name. The project name comes from the directory, so `zz-stack-dashboard-console-1`
 * is only what it is called while the path is what it is today — and the one thing this
 * function exists to catch is a console that is not the one anybody thinks it is.
 * Empty string means nothing is running there, which is a fact and not an error. */
export function consoleImage() {
  return ssh(`cd ${DASH_REMOTE} 2>/dev/null && docker compose ps -q console 2>/dev/null | head -1 | ` +
             `xargs -r docker inspect --format '{{.Config.Image}}' || true`).trim();
}
