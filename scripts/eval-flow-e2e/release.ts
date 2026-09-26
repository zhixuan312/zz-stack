/**
 * The repository-side half of IMPROVE and PROMOTE/VERIFY: the candidate patch an agent composes,
 * and the two commands a release through `zz-tool release-apply`/`release-rollback` is handed.
 *
 * The patch is composed the way the IMPROVE skill says — by hand, as a unified diff, against the
 * base subject's own release — in a clone of the throwaway origin at the release tag, with the
 * repository's own lock and marketplace regeneration run after the edit, because the gate a
 * candidate is validated by refuses a skill edit whose locks were not regenerated.
 *
 * The release command is the stand-in for the repository's real release procedure: bump the
 * version, regenerate, commit on top of the candidate's branch (never a squash), tag, push to the
 * bare origin, and register what it published with the same two registry tools a real release
 * runs (scripts/release/registries.ts). The rollback command restores nothing — there is no
 * deployment behind the throwaway origin — and only confirms the version it is asked to restore
 * exists, which is what the CLI's own post-rollback check then reads back from the registry.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { live, sh, spawnAsync, TEAM, type Stack } from "./stack.ts";

/** The version the stand-in release publishes: the base's patch number, plus one. */
export const nextVersion = (v: string): string => v.replace(/(\d+)$/, (n) => String(Number(n) + 1));

/** The one skill the candidate edits, and the line it adds — the change a `plugin`-owned finding
 *  about refusals that do not say what to do next asks for. */
const SKILL = "skills/zz-platform/SKILL.md";

/** The candidate's one change: the sentence the defect EXPLAIN recorded asks zz-platform to say. */
export const WORDING = "A refusal names its way out: make the call it names next, never the refused call again.";

export function candidatePatch(stack: Stack): string {
  const dir = join(stack.work, "candidate");
  sh("git", ["clone", "-q", "--branch", `v${stack.version}`, stack.origin, dir]);
  execFileSync("cp", ["-R", join(stack.seed, "node_modules"), join(dir, "node_modules")]);
  const path = join(dir, SKILL);
  const before = readFileSync(path, "utf8");
  const bumped = before.replace(/^version: (\d+)\.(\d+)$/m, (_m, a: string, b: string) => `version: ${a}.${Number(b) + 1}`);
  if (bumped === before) throw new Error(`${SKILL} carries no version: line to bump`);
  // Added to an existing line, not as new ones: zz-platform sits near the repository's 700-line
  // ceiling, and a candidate the gate refuses for size is invalid before it is ever released.
  const anchor = "silence is not an override.\n";
  if (!bumped.includes(anchor)) throw new Error(`${SKILL} no longer has the line the candidate extends`);
  writeFileSync(path, bumped.replace(anchor, `silence is not an override. ${WORDING}\n`));
  sh("npm", ["run", "--silent", "build"], dir);
  sh("node", ["scripts/skill-versions.ts", "--write"], dir);
  sh("node", ["scripts/plugin-versions.ts", "--write"], dir);
  sh("node", ["scripts/build-marketplace.ts"], dir);
  return `${sh("git", ["diff"], dir)}\n`;
}

/** The release and rollback commands, written as scripts under the stack's own directory; each
 *  returns the command line the CLI flag takes. The gate is the CLI's own default. */
export function releaseCommands(stack: Stack): { release: string; rollback: string; version: string } {
  const version = nextVersion(stack.version);
  const psql = stack.psql;
  const release = join(stack.work, "release.sh");
  writeFileSync(release, [
    "#!/bin/sh", "set -e",
    `node scripts/set-version.ts ${version}`,
    "npm run --silent build",
    "node scripts/skill-versions.ts --write",
    "node scripts/plugin-versions.ts --write",
    "node scripts/build-marketplace.ts",
    "git add -A",
    `git -c user.name=eval-flow -c user.email=release@local commit -q -m "zz-stack ${version}"`,
    `git tag v${version}`,
    `git push -q origin HEAD:refs/heads/release-${version} v${version}`,
    `ZZ_CATALOG_OWNER_TEAM=${TEAM} node ${live}/packages/tools/dist/ops/register-skills.js --root . --psql "${psql}"`,
    `ZZ_CATALOG_OWNER_TEAM=${TEAM} node ${live}/packages/tools/dist/ops/register-plugins.js --root . --psql "${psql}"`,
  ].join("\n") + "\n", { mode: 0o755 });
  const rollback = join(stack.work, "rollback.sh");
  // A catalog plugin's current version is the one the deployment runs, so restoring the prior
  // release means deploying it again, as the operator would; the CLI hands ZZ_URL and ZZ_TOKEN on.
  writeFileSync(rollback, [
    "#!/bin/sh", "set -e",
    'echo "restoring v$1"',
    'git rev-parse -q --verify "refs/tags/v$1" >/dev/null',
    `node ${join(live, "scripts", "eval-flow-e2e", "redeploy.ts")} "${stack.seed}" "${stack.prefix}" "$1"`,
  ].join("\n") + "\n", { mode: 0o755 });
  return { release: `sh ${release}`, rollback: `sh ${rollback} {version}`, version };
}

/** A throwaway clone of the origin, the `--repo` both CLIs are pointed at — never the primary
 *  checkout. The console sibling the gate resolves is the stack's own symlink beside it. */
export function releaseClone(stack: Stack): string {
  const dir = join(stack.work, "release-clone");
  sh("git", ["clone", "-q", stack.origin, dir]);
  sh("git", ["fetch", "-q", "--tags", "origin"], dir);
  return dir;
}

export function tagCommit(stack: Stack, tag: string): string {
  return sh("git", ["rev-parse", `${tag}^{commit}`], stack.seed);
}

export function runCli(stack: Stack, script: string, args: string[]): Promise<{ code: number; out: string }> {
  return spawnAsync("npm", ["run", "--silent", script, "--", ...args], {
    cwd: live, timeoutMs: 1_800_000, env: { ...process.env, ZZ_URL: stack.url, ZZ_TOKEN: stack.pat },
  });
}
