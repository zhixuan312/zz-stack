/**
 * A third-party subject's source, fetched for replay (R2 item 5). A catalog subject's release is
 * a tag in the operator's own repository (`createWorktree`, git.ts); a subject `plugin_register`
 * captured from anywhere else has no such tag, but it has what that registration froze: the
 * source locator (`{ kind, locator }`), the release identity it landed on (`resolved_commit` for
 * git, `tarball_integrity` for a package, and `tree_digest` — every file — for all three) and
 * the whole-plugin `content_digest`. This file turns those back into the same bytes, in the same
 * place a catalog clone would sit, and refuses — the launcher then closes the run `failed` — when
 * the bytes are not the ones captured.
 *
 *   - git: `fetch --depth 1 <url> <resolved_commit>` into the launcher's own repository, https
 *     only, to the addresses a public-host check resolved (`pinGitPlan`), never the branch or
 *     tag the locator named (it may have moved since capture). A host that refuses a fetch by
 *     commit id refuses the replay; there is no fallback to whatever the ref names now.
 *   - package: `npm pack --ignore-scripts` of the registry spec from the operator's configured
 *     registry (no install, so no lifecycle script runs), its integrity compared before anything
 *     is extracted.
 *   - local_dir: a catalog directory, rebased from the platform host's catalog root onto
 *     `<repoRoot>/catalog` and confined there — never an arbitrary path on this host. It is
 *     `--repo`'s CURRENT content, pinned by `tree_digest` and `content_digest` together: a
 *     checkout whose copy of the plugin moved since capture — any file of it, not only its
 *     skills — fails the run, and the operator checks out the captured state to replay it.
 *     Only the files git tracks are copied, less any under `tests` (`IMAGE_UNSHIPPED`): the
 *     platform captured from its image, which a clean release tree built, so a `.DS_Store` or an
 *     editor's swap file in the operator's checkout is not part of what was captured.
 *
 * Whatever the kind, the fetched tree is refused before any git command reads it
 * (`gitInstruction`, @zz/catalog — the rule `plugin_register` refuses the same source by) when
 * it carries a `.git` entry or a `.gitattributes` naming a filter — a package or a copied
 * directory is somebody else's bytes, and git would take either as instructions. Then both
 * digests are recomputed with @zz/catalog's walks, the ones `plugin_register` used, the tree is
 * committed once into the launcher's own repository beside it (git.ts), so `changedPaths`
 * reports what the session produced exactly as it does for a catalog clone.
 *
 * COUPLED: `plugin_register` (services/zz-core/src/eval/subject-source.ts) writes the locator
 * and identity shapes read here, and `subjectReleaseRef` (replay-runs.ts) records the same
 * `git:` / `package:` / `local_dir:` ref `fetchThirdParty` returns — the launcher compares them.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import {
  gitInstruction, IMAGE_UNSHIPPED, pluginContentDigest, pluginDirComponents, pluginTreeDigest, publicHttpsUrl,
} from "@zz/catalog";

import {
  exposeGitDir, freshRepo, gitIn, initGitDir, removeWorktree, trackedFiles, untrackedFiles, type Worktree,
} from "./git.js";
import { GIT_EXEC_TIMEOUT_MS, networkEnv } from "./plan.js";

/** What `replay_read` hands back about a subject, the fields this file needs. */
interface SubjectSource {
  readonly subject_source_locator: unknown;
  readonly subject_content_digest?: string | null;
  readonly subject_release_identity?: Record<string, unknown> | null;
}

interface Digests { readonly digest: string; readonly treeDigest: string }

type FetchPlan = Digests & (
  /** `pin` is `http.curloptResolve` from `pinGitPlan`; a git plan without one is never fetched. */
  | { readonly kind: "git"; readonly url: string; readonly commit: string; readonly pin?: readonly string[] }
  | { readonly kind: "package"; readonly spec: string; readonly integrity: string }
  | { readonly kind: "local_dir"; readonly locator: string; readonly rel: string });

export function sourceKind(read: SubjectSource): string {
  const kind = (read.subject_source_locator as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" ? kind : "unrecorded";
}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
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
  const treeDigest = identity.tree_digest;
  if (kind !== "git" && kind !== "package" && kind !== "local_dir") {
    return `the subject's source is ${kind}, which the launcher has no way to fetch`;
  }
  if (typeof treeDigest !== "string" || !SHA256.test(treeDigest)) {
    return "the subject's release identity carries no tree_digest — it was captured before every file was " +
      "digested, so its hooks, commands and server code cannot be checked; register it again under a new version";
  }
  if (kind === "git") {
    const hashAt = locator.lastIndexOf("#");
    const url = hashAt === -1 ? locator : locator.slice(0, hashAt);
    if (!url.startsWith("https://")) return `only an https:// git source is fetched, not ${url}`;
    const commit = identity.resolved_commit;
    if (typeof commit !== "string" || !COMMIT.test(commit)) {
      return "the subject's release identity carries no resolved_commit — the commit it was captured at cannot be fetched";
    }
    return { kind, url, commit, digest, treeDigest };
  }
  if (kind === "package") {
    const integrity = identity.tarball_integrity;
    if (typeof integrity !== "string" || !integrity) {
      return "the subject's release identity carries no tarball_integrity — the tarball it was captured from cannot be verified";
    }
    if (locator.startsWith("-")) return `'${locator}' is not a registry package spec`;
    return { kind, spec: locator, integrity, digest, treeDigest };
  }
  // The platform host's catalog root is not this host's; the part below any `catalog/` is.
  const at = locator.lastIndexOf("/catalog/");
  const rel = at === -1 ? "" : locator.slice(at + "/catalog/".length).replace(/\/+$/, "");
  if (!rel || rel.startsWith("/") || SEGMENT_ESCAPE.test(rel)) {
    return `local_dir ${locator} is not a directory under a catalog root`;
  }
  return { kind, locator, rel, digest, treeDigest };
}

/** A git plan with its host checked again on THIS host — `plugin_register` checked it on the
 *  platform's, and a name can resolve differently here — and pinned to the addresses checked, so
 *  git's own lookup cannot answer differently (`publicHttpsUrl`, @zz/catalog). Other kinds pass
 *  through untouched. */
export async function pinGitPlan(plan: FetchPlan): Promise<FetchPlan> {
  if (plan.kind !== "git") return plan;
  const host = await publicHttpsUrl(plan.url);
  if ("error" in host) throw new Error(`launchReplay: ${plan.url} is not fetched — ${host.error}`);
  return { ...plan, pin: host.pin };
}

/** `npm pack` fetches over the network: twice a git step's budget, as `plugin_register`'s own reader allows. */
const exec = (file: string, args: string[], opts: { cwd: string; env: Record<string, string> }): string =>
  execFileSync(file, args, { ...opts, encoding: "utf8", timeout: 2 * GIT_EXEC_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });

/** Keeps git on the URL it was given: https only, no redirect to a host nobody named, no submodule. */
const FETCH_SAFE = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
  "-c", "http.followRedirects=false", "-c", "submodule.recurse=false"];

const SNAPSHOT_IDENTITY = ["-c", "user.name=zz-replay", "-c", "user.email=zz-replay@localhost", "-c", "commit.gpgsign=false"];

/** The checks every fetched tree passes before anything else reads it: nothing git would obey,
 *  then every file's digest, then the skills-and-manifest digest. Throws the refusal; `why` adds
 *  the likely cause to a tree-digest mismatch. */
function verifyTree(path: string, plan: FetchPlan, why?: () => string): void {
  const unsafe = gitInstruction(path);
  if (unsafe) {
    throw new Error(`launchReplay: the fetched source is refused — ${unsafe}, which git would run commands from`);
  }
  const tree = pluginTreeDigest(path);
  if ("error" in tree) throw new Error(`launchReplay: the fetched source cannot be digested — ${tree.error}`);
  if (tree.digest !== plan.treeDigest) {
    throw new Error(`launchReplay: the fetched source's files digest to ${tree.digest}, but the subject was ` +
      `captured at ${plan.treeDigest} — refusing to replay a different plugin${why ? ` (${why()})` : ""}`);
  }
  const got = pluginDirComponents(path);
  if ("error" in got) throw new Error(`launchReplay: the fetched source cannot be digested — ${got.error}`);
  const digest = pluginContentDigest(got.components);
  if (digest !== plan.digest) {
    throw new Error(`launchReplay: the fetched source has content digest ${digest}, but the subject was captured ` +
      `at ${plan.digest} — refusing to replay a different plugin`);
  }
}

/** The tree, already verified, committed once into a fresh launcher repository beside it. */
function snapshot(repo: Pick<Worktree, "path" | "gitDir">): string {
  initGitDir(repo);
  gitIn(repo, ["add", "-A", "--", "."]);
  gitIn(repo, [...SNAPSHOT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "subject source"]);
  return gitIn(repo, ["rev-parse", "HEAD"]);
}

/** The registry `npm pack` fetches from: the operator's own configured one, asked of npm under the
 *  operator's environment, because the pack itself runs under a throwaway `HOME` that holds no
 *  `.npmrc`. Only the URL crosses, credentials stripped — never a token. A scoped registry
 *  (`@scope:registry=`) is not carried; such a package fetches from this default one. */
function operatorRegistry(cwd: string): string {
  const raw = execFileSync("npm", ["config", "get", "registry"], {
    cwd, encoding: "utf8", timeout: GIT_EXEC_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`launchReplay: npm's configured registry '${raw}' is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`launchReplay: npm's configured registry is ${url.protocol}, not http(s)`);
  }
  url.username = "";
  url.password = "";
  return url.href;
}

function fetchPackage(plan: Extract<FetchPlan, { kind: "package" }>, dest: string): void {
  const scratch = mkdtempSync(join(tmpdir(), "zz-replay-pack-"));
  try {
    const registry = operatorRegistry(scratch);
    // A throwaway HOME: no `~/.npmrc` of the operator's (and no registry token in it) is read.
    // The same proxy and CA variables the launcher's git keeps (`networkEnv`, plan.ts).
    const env: Record<string, string> = {
      ...networkEnv(process.env), PATH: process.env.PATH ?? "", HOME: scratch, npm_config_cache: join(scratch, "cache"),
    };
    const out = exec("npm", ["pack", "--json", "--pack-destination", scratch, "--ignore-scripts", `--registry=${registry}`,
      "--", plan.spec], { cwd: scratch, env });
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
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The files git tracks in `--repo`'s copy of the catalog directory, less any under `tests`, into
 *  `dest`. Returns the directory copied from. A tracked file missing from the working tree is
 *  refused by name, and a symlink is copied as one, for `pluginTreeDigest` to refuse next. */
function copyLocalDir(plan: Extract<FetchPlan, { kind: "local_dir" }>, repoRoot: string, dest: string): string {
  const catalog = realpathSync(join(repoRoot, "catalog"));
  let src: string;
  try {
    src = realpathSync(join(catalog, plan.rel));
  } catch {
    throw new Error(`launchReplay: ${join(catalog, plan.rel)} does not exist in --repo's catalog`);
  }
  if (!src.startsWith(`${catalog}${sep}`)) throw new Error(`launchReplay: ${plan.rel} resolves outside --repo's catalog`);
  let tracked: string[];
  try {
    tracked = trackedFiles(src);
  } catch (err) {
    throw new Error(`launchReplay: git cannot list the files it tracks in ${src} — a local_dir subject is copied from ` +
      `a git checkout's tracked files: ${((err as { stderr?: string }).stderr ?? (err as Error).message).trim().slice(-300)}`);
  }
  for (const rel of tracked) {
    if (rel.split("/").includes(IMAGE_UNSHIPPED)) continue;
    const from = join(src, rel);
    let st;
    try {
      st = lstatSync(from);
    } catch {
      throw new Error(`launchReplay: ${rel} is tracked in --repo's ${plan.rel} but missing from its working tree`);
    }
    const parent = realpathSync(dirname(from));
    if (parent !== src && !parent.startsWith(`${src}${sep}`)) throw new Error(`launchReplay: ${rel} resolves outside --repo's ${plan.rel}`);
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else if (st.isFile()) copyFileSync(from, to);
    else throw new Error(`launchReplay: ${rel} in --repo's ${plan.rel} is not a regular file`);
  }
  return src;
}

/** Why a local_dir copy may digest differently from its capture: a tracked file changed since, or
 *  files git does not track — never copied, but digested by a platform that read a checkout's
 *  catalog (`ZZ_CATALOG_DIR`) or an image built from a tree that held them. Those are named. */
function mismatchCause(src: string): string {
  const moved = "a file git tracks in --repo differs from the captured one (check out the state it was captured at)";
  const extra = untrackedFiles(src);
  if (!extra.length) return moved;
  const shown = extra.slice(0, 5).join(", ") + (extra.length > 5 ? `, and ${extra.length - 5} more` : "");
  return `${moved}, or the capture saw files git does not track, which are never copied: ${shown}`;
}

/** The subject's source at exactly what it was captured as, in this run's tree, both digests
 *  checked and its launcher repository beside it. Throws — and removes what it made — on any
 *  failure or mismatch. A git plan must have been through `pinGitPlan`. */
export function fetchThirdParty(plan: FetchPlan, repoRoot: string, teamSlug: string): Worktree {
  const repo = freshRepo(teamSlug);
  try {
    let commit: string;
    let ref: string;
    if (plan.kind === "git") {
      if (!plan.pin) throw new Error(`launchReplay: ${plan.url} was never checked as a public host`);
      initGitDir(repo);
      gitIn(repo, [...FETCH_SAFE, ...plan.pin, "fetch", "--quiet", "--depth", "1", "--", plan.url, plan.commit]);
      gitIn(repo, ["checkout", "--detach", "--quiet", "FETCH_HEAD"]);
      commit = gitIn(repo, ["rev-parse", "HEAD"]);
      if (commit !== plan.commit) throw new Error(`launchReplay: ${plan.url} answered ${commit} for ${plan.commit}`);
      verifyTree(repo.path, plan);
      ref = `git:${plan.commit}`;
    } else {
      let why: (() => string) | undefined;
      if (plan.kind === "package") fetchPackage(plan, repo.path);
      else {
        const src = copyLocalDir(plan, repoRoot, repo.path);
        why = () => mismatchCause(src);
      }
      // Before the first git command: a copied `.git/config` would otherwise be the one it reads.
      verifyTree(repo.path, plan, why);
      commit = snapshot(repo);
      ref = plan.kind === "package" ? `package:${plan.integrity}` : `local_dir:${plan.locator}`;
    }
    exposeGitDir(repo);
    return { ref, ...repo, commit };
  } catch (err) {
    removeWorktree(repo);
    throw err;
  }
}

/** A one-plugin local marketplace holding a copy of the tree (patch applied, the gitfile left
 *  out) — `claude plugin marketplace add` installs only from a directory carrying
 *  `.claude-plugin/marketplace.json`, and a third-party source is a plugin, not a marketplace.
 *  Probed against claude 2.1: no `plugin.json` is needed, but the installed plugin reports
 *  "failed to load" once its marketplace directory is gone or unreadable — so it lives under
 *  `sessionRoot` (the candidate's own home, readable inside its sandbox, removed with it), never
 *  in the tree, where it would be reported as something the session produced. */
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
