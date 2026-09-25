/**
 * The git facts `zz-tool release-apply` decides from (`apply.ts`), kept apart from the CLI so a
 * fixture check can drive them against a real throwaway repository: which commit a release
 * starts from, which commit a release tag names, and whether a candidate's commit is inside it.
 *
 * Why tags: a commit that exists only in the clone the release ran in (a throwaway clone, its
 * branch never pushed) is no record at all — the next release, from another clone, cannot
 * resolve it. A release tag the release command pushed (`git ls-remote`), or created in a
 * repository with no remote, can be. So a release is recorded by the commit its tag names, and
 * only once that tag is confirmed to contain the candidate's own commit — never by the
 * worktree's HEAD, and never by a `<plugin>@<version>` label no git command resolves.
 */
import { execFileSync } from "node:child_process";

const GIT_TIMEOUT_MS = 60_000;

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
export function gitQuiet(cwd: string, args: string[]): void {
  try { execFileSync("git", args, { cwd, timeout: GIT_TIMEOUT_MS, stdio: "ignore" }); }
  catch { /* nothing there to remove, or already gone — both are the success case here */ }
}
/** The commit `ref` names in `repoRoot`, or null when it names none. */
export function commitOf(repoRoot: string, ref: string): string | null {
  try { return git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]); }
  catch { return null; }
}

/** Whether `ancestor` is `descendant` or reachable from it. */
function isAncestor(repoRoot: string, ancestor: string, descendant: string): boolean {
  try { git(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]); return true; }
  catch { return false; }
}

function hasOrigin(repoRoot: string): boolean {
  try { git(repoRoot, ["remote", "get-url", "origin"]); return true; }
  catch { return false; }
}

/** Pulls origin's tags into the clone, so the ancestry checks below see every published release.
 *  No origin, or an unreachable one, leaves the local tags as the whole answer. */
export function fetchTags(repoRoot: string): void {
  if (hasOrigin(repoRoot)) gitQuiet(repoRoot, ["fetch", "--quiet", "--tags", "origin"]);
}

/** The commit a release tag names, confirmed published: on origin when the clone has one (its
 *  peeled commit, for an annotated tag), else as a local tag of a repository with no remote. */
function publishedTagCommit(repoRoot: string, tag: string): { commit: string } | { refused: string } {
  if (hasOrigin(repoRoot)) {
    let listed = "";
    try { listed = git(repoRoot, ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]); }
    catch (err) { return { refused: `git ls-remote origin failed: ${(err as Error).message}` }; }
    const lines = listed.split("\n").filter(Boolean).map((l) => l.split(/\s+/));
    const peeled = lines.find(([, ref]) => ref === `refs/tags/${tag}^{}`) ?? lines.find(([, ref]) => ref === `refs/tags/${tag}`);
    if (!peeled) return { refused: `tag ${tag} is not on origin — the release command did not push it` };
    gitQuiet(repoRoot, ["fetch", "--quiet", "origin", "tag", tag]);
    if (!commitOf(repoRoot, peeled[0])) return { refused: `tag ${tag} on origin names ${peeled[0]}, which this clone cannot fetch` };
    return { commit: peeled[0] };
  }
  const local = commitOf(repoRoot, `refs/tags/${tag}`);
  return local ? { commit: local } : { refused: `tag ${tag} does not exist in ${repoRoot}` };
}

/** The `release_ref` to record for a release of `candidateCommit` published under `tag`: the
 *  tag's own commit, and only when the tag contains the candidate's commit — a tag that does not
 *  is some other release, never this one. A refusal carries `published`, the tag's commit, when
 *  the tag itself is published and only the ancestry failed: a release command that squashed or
 *  rebased the candidate's commit publishes exactly that, and `--reconcile` lets an operator
 *  accept it by name (`apply.ts`) rather than leave the attempt applying forever. */
export function releaseRefFor(
  repoRoot: string, tag: string, candidateCommit: string,
): { commit: string } | { refused: string; published: string | null } {
  const published = publishedTagCommit(repoRoot, tag);
  if ("refused" in published) return { ...published, published: null };
  if (!isAncestor(repoRoot, candidateCommit, published.commit)) {
    return {
      refused: `tag ${tag} (${published.commit}) does not contain the candidate's commit ${candidateCommit} — ` +
        "it is another release, or the release command squashed or rebased the candidate's commit",
      published: published.commit,
    };
  }
  return published;
}

/** Every tag in the clone whose commit contains `commit` — non-empty means some release carries it. */
export function tagsContaining(repoRoot: string, commit: string): string[] {
  try { return git(repoRoot, ["tag", "--contains", commit]).split("\n").filter(Boolean); }
  catch { return []; }
}

/** The commit a release starts from, or why there is none. The platform's recorded ref wins when
 *  this clone resolves it, and an operator's `--base-ref` must then agree with it. When the
 *  recorded ref does not resolve here (a commit from another clone, or a label no git command
 *  resolves), a valid `--base-ref` stands in — but only once it is shown to be inside the base
 *  version's own release: `baseTag` must resolve and contain it. With nothing recorded at all,
 *  `--base-ref` is the operator's word, as before. */
export function resolveBase(
  repoRoot: string, planRef: string | null, operatorRef: string | null, baseTag: string | null,
): { commit: string } | { refused: string } {
  const fromPlan = planRef ? commitOf(repoRoot, planRef) : null;
  const fromOperator = operatorRef ? commitOf(repoRoot, operatorRef) : null;
  if (operatorRef && !fromOperator) return { refused: `--base-ref ${operatorRef} names no commit in ${repoRoot}` };
  if (fromPlan && fromOperator && fromPlan !== fromOperator) {
    return { refused: `--base-ref ${operatorRef} is ${fromOperator}, but the base subject was released from ${fromPlan}` };
  }
  if (fromPlan) return { commit: fromPlan };
  if (planRef) {
    if (!fromOperator) {
      return { refused: `the base subject's recorded release ref ${planRef} is not in ${repoRoot} — pass --base-ref and --base-tag` };
    }
    const tagCommit = baseTag ? commitOf(repoRoot, `refs/tags/${baseTag}`) : null;
    if (!tagCommit) {
      return {
        refused: `the recorded release ref ${planRef} does not resolve here, so --base-ref must be ` +
          `checked against the base version's release tag — pass --base-tag naming a tag this clone has${baseTag ? ` (${baseTag} is not one)` : ""}`,
      };
    }
    if (!isAncestor(repoRoot, fromOperator, tagCommit)) {
      return { refused: `--base-ref ${operatorRef} (${fromOperator}) is not inside the base release tag ${baseTag} (${tagCommit})` };
    }
    return { commit: fromOperator };
  }
  return fromOperator ? { commit: fromOperator } : {
    refused: "nothing records the commit the base subject was released from — pass --base-ref " +
      "naming it (the commit whose catalog carries the base version)",
  };
}
