/**
 * A release tag: written once, and carried by origin.
 *
 * DELIBERATE: a tag already on the commit is pushed again rather than taken as done. The push is
 * what makes the tag a fact anyone else can read, and a run whose push failed — the network, a
 * refused credential — leaves the tag on this machine alone; a later run that read "the tag exists
 * here" as finished would never push it. Pushing a tag origin already carries changes nothing.
 *
 * A tag at a different commit is never moved: one number would name two pieces of code, and a tag
 * people have already pulled is not ours to redefine. Its commit is returned for the caller to
 * refuse (release.ts's tagOnce) or report (tag-live.ts).
 */
import { run } from "../deployment.ts";

export function placeTag(repo: string, name: string, commit: string, message: string): { wrote: boolean } | { elsewhere: string } {
  const at = (() => { try { return run("git", ["rev-parse", `${name}^{commit}`], { cwd: repo }); } catch { return null; } })();
  if (at && at !== commit) return { elsewhere: at };
  if (!at) run("git", ["tag", "-a", name, commit, "-m", message], { cwd: repo });
  run("git", ["push", "origin", `refs/tags/${name}`], { cwd: repo });
  return { wrote: !at };
}
