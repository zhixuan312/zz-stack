/**
 * `plugin_register`'s three source readers (FR-2), and the refusals that bound them.
 *
 * Split out of subject.ts because every one of them turns a caller-controlled string into a
 * read of something the platform host can reach — a directory, a clone, a registry fetch — and
 * that boundary is this file's whole job: `local_dir` is confined to the catalog root, `git` is
 * https-only to a public host, and `package` is a registry spec and nothing else. A locator that
 * fails any of those is refused before a single byte is read.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

import { CATALOG_DIR, manifestAt } from "@zz/catalog";
import { addressResolver } from "@zz/contracts";

/** One entry of `component_manifest`. `kind: "config"` is part of the declared shape for a
 *  component this catalog schema does not carry yet (deploy/environment declarations, say) —
 *  none is emitted today because nothing in `CatalogManifest` represents one. */
export interface Component {
  readonly kind: "skill" | "server" | "flow" | "config";
  readonly name: string;
  readonly digest: string;
}

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** `plugin_register`'s `source_kind: "local_dir"` reader: every SKILL.md under the directory
 *  (or its own `skills/` subdirectory, the catalog's own convention, when it has one), plus
 *  whatever `flow.json` beside it declares — read straight off disk, never through the catalog
 *  or zz.skill_version, neither of which a third party ever has a row in.
 *
 *  Returns null for a directory with nothing to capture — no SKILL.md and no flow.json — which
 *  `plugin_register` turns into the contract's "source could not be read" refusal rather than
 *  minting a subject with an empty component set. */
function resolveLocalDir(path: string): { components: Component[] } | null {
  if (!existsSync(path) || !statSync(path).isDirectory()) return null;
  const skillsDir = existsSync(join(path, "skills")) ? join(path, "skills") : path;
  const components: Component[] = [];
  const walk = (d: string): void => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      // Never followed: a symlink inside an allowed directory could otherwise read any file on
      // the host, which is exactly what the catalog-root confinement below refuses.
      if (f.isSymbolicLink()) continue;
      const abs = join(d, f.name);
      if (f.isDirectory()) { walk(abs); continue; }
      if (f.name !== "SKILL.md") continue;
      // The digest is the file's own bytes, not a database row: a third party carries no
      // zz.skill_version, so there is no content_hash column to defer to the way the catalog
      // path does.
      components.push({ kind: "skill", name: basename(dirname(abs)), digest: sha256(readFileSync(abs, "utf8")) });
    }
  };
  if (existsSync(skillsDir)) walk(skillsDir);

  const flowFile = join(path, "flow.json");
  if (existsSync(flowFile)) {
    const got = manifestAt(flowFile);
    if (got.manifest) {
      for (const sv of got.manifest.servers ?? []) {
        components.push({ kind: "server", name: sv.name, digest: sha256(`${sv.name}:${sv.path}`) });
      }
      components.push({
        kind: "flow", name: got.manifest.name ?? basename(path),
        digest: sha256(JSON.stringify(got.manifest)),
      });
    }
  }
  return components.length ? { components } : null;
}

/** `local_dir` is read only inside the catalog root (`CATALOG_DIR`, `ZZ_CATALOG_DIR` in a
 *  checkout). The locator is a caller's string and this runs on the platform host, so an
 *  unconfined path would let any caller digest — and learn the existence of — any directory the
 *  service can read.
 *
 *  DELIBERATE: realpath on both sides, so `..` and a symlinked prefix are judged by where they
 *  land, not by how they are spelled. */
function confinedLocalDir(locator: string): string | { error: string } {
  let root: string;
  let real: string;
  try {
    root = realpathSync(CATALOG_DIR);
    real = realpathSync(locator);
  } catch {
    return { error: "the path does not exist" };
  }
  if (real !== root && !real.startsWith(root + sep)) {
    return { error: `local_dir is read only under the catalog root (${CATALOG_DIR}); this path is outside it` };
  }
  return real;
}

/** Addresses a clone must never reach: loopback, private, carrier-grade NAT, link-local (cloud
 *  metadata lives there), benchmark, multicast and reserved space, in both families. An
 *  IPv4-mapped address arrives here already folded to its IPv4 spelling (`addressResolver`), so
 *  the IPv4 rules answer for it. */
const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) BLOCKED.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 127], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) BLOCKED.addSubnet(net, bits, "ipv6");

/** The git locator's URL, refused unless it is https to a host that resolves only to public
 *  addresses. Every address the name resolves to is checked, not the first: a resolver that
 *  answers one public and one internal address would otherwise pass half the time.
 *
 *  COUPLED: resolved through `addressResolver` (@zz/contracts), the platform's one resolver and
 *  one IPv4-mapped fold, with no cache — an answer cached here is an answer a rebinding host
 *  gets to change before git asks again. An address that is still not a valid IP after the fold
 *  (a mapped address in hex spelling) is refused rather than guessed at. */
async function publicHttpsUrl(url: string): Promise<{ error: string } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "the repository is not a URL; only https:// repositories are read" };
  }
  if (parsed.protocol !== "https:") return { error: `only https:// repositories are read, not ${parsed.protocol}` };
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = await addressResolver([host], 0)();
  if (!addresses) return { error: `the host ${host} does not resolve` };
  const internal = [...addresses].some((a) =>
    isIP(a) === 0 || BLOCKED.check(a, isIP(a) === 6 ? "ipv6" : "ipv4"));
  if (internal) {
    return { error: `the host ${host} resolves to a private, loopback or link-local address; only public hosts are read` };
  }
  return null;
}

/** `plugin_register`'s `source_kind: "git"` and `"package"` readers both shell out to a real
 *  binary (git / npm / tar) against a caller-controlled locator, so every call here goes through
 *  `tryExec`: argv arrays only, `--` ahead of the untrusted token so it can never be read as a
 *  flag, a bounded timeout and a bounded output buffer. Neither git nor npm caps how much they
 *  write to *disk*, so `directorySizeBytes` below is the actual backstop against an oversized or
 *  bombed fetch — the buffer limit only bounds what a command prints. */
const EXEC_TIMEOUT_MS = 120_000;
const MAX_EXEC_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Generous for a plugin's own skills and servers, and still a real ceiling: a shallow git clone
 *  or an npm tarball this large is almost certainly the wrong repository/package, not a slow one. */
const MAX_SOURCE_BYTES = 200 * 1024 * 1024;

type ExecResult = { ok: true; output: string } | { ok: false; error: string };

/** One external command, run the way psql.ts's own `psqlText` does: no shell, so the locator can
 *  never be interpolated into anything a shell parses, and the caller decides what "failed"
 *  means for its own contract rather than this throwing past it. */
function tryExec(cmd: string, args: string[], cwd?: string): ExecResult {
  try {
    const output = execFileSync(cmd, args, {
      cwd, encoding: "utf8", timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_EXEC_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean; signal?: string };
    const timedOut = e.killed && e.signal ? ` (killed by ${e.signal} after ${EXEC_TIMEOUT_MS}ms)` : "";
    return { ok: false, error: `${(e.stderr || e.stdout || e.message || "unknown error").trim().slice(-500)}${timedOut}` };
  }
}

/** Every git invocation carries these, ahead of the subcommand. `publicHttpsUrl` judged the URL
 *  the caller gave; these keep git itself from wandering off it — no transport but https (so no
 *  `file://`, `ext::` or ssh), no redirect to a host nobody checked, and no submodule fetch. */
const GIT_SAFE = [
  "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=never",
  "-c", "http.followRedirects=false", "-c", "submodule.recurse=false",
];
const git = (args: string[], cwd?: string) => tryExec("git", [...GIT_SAFE, ...args], cwd);

/** A temporary directory that is always removed, success or failure — `plugin_register`'s
 *  contract for `git`/`package` requires the clone/extract scratch space to be gone afterwards,
 *  whatever the outcome. */
function withTempDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The real size backstop (see the block comment above `EXEC_TIMEOUT_MS`): a recursive byte
 *  count of what git/tar actually put on disk, stopping early once it is already over `limit` —
 *  the caller only needs to know "too big", not the exact total for something it is about to
 *  refuse. Symlinks are skipped rather than followed, so a crafted entry cannot point back out
 *  of its own temporary directory and inflate — or escape — this count. */
function directorySizeBytes(dir: string, limit: number): number {
  let total = 0;
  const walk = (d: string): void => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (total > limit) return;
      if (f.isSymbolicLink()) continue;
      const abs = join(d, f.name);
      if (f.isDirectory()) { walk(abs); continue; }
      total += statSync(abs).size;
    }
  };
  walk(dir);
  return total;
}

const oversizeError = (limit: number) =>
  `the fetched source exceeds the ${Math.round(limit / (1024 * 1024))}MB size limit`;

type SourceResolution = { components: Component[]; identityExtra: Record<string, unknown> } | { error: string };

/** `source_kind: "git"`: `<url>` or `<url>#<ref>` — a branch, tag or commit. Cloned shallow
 *  (`--depth 1`) into a temporary directory, resolved exactly like `local_dir`, and the ref it
 *  actually landed on recorded as `resolved_commit` — the immutable half of FR-1's release
 *  identity for a source that itself is not immutable (a branch moves; the commit it named at
 *  capture time does not). */
async function resolveGit(locator: string): Promise<SourceResolution> {
  const hashAt = locator.lastIndexOf("#");
  const url = hashAt === -1 ? locator : locator.slice(0, hashAt);
  const ref = hashAt === -1 ? undefined : locator.slice(hashAt + 1) || undefined;
  if (!url) return { error: "no repository URL was given before '#'" };
  const refused = await publicHttpsUrl(url);
  if (refused) return refused;

  return withTempDir("zz-plugin-git-", (dir) => {
    // The fast path: a shallow clone of exactly the named branch/tag, or of the default branch
    // when no ref was given. `--` ends option parsing before the caller-controlled URL, so a
    // locator that happens to start with '-' is read as a repository name and never as a flag.
    const shallow = ref
      ? git(["clone", "--quiet", "--depth", "1", "--branch", ref, "--", url, dir])
      : git(["clone", "--quiet", "--depth", "1", "--", url, dir]);
    if (!shallow.ok) {
      if (!ref) return { error: shallow.error };
      // `--branch` only resolves refs the remote advertises (branches and tags), so a commit SHA
      // falls through to a full clone plus an explicit fetch of that one commit — still shallow
      // at the object it lands on, just not at the clone step.
      const full = git(["clone", "--quiet", "--", url, dir]);
      if (!full.ok) return { error: full.error };
      const fetch = git(["fetch", "--quiet", "--depth", "1", "--", "origin", ref], dir);
      if (!fetch.ok) return { error: `ref ${ref} could not be fetched: ${fetch.error}` };
      const checkout = git(["checkout", "--quiet", "FETCH_HEAD"], dir);
      if (!checkout.ok) return { error: checkout.error };
    }

    const size = directorySizeBytes(dir, MAX_SOURCE_BYTES);
    if (size > MAX_SOURCE_BYTES) return { error: oversizeError(MAX_SOURCE_BYTES) };

    const head = git(["rev-parse", "HEAD"], dir);
    if (!head.ok) return { error: head.error };

    const resolved = resolveLocalDir(dir);
    if (!resolved) return { error: "no SKILL.md and no flow.json were found in the cloned repository" };
    return { components: resolved.components, identityExtra: { resolved_commit: head.output.trim() } };
  });
}

/** `npm pack`'s own `--json` report for the tarball it just wrote — only the fields this reader
 *  uses, not the package's full manifest. */
interface NpmPackEntry {
  filename: string;
  integrity?: string;
  shasum?: string;
}

/** A registry spec and nothing else: `name`, `@scope/name`, either with `@<version-or-tag>`.
 *  npm also accepts a path, a tarball URL, `git+…`, `github:…` and `user/repo` in the same slot,
 *  and each of those fetches from somewhere that is not the registry — a local file, an internal
 *  URL, an unvetted clone — so the shape is checked here rather than left to npm. */
const REGISTRY_SPEC = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(@[A-Za-z0-9][A-Za-z0-9.+_-]*)?$/;

/** `source_kind: "package"`: an npm registry spec (`name@version`). Fetched with `npm pack` —
 *  never installed, so no `postinstall` script of the package's own runs — extracted into a
 *  temporary directory and resolved like `local_dir`. The tarball's own integrity hash is
 *  recorded, because a package version is otherwise mutable at the registry in a way a git
 *  commit is not: republishing the same `name@version` under `npm unpublish` + republish is rare
 *  but real, and the integrity is what makes a later locate notice it. */
function resolvePackage(spec: string): SourceResolution {
  if (!REGISTRY_SPEC.test(spec)) {
    return { error: "only a registry package spec (name or @scope/name, optionally @version) is read" };
  }
  return withTempDir("zz-plugin-package-", (dir) => {
    const pack = tryExec("npm", [
      "pack", "--json", "--pack-destination", dir, "--ignore-scripts", "--no-audit", "--no-fund", "--", spec,
    ]);
    if (!pack.ok) return { error: pack.error };

    let entries: NpmPackEntry[];
    try {
      entries = JSON.parse(pack.output) as NpmPackEntry[];
    } catch {
      return { error: "npm pack did not answer with the JSON it was asked for" };
    }
    const entry = entries[0];
    if (!entry?.filename) return { error: "npm pack produced no tarball" };

    const extracted = join(dir, "extracted");
    mkdirSync(extracted);
    // `--` here too: the tarball path is ours, not the caller's, but the rule is "argv arrays,
    // no shell interpolation of the locator" for this whole reader, applied uniformly rather
    // than only where the untrusted string happens to land.
    const untar = tryExec("tar", ["-xzf", join(dir, entry.filename), "-C", extracted]);
    if (!untar.ok) return { error: untar.error };

    const size = directorySizeBytes(extracted, MAX_SOURCE_BYTES);
    if (size > MAX_SOURCE_BYTES) return { error: oversizeError(MAX_SOURCE_BYTES) };

    // npm packs every tarball with its content under one top-level "package/" directory —
    // npm-packlist's own convention, not this platform's — resolved straight through on the rare
    // publisher whose tarball omits it.
    const root = existsSync(join(extracted, "package")) ? join(extracted, "package") : extracted;
    const resolved = resolveLocalDir(root);
    if (!resolved) return { error: "no SKILL.md and no flow.json were found in the package" };
    return {
      components: resolved.components,
      identityExtra: { tarball_integrity: entry.integrity ?? entry.shasum ?? null },
    };
  });
}

/** `plugin_register`'s three `source_kind` readers, behind one signature: `local_dir` reads the
 *  path inside the catalog root (no fetch, no temporary directory, no size limit — it is already
 *  on this host's disk); `git` and `package` fetch first and clean up after themselves whatever
 *  the outcome. Every branch returns either components to capture or the contract's own
 *  `<reason>` half of `ERROR: source <locator> could not be read: <reason>`. */
export async function resolveSource(kind: "local_dir" | "git" | "package", locator: string): Promise<SourceResolution> {
  if (kind === "local_dir") {
    const dir = confinedLocalDir(locator);
    if (typeof dir !== "string") return dir;
    const resolved = resolveLocalDir(dir);
    return resolved
      ? { components: resolved.components, identityExtra: {} }
      : { error: "no SKILL.md and no flow.json were found under this path" };
  }
  return kind === "git" ? resolveGit(locator) : resolvePackage(locator);
}
