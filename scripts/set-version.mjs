#!/usr/bin/env node
/**
 * set-version.mjs — the one place this repo's version is set.
 *
 * The version lives in every package.json. Keeping them in step by hand is a step
 * that can be half-done, and half-done is invisible: the build passes, the deploy
 * succeeds, and the wrong number ships. One input produces every location, so there is
 * no ordering to remember and no subset to get wrong.
 *
 *   node scripts/set-version.mjs 0.2.0
 *
 * The gateway's version is the one that escapes: PLATFORM_VERSION reads it at runtime
 * and it becomes the prefix of every client package (`0.2.0+<digest>`). The digest
 * covers catalog content; the prefix covers the code. Both have to move.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { manifestPaths } from "./manifests.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/set-version.mjs <version>");
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

/* THE LOCKFILE CARRIES IT NINE TIMES, and nothing was moving any of them.
 *
 * package-lock.json records a version for the root and for every workspace member, plus the
 * top-level one npm writes beside the name. This script rewrote seven manifests and the
 * compose file and left all nine behind — so the lockfile said 0.4.0 while every manifest
 * said 0.4.1, and 0.4.0 is the release that was rolled back and whose number, in the
 * changelog's own words, "can never mean anything else".
 *
 * That is exactly the failure the paragraph at the top of this file describes: "half-done is
 * invisible: the build passes, the deploy succeeds, and the wrong number ships". `npm ci`
 * tolerates the mismatch, so nothing said anything.
 *
 * Parsed rather than rewritten by hand, because a lockfile is npm's own JSON and round-trips
 * through JSON.parse/stringify byte for byte — verified on this one. The manifests above are
 * textual for the opposite reason: those are hand-edited files whose key order and comments
 * are somebody's, and reformatting them would be this script's opinion. */
const lockPath = join(repoRoot, "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
let lockMoved = 0;
const bump = (o) => { if (o && typeof o.version === "string") { if (o.version !== version) lockMoved++; o.version = version; } };
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

/* The compose file carries the version as a LITERAL, because it and the images it names
 * are one release. Someone receiving it has no way to know what to type, so they are not
 * asked — which also means this file has to move with the manifests or the bundle would
 * ship pointing at the previous images. */
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
let composed = bumped;
console.log(`  deploy/docker-compose.yml: zz-stack images -> ${version}`);

// The BLOCKS literal moves too, when a blocks version is given.
//
// The release writes ZZ_BLOCKS_VERSION into the HOST's .env, which is enough for the host
// being deployed and not enough for anyone else: the compose file is what ships in the
// bundle, and it is meant to be self-describing. Left behind, a recipient unpacks a release
// that says one thing and runs the previous block images — which is the "host on a stale
// block" this whole two-version arrangement exists to prevent, arriving through the file
// that is supposed to prevent it.
const blocksArg = process.argv.find((a) => a.startsWith("--blocks="));
if (blocksArg) {
  const blocksVersion = blocksArg.slice("--blocks=".length);
  if (!/^\d+\.\d+\.\d+/.test(blocksVersion)) {
    console.error(`error: --blocks=${blocksVersion} is not a version`);
    process.exit(1);
  }
  const withBlocks = composed.replace(
    /(\$\{ZZ_BLOCKS_IMAGE:-[^}]*\}:\$\{ZZ_BLOCKS_VERSION:-)[^}]*(\})/g,
    `$1${blocksVersion}$2`,
  );
  if (withBlocks === composed && !composed.includes(`ZZ_BLOCKS_VERSION:-${blocksVersion}}`)) {
    console.error("error: could not find the ZZ_BLOCKS_VERSION literal in deploy/docker-compose.yml");
    process.exit(1);
  }
  composed = withBlocks;
  console.log(`  deploy/docker-compose.yml: zz-blocks images -> ${blocksVersion}`);
}
writeFileSync(composePath, composed);

console.log(
  `\nAll ${MANIFESTS.length} manifests, the lockfile and the compose file at ${version} ` +
  `(${changed} manifest(s) changed).\n` +
  `Commit them together — the compose file and the lockfile ARE part of the release.`,
);
