/**
 * A third-party subject's source, fetched for replay (R2 item 5). A catalog subject's release is
 * a tag in the operator's own repository (`createWorktree`, git.ts); a subject `plugin_register`
 * captured from anywhere else has no such tag, but it has what that registration froze: the
 * source locator (`{ kind, locator }`), the release identity it landed on (`resolved_commit` for
 * git, `tarball_integrity` for a package) and the whole-plugin `content_digest`. This file turns
 * those three back into the same bytes, in the same place a catalog clone would sit, and refuses
 * — the launcher then closes the run `failed` — when the bytes are not the ones captured.
 *
 *   - git: `init` + `fetch --depth 1 <url> <resolved_commit>` + detach, https only, never the
 *     branch or tag the locator named (it may have moved since capture). A host that refuses a
 *     fetch by commit id refuses the replay; there is no fallback to whatever the ref names now.
 *   - package: `npm pack --ignore-scripts` of the registry spec (no install, so no lifecycle
 *     script runs), its integrity compared before anything is extracted.
 *   - local_dir: a catalog directory, rebased from the platform host's catalog root onto
 *     `<repoRoot>/catalog` and confined there — never an arbitrary path on this host. It is
 *     `--repo`'s CURRENT content, pinned by digest alone: a checkout that moved since capture
 *     fails the run, and the operator checks out the captured state to replay it.
 *
 * Whatever the kind, the result is a git repository with the plugin's source at its root —
 * committed once, so `changedPaths` (git.ts) reports what the session produced exactly as it
 * does for a catalog clone — and its digest is recomputed with `pluginDirComponents` +
 * `pluginContentDigest` (@zz/catalog), the one walk `plugin_register` digested it with.
 *
 * COUPLED: `plugin_register` (services/zz-core/src/eval/subject-source.ts) writes the locator
 * and identity shapes read here, and `subjectReleaseRef` (replay-runs.ts) records the same
 * `git:` / `package:` / `local_dir:` ref `fetchThirdParty` returns — the launcher compares them.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { pluginContentDigest, pluginDirComponents } from "@zz/catalog";

import { runGit, worktreePathFor, type Worktree } from "./git.js";
import { GIT_EXEC_TIMEOUT_MS } from "./plan.js";

/** What `replay_read` hands back about a subject, the fields this file needs. */
interface SubjectSource {
  readonly subject_source_locator: unknown;
  readonly subject_content_digest?: string | null;
  readonly subject_release_identity?: Record<string, unknown> | null;
}

type FetchPlan =
  | { readonly kind: "git"; readonly url: string; readonly commit: string; readonly digest: string }
  | { readonly kind: "package"; readonly spec: string; readonly integrity: string; readonly digest: string }
  | { readonly kind: "local_dir"; readonly locator: string; readonly rel: string; readonly digest: string };

export function sourceKind(read: SubjectSource): string {
  const kind = (read.subject_source_locator as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" ? kind : "unrecorded";
}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SEGMENT_ESCAPE = /(^|\/)\.\.(\/|$)/;

/** Pure: what to fetch, or the refusal text. Every field the fetch leans on is checked here, so a
 *  subject captured before its identity carried it is refused rather than fetched loosely. */
export function thirdPartyPlan(read: SubjectSource): FetchPlan | string {
  const locator = (read.subject_source_locator as { locator?: unknown } | null)?.locator;
  const identity = read.subject_release_identity ?? {};
  const digest = read.subject_content_digest;
  const kind = sourceKind(read);
  if (typeof locator !== "string" || !locator) return `the subject's ${kind} source records no locator`;
  if (!digest) return "the subject records no content_digest to check its fetched source against";
  if (kind === "git") {
    const hashAt = locator.lastIndexOf("#");
    const url = hashAt === -1 ? locator : locator.slice(0, hashAt);
    if (!url.startsWith("https://")) return `only an https:// git source is fetched, not ${url}`;
    const commit = identity.resolved_commit;
    if (typeof commit !== "string" || !COMMIT.test(commit)) {
      return "the subject's release identity carries no resolved_commit — the commit it was captured at cannot be fetched";
    }
    return { kind, url, commit, digest };
  }
  if (kind === "package") {
    const integrity = identity.tarball_integrity;
    if (typeof integrity !== "string" || !integrity) {
      return "the subject's release identity carries no tarball_integrity — the tarball it was captured from cannot be verified";
    }
    if (locator.startsWith("-")) return `'${locator}' is not a registry package spec`;
    return { kind, spec: locator, integrity, digest };
  }
  if (kind === "local_dir") {
    // The platform host's catalog root is not this host's; the part below any `catalog/` is.
    const at = locator.lastIndexOf("/catalog/");
    const rel = at === -1 ? "" : locator.slice(at + "/catalog/".length).replace(/\/+$/, "");
    if (!rel || rel.startsWith("/") || SEGMENT_ESCAPE.test(rel)) {
      return `local_dir ${locator} is not a directory under a catalog root`;
    }
    return { kind, locator, rel, digest };
  }
  return `the subject's source is ${kind}, which the launcher has no way to fetch`;
}

/** `npm pack` fetches over the network: twice a git step's budget, as `plugin_register`'s own reader allows. */
const exec = (file: string, args: string[], opts: { cwd: string; env: Record<string, string> }): string =>
  execFileSync(file, args, { ...opts, encoding: "utf8", timeout: 2 * GIT_EXEC_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });

/** Keeps git on the URL it was given: https only, no redirect to a host nobody named, no submodule. */
const FETCH_SAFE = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
  "-c", "http.followRedirects=false", "-c", "submodule.recurse=false"];

const SNAPSHOT_IDENTITY = ["-c", "user.name=zz-replay", "-c", "user.email=zz-replay@localhost", "-c", "commit.gpgsign=false"];

/** A directory that is not a git repository yet becomes one, its whole content committed once. */
function snapshot(dir: string): string {
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["add", "-A", "--", "."]);
  runGit(dir, [...SNAPSHOT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "subject source"]);
  return runGit(dir, ["rev-parse", "HEAD"]);
}

function fetchPackage(plan: Extract<FetchPlan, { kind: "package" }>, dest: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "zz-replay-pack-"));
  try {
    // A throwaway HOME: no `~/.npmrc` of the operator's (and no registry token in it) is read.
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: scratch, npm_config_cache: join(scratch, "cache") };
    const out = exec("npm", ["pack", "--json", "--pack-destination", scratch, "--ignore-scripts", "--", plan.spec],
      { cwd: scratch, env });
    const entry = (JSON.parse(out) as { filename?: string; integrity?: string; shasum?: string }[])[0];
    if (!entry?.filename) throw new Error(`npm pack of ${plan.spec} produced no tarball`);
    const got = entry.integrity ?? entry.shasum;
    if (got !== plan.integrity) {
      throw new Error(`launchReplay: ${plan.spec} now packs to ${String(got)}, but the subject was captured from ` +
        `${plan.integrity} — refusing to replay a different tarball`);
    }
    const extracted = join(scratch, "extracted");
    mkdirSync(extracted);
    exec("tar", ["-xzf", join(scratch, entry.filename), "-C", extracted], { cwd: scratch, env });
    // npm-packlist's own convention: everything under one top-level `package/`.
    const root = existsSync(join(extracted, "package")) ? join(extracted, "package") : extracted;
    cpSync(root, dest, { recursive: true, verbatimSymlinks: true });
    return snapshot(dest);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function copyLocalDir(plan: Extract<FetchPlan, { kind: "local_dir" }>, repoRoot: string, dest: string): string {
  const catalog = realpathSync(join(repoRoot, "catalog"));
  let src: string;
  try {
    src = realpathSync(join(catalog, plan.rel));
  } catch {
    throw new Error(`launchReplay: ${join(catalog, plan.rel)} does not exist in --repo's catalog`);
  }
  if (!src.startsWith(`${catalog}${sep}`)) throw new Error(`launchReplay: ${plan.rel} resolves outside --repo's catalog`);
  cpSync(src, dest, { recursive: true, verbatimSymlinks: true, filter: (p) => !p.split(sep).includes(".git") });
  return snapshot(dest);
}

/** The subject's source at exactly what it was captured as, in this run's clone directory, its
 *  digest checked. Throws — and removes what it made — on any failure or mismatch. */
export function fetchThirdParty(plan: FetchPlan, repoRoot: string, teamSlug: string): Worktree {
  const path = worktreePathFor(teamSlug);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true });
  try {
    let commit: string;
    let ref: string;
    if (plan.kind === "git") {
      mkdirSync(path);
      runGit(path, ["init", "-q"]);
      runGit(path, [...FETCH_SAFE, "fetch", "--quiet", "--depth", "1", "--", plan.url, plan.commit]);
      runGit(path, ["checkout", "--detach", "--quiet", "FETCH_HEAD"]);
      commit = runGit(path, ["rev-parse", "HEAD"]);
      if (commit !== plan.commit) throw new Error(`launchReplay: ${plan.url} answered ${commit} for ${plan.commit}`);
      ref = `git:${plan.commit}`;
    } else if (plan.kind === "package") {
      commit = fetchPackage(plan, path);
      ref = `package:${plan.integrity}`;
    } else {
      commit = copyLocalDir(plan, repoRoot, path);
      ref = `local_dir:${plan.locator}`;
    }
    const got = pluginDirComponents(path);
    if ("error" in got) throw new Error(`launchReplay: the fetched source cannot be digested — ${got.error}`);
    const digest = pluginContentDigest(got.components);
    if (digest !== plan.digest) {
      throw new Error(`launchReplay: the fetched source has content digest ${digest}, but the subject was captured ` +
        `at ${plan.digest} — refusing to replay a different plugin`);
    }
    return { ref, path, commit };
  } catch (err) {
    rmSync(path, { recursive: true, force: true });
    throw err;
  }
}

/** A one-plugin local marketplace holding a copy of the clone (patch applied, `.git` left out) —
 *  `claude plugin marketplace add` installs only from a directory carrying
 *  `.claude-plugin/marketplace.json`, and a third-party source is a plugin, not a marketplace.
 *  Probed against claude 2.1: no `plugin.json` is needed, but the installed plugin reports
 *  "failed to load" once its marketplace directory is gone or unreadable — so it lives under
 *  `sessionRoot` (the candidate's own home, readable inside its sandbox, removed with it), never
 *  in the clone, where it would be reported as something the session produced. */
export function wrapAsMarketplace(worktree: Worktree, plugin: string, sessionRoot: string): string {
  const root = join(sessionRoot, "subject-marketplace");
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  cpSync(worktree.path, join(root, "plugin"), {
    recursive: true, verbatimSymlinks: true, filter: (p) => p !== join(worktree.path, ".git"),
  });
  writeFileSync(join(root, ".claude-plugin", "marketplace.json"), JSON.stringify({
    name: "zz-replay-subject", owner: { name: "zz-replay" },
    plugins: [{ name: plugin, source: "./plugin" }],
  }, null, 2));
  return root;
}
