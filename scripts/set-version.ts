#!/usr/bin/env node
/**
 * set-version.ts — the one place this repo's version is set.
 *
 * The version lives in every package.json. Keeping them in step by hand is a step that can be
 * half-done, and half-done is invisible: the build passes, the deploy succeeds, and the wrong
 * number ships. One input produces every location.
 *
 *   node scripts/set-version.ts 0.2.0
 *
 * The gateway's version is the one that escapes: PLATFORM_VERSION reads it at runtime and it
 * becomes the prefix of every client package (`0.2.0+<digest>`). The digest covers catalog
 * content; the prefix covers the code. Both have to move.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { manifestPaths } from "./manifests.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/set-version.ts <version>");
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`error: "${version}" is not a semver version`);
  process.exit(2);
}

const MANIFESTS = manifestPaths(repoRoot);

let changed = 0;
for (const rel of MANIFESTS) {
  const path = join(repoRoot, rel);
  const raw = readFileSync(path, "utf8");
  const current = JSON.parse(raw).version;
  // Rewrite the version line textually so key order, indentation and the trailing
  // newline survive untouched — JSON.stringify would reformat the whole file.
  const next = raw.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`);
  if (JSON.parse(next).version !== version) {
    console.error(`error: failed to set version in ${rel}`);
    process.exit(1);
  }
  if (next !== raw) changed++;
  writeFileSync(path, next);
  console.log(`  ${rel}: ${current} -> ${version}`);
}

/* The lockfile carries the version many times: package-lock.json records one for the root and for
 * every workspace member, plus the top-level one npm writes beside the name. `npm ci` tolerates a
 * mismatch with the manifests, so nothing says anything when they drift.
 *
 * Parsed rather than rewritten by hand, because a lockfile is npm's own JSON and round-trips
 * through JSON.parse/stringify byte for byte. The manifests above are textual for the opposite
 * reason: they are hand-edited files whose key order is somebody's, and reformatting them would be
 * this script's opinion. */
/** The two fields this script touches in npm's lockfile — the root version, and each workspace
 *  member's own entry under `packages`, which carries its own `version`. */
interface LockFile {
  version?: string;
  packages?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}
const lockPath = join(repoRoot, "package-lock.json");
const lock: LockFile = JSON.parse(readFileSync(lockPath, "utf8"));
let lockMoved = 0;
const bump = (o: Record<string, unknown>) => { if (o && typeof o.version === "string") { if (o.version !== version) lockMoved++; o.version = version; } };
bump(lock);
for (const [where, entry] of Object.entries(lock.packages ?? {})) {
  // Workspace members only: the root (""), and the directories the manifests above name.
  // A `node_modules/...` entry is a dependency's own version and is not ours to move.
  if (where.startsWith("node_modules/")) continue;
  if (where !== "" && !MANIFESTS.includes(`${where}/package.json`)) continue;
  bump(entry);
}
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`  package-lock.json: ${lockMoved} version(s) -> ${version}`);

/* The compose file carries the version as a literal, because it and the images it names are one
 * release. It has to move with the manifests or the bundle ships pointing at the previous
 * images. */
const composePath = join(repoRoot, "deploy/docker-compose.yml");
const compose = readFileSync(composePath, "utf8");
const bumped = compose.replace(
  /(\$\{ZZ_IMAGE:-[^}]*\}:\$\{ZZ_VERSION:-)[^}]*(\})/g,
  `$1${version}$2`,
);
if (bumped === compose && !compose.includes(`ZZ_VERSION:-${version}}`)) {
  console.error("error: could not find the ZZ_VERSION literal in deploy/docker-compose.yml");
  process.exit(1);
}
console.log(`  deploy/docker-compose.yml: zz-stack images -> ${version}`);

writeFileSync(composePath, bumped);

console.log(
  `\nAll ${MANIFESTS.length} manifests, the lockfile and the compose file at ${version} ` +
  `(${changed} manifest(s) changed).\n` +
  `Commit them together — the compose file and the lockfile ARE part of the release.`,
);
