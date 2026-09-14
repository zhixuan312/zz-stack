/**
 * LAYER 1 — does this checkout agree with itself?
 *
 * Nothing here touches a network. It is first because every later layer compares the
 * deployment against what this checkout DECLARES, and a checkout that disagrees with itself
 * makes every one of those comparisons meaningless — you would be diffing the host against a
 * claim the repository has not settled.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { root, run } from "../../deployment.ts";
import { manifestPaths } from "../../manifests.ts";
import { layer, probe } from "../run.ts";

layer("repo", "does this checkout agree with itself", ["package.json", "deploy/docker-compose.yml", "CHANGELOG.md"]);

const version = () => JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

probe("every manifest carries one version", () => {
  const seen = manifestPaths(root)
    .map((m) => [m, JSON.parse(readFileSync(join(root, m), "utf8")).version]);
  const odd = seen.filter(([, v]) => v !== seen[0][1]);
  return odd.length ? `${seen[0][0]} is ${seen[0][1]}; ${odd.map(([m, v]) => `${m} is ${v}`).join(", ")}` : null;
});

probe("the compose literal is that version", () => {
  const txt = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  const lit = (/ZZ_VERSION:-([0-9][^}]*)\}/.exec(txt) || [])[1];
  if (!lit) return "deploy/docker-compose.yml declares no ZZ_VERSION default — nothing pins the version a bare `docker compose up` would run";
  return lit === version() ? null : `manifests say ${version()}, the compose literal says ${lit}`;
});

probe("the version has a changelog section", () => {
  const txt = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  return new RegExp(`^## \\[${version().replace(/\./g, "\\.")}\\]`, "m").test(txt)
    ? null
    : `CHANGELOG.md has no "## [${version()}]" section — whatever is on this checkout ships undescribed`;
});

// THE TAG, WHICH IS THE ONLY THING THAT SAYS THIS VERSION WAS EVER RELEASED. A checkout at
// 0.26.1 with no v0.26.1 tag is either mid-release or a bump nobody finished, and the two
// look identical from inside the repository — so this reports rather than refuses.
probe("the tag for this version exists", () => {
  const tags = safe(() => run("git", ["tag", "--list", `v${version()}`], { cwd: root }));
  if (tags) return null;
  const head = safe(() => run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }));
  return `no v${version()} tag — this checkout declares a version nothing has released` +
         (head ? ` (on ${head})` : "");
});

probe("the tree is clean", () => {
  const dirty = safe(() => run("git", ["status", "--porcelain"], { cwd: root }))
    .split("\n").filter(Boolean);
  return dirty.length
    ? `${dirty.length} uncommitted change(s) — every later layer compares the host against a ` +
      `claim that is not committed anywhere: ${dirty.slice(0, 3).map((d) => d.trim()).join("; ")}` +
      (dirty.length > 3 ? " …" : "")
    : null;
});

function safe(fn: () => string, fallback = ""): string { try { return fn(); } catch { return fallback; } }
