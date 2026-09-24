/**
 * observation-walk.ts — the bounded filesystem walk a manifest capture is built from, and the only
 * place in this package that reads a directory.
 *
 * DELIBERATE: `node:fs` and `node:path` are imported in `packages/contracts`. A manifest of what a
 * piece of work wrote is a statement about the filesystem, and the alternative — a caller hands in
 * a list of paths and this module hashes them — moves the interesting failure, a file nobody
 * remembered to list, out of the record and into the caller.
 *
 * DELIBERATE: git is not consulted anywhere in this file. There is no ignore-rule parser, no
 * `.gitignore` reader and no shelling out to git. An ignored output is still an output — a
 * compiled bundle, a generated report — and a walk that asked git first would leave exactly those
 * out while reporting a full manifest. The one default exclusion is `.git` itself, which is the
 * store the outputs would be recorded in, and it is named in the record rather than assumed.
 *
 * Every bound is a function of the path, never of walk order. A cumulative budget spends itself in
 * walk order, so adding one early file pushes a later untouched file from a content hash to a
 * stamp and the comparison reports it `modified`. The hashing scheme here depends only on the
 * file's own size.
 */
import { createHash } from "node:crypto";
import { readdirSync, lstatSync, readFileSync, readlinkSync, type Stats } from "node:fs";
import { posix } from "node:path";

/**
 * Where an exclusion came from, and the reason the field exists rather than a boolean.
 *
 * `git_ignore` is representable and nothing in this module produces it. The capture computes
 * `includesIgnored` by asking whether any exclusion or recorded skip came from this source, so the
 * flag is a reduction over real data rather than a `true` somebody typed. An edit that does add
 * ignore filtering flips the flag by existing.
 */
type ExclusionSource = "declared_exclusion" | "cost_cap" | "git_ignore";

/** A directory name the walk does not descend into, with the reason it does not. Matched by exact
 *  name at any depth — there is no pattern language here, because a pattern language is how an
 *  exclusion list quietly becomes an ignore-rule engine. */
export interface ManifestExclusion {
  readonly directoryName: string;
  readonly source: ExclusionSource;
  readonly why: string;
}

/**
 * The bounds on one walk. All three are path-deterministic (see the file header).
 *
 * `contentHashBytes` is the size at or below which a file is hashed over its content. Above it the
 * entry carries a `stamp:` hash over size and modification time, which is weaker and says so: a
 * same-size edit that preserves mtime is invisible to a stamp.
 *
 * `maxFiles` and `maxDepth` are safety valves against a tree nobody meant to walk, not working
 * bounds — when either fires the record is incomplete, because a walk that stopped part way cannot
 * say what it did not reach.
 */
export interface CaptureLimits {
  readonly contentHashBytes: number;
  readonly maxDepth: number;
  readonly maxFiles: number;
}

export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = Object.freeze({
  contentHashBytes: 256 * 1024,
  maxDepth: 32,
  maxFiles: 100_000,
});

/**
 * One manifest: a stamp, the roots it covers, and path to hash for every entry found.
 *
 * The hash string names its own scheme, so a reader can never mistake a stamp for a content hash:
 *
 *   sha256:<hex>                 the file's bytes
 *   stamp:<hex>                  size and modification time, for a file above `contentHashBytes`
 *   link:<hex>                   a symbolic link's target text, that entry's whole content
 *   special:not-a-regular-file   a socket, device or pipe, which has no content to hash
 *
 * `scheme` is the digest of the terms this manifest was taken under — its roots, its bounds and
 * its exclusions. Two manifests are only comparable when it matches, and the capture refuses to
 * present a change set across a mismatch: a baseline taken with a different `contentHashBytes`
 * flips every large file between `sha256:` and `stamp:` and reports the whole tree `modified`.
 */
export interface FileManifest {
  readonly at: string;
  readonly roots: readonly string[];
  readonly scheme: string;
  readonly entries: Readonly<Record<string, string>>;
}

/** One entry the walk did not descend into, and which rule stopped it. */
interface WalkSkip {
  readonly path: string;
  readonly source: ExclusionSource;
  readonly detail: string;
}

/** One path the walk could not read, with the operating system's own reason. */
interface WalkFailure {
  readonly path: string;
  readonly why: string;
}

/**
 * What one walk found, kept separate from what a capture makes of it.
 *
 * The three loss channels mean different things to a reader: `stamped` is hash strength lost on
 * entries that are in the manifest, while `depthCapped` and `fileCapHit` are coverage lost on
 * entries that are not in it and cannot be enumerated.
 */
interface WalkResult {
  readonly entries: Record<string, string>;
  readonly skips: readonly WalkSkip[];
  readonly failures: readonly WalkFailure[];
  /** Paths carrying a `stamp:` hash rather than a content hash. */
  readonly stamped: readonly string[];
  /** Directories below the depth cap, which were not descended into. */
  readonly depthCapped: readonly string[];
  readonly fileCapHit: boolean;
  readonly filesSeen: number;
}

/** Hash one string, for the schemes that do not hash file bytes. */
function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The hash for one non-directory entry, chosen by what the entry is and how big it is — never by
 *  how much budget an earlier entry left behind. Returns null when the entry could not be read, so
 *  the caller records a failure rather than inventing a hash. */
function hashEntry(
  path: string,
  stats: Stats,
  limits: CaptureLimits,
): { readonly hash: string; readonly stamped: boolean } | null {
  try {
    if (stats.isSymbolicLink()) {
      return { hash: `link:${digestOf(readlinkSync(path))}`, stamped: false };
    }
    if (!stats.isFile()) {
      // A socket, a device or a named pipe. It is under the root, so it is named in the
      // manifest; it has no content, so the entry says that rather than implying a hash.
      return { hash: "special:not-a-regular-file", stamped: false };
    }
    if (stats.size > limits.contentHashBytes) {
      return { hash: `stamp:${digestOf(`${stats.size}:${stats.mtimeMs}`)}`, stamped: true };
    }
    return { hash: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
      stamped: false };
  } catch {
    return null;
  }
}

/** The reason text an unreadable path is recorded with. */
function reasonText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Walk the declared roots and hash everything under them.
 *
 * Deterministic order, by sorted entry name at every level, so two captures of an unchanged tree
 * produce byte-identical manifests and a safety valve fires at the same place twice.
 *
 * No symlink cycles are possible: `Dirent.isDirectory()` reports on the link itself, not its
 * target, so a symbolic link to a directory is recorded as a `link:` entry and never descended
 * into. The walk terminates on any tree, with or without the depth cap.
 *
 * Keys are `posix.join(root, relative)` with the root spelled as the caller declared it, so a root
 * of `.` yields repository-relative keys and an absolute root yields absolute ones. Two
 * overlapping roots naming the same file produce the same key and collapse to one entry.
 */
export function walkRoots(
  roots: readonly string[],
  limits: CaptureLimits,
  exclusions: readonly ManifestExclusion[],
): WalkResult {
  const entries: Record<string, string> = {};
  const skips: WalkSkip[] = [];
  const failures: WalkFailure[] = [];
  const stamped: string[] = [];
  const depthCapped: string[] = [];
  let filesSeen = 0;
  let fileCapHit = false;

  const excludedBy = new Map<string, ManifestExclusion>(
    exclusions.map((rule) => [rule.directoryName, rule]));

  const descend = (directory: string, key: string, depth: number): void => {
    if (fileCapHit) return;
    if (depth > limits.maxDepth) {
      depthCapped.push(key);
      return;
    }
    let listing;
    try {
      listing = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      failures.push({ path: key, why: reasonText(error) });
      return;
    }
    listing.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of listing) {
      if (fileCapHit) return;
      const childPath = `${directory}/${entry.name}`;
      const childKey = posix.join(key, entry.name);
      if (entry.isDirectory()) {
        const rule = excludedBy.get(entry.name);
        if (rule) {
          skips.push({ path: childKey, source: rule.source, detail: rule.why });
          continue;
        }
        descend(childPath, childKey, depth + 1);
        continue;
      }
      if (filesSeen >= limits.maxFiles) {
        fileCapHit = true;
        return;
      }
      filesSeen += 1;
      let stats: Stats;
      try {
        stats = lstatSync(childPath);
      } catch (error) {
        failures.push({ path: childKey, why: reasonText(error) });
        continue;
      }
      const hashed = hashEntry(childPath, stats, limits);
      if (!hashed) {
        failures.push({ path: childKey, why: "the entry exists but its content could not be read" });
        continue;
      }
      entries[childKey] = hashed.hash;
      if (hashed.stamped) stamped.push(childKey);
    }
  };

  for (const root of roots) {
    let stats: Stats;
    try {
      stats = lstatSync(root);
    } catch (error) {
      failures.push({ path: root, why: reasonText(error) });
      continue;
    }
    if (stats.isDirectory()) {
      descend(root, root, 0);
      continue;
    }
    // A root that names a single file is a legitimate declared root, not an error.
    filesSeen += 1;
    const hashed = hashEntry(root, stats, limits);
    if (!hashed) {
      failures.push({ path: root, why: "the root exists but its content could not be read" });
      continue;
    }
    entries[root] = hashed.hash;
    if (hashed.stamped) stamped.push(root);
  }

  return { entries, skips, failures, stamped, depthCapped, fileCapHit, filesSeen };
}
