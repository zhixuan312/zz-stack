#!/usr/bin/env node
/**
 * release.ts — cut a release of the whole platform and deploy it, with a way back.
 *
 * Two components, one release: zz-stack (this repo) and zz-stack-dashboard (the console).
 * Two repositories, two version numbers, and this script is the only thing that ships either.
 *
 *   node scripts/release.ts 0.2.0             # the whole thing
 *   node scripts/release.ts 0.2.0 --dry-run   # gate + build + verify locally, touch nothing remote
 *   node scripts/release.ts --preflight       # read-only: every fact about this release, changing nothing
 *   node scripts/release.ts --preflight --export   # the same, as shell `export` lines to eval
 *   node scripts/release.ts --verify-only     # probe the live deployment, deploy nothing
 *   node scripts/release.ts --rollback        # back to the previously released tag
 *
 * One deployment, read from the host by every step.
 *
 * --dashboard=<v> releases the console alongside. Given none, its repo is asked whether it
 * moved: unchanged, it is skipped and told so; changed, the release stops until a version is
 * decided for it. There is no flag that leaves a moved console behind.
 *
 * A bad version is live for every user the moment `docker compose up -d` returns. Rolling back
 * is re-pointing a tag at an image that already exists: seconds, no rebuild.
 *
 *   1. gate            everything provable without touching the server
 *   2. build + smoke   build both images locally, start every service from them
 *   3. push            images to the registry, tagged with their versions
 *   4. deploy          remote pulls the tags and restarts — recording what it was on
 *   5. verify          against the live deployment, not the build
 *   6. rollback        automatically, if 5 fails, then report failure
 *   7. tag             git tag last, only after 5 passes
 *
 * DELIBERATE: the git tag is created last. It is the proof of a finished release, so
 * "tagged but not deployed" cannot happen, and step 6 can move the deployment backwards.
 *
 * ZZ_VERSION and ZZ_DASHBOARD_VERSION are separate keys; either can be released without the
 * other. The console has its own compose file at its own path on the host
 * (ZZ_DASHBOARD_PATH), and that compose file is the only thing of the console's on the host —
 * it ships as an image like the platform itself.
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { buildAndSmoke } from "./release/build.ts";
import { ATTEST, fitForPurpose } from "./release/fit-for-purpose.ts";
import { DASH_IMAGE, DASH_REMOTE, DASH_SRC, HOST, IMAGE, REMOTE, asExecError, catalogOwnerTeam, die, envToken, log, probeToken, publicUrl, root, run, ssh, step, warn } from "./deployment.ts";
import { chainCheck } from "./release/chain-live.ts";
import { args, dryRun, preflightMode, rollbackMode, version } from "./release/config.ts";
import { consoleImage, resolveDashboard } from "./release/dashboard.ts";
import { preflight } from "./release/preflight.ts";
import { writeRegistries } from "./release/registries.ts";
import { rollback } from "./release/rollback.ts";
import { verifyLive, verifyPredeploy } from "./release/verify.ts";

if (preflightMode) { preflight(); process.exit(0); }

if (args.includes("--verify-only")) {
  step("✓", "verifying the live deployment");
  const live = ssh(`cd ${REMOTE}/deploy && grep -oP '(?<=^ZZ_VERSION=).*' .env || echo ''`);
  log(`  host ZZ_VERSION=${live || "(unset — compose literal applies)"}`);
  const found = verifyLive();
  const chained = chainCheck();
  if (chained?.verdict === "wrong") found.wrong.push(chained.detail);
  if (chained?.verdict === "unknown") found.unknown.push(chained.detail);
  if (found.wrong.length) {
    die(`${found.wrong.length} check(s) failed:\n` + found.wrong.map((x) => `        - ${x}`).join("\n"));
  }
  // A probe that could not run is not a pass: green is printed only when every probe ran.
  if (found.unknown.length) {
    die(`${found.unknown.length} probe(s) could not run, so this deployment is UNVERIFIED — ` +
        `not unhealthy, and not healthy either:\n` +
        found.unknown.map((x) => `        - ${x}`).join("\n"));
  }
  log("\n\x1b[32m  LIVE DEPLOYMENT HEALTHY\x1b[0m");
  process.exit(0);
}

if (rollbackMode) {
  const prev = ssh(`cd ${REMOTE}/deploy && grep -oP '(?<=^ZZ_PREVIOUS_VERSION=).*' .env || true`);
  if (!prev) die("no ZZ_PREVIOUS_VERSION recorded on the host — nothing to roll back to");
  rollback(prev);
  log("\n  Rolled back. Verify with: node scripts/release.ts --verify-only");
  process.exit(0);
}

if (!version) die("usage: node scripts/release.ts <version> [--dry-run]  |  --rollback");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) die(`"${version}" is not a semver version`);

/* 1 · gate */
step(1, "gate");
const manifestVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (manifestVersion !== version) {
  die(`package.json is ${manifestVersion}, not ${version}.\n` +
      `        The bump is judgement work and belongs in a reviewed commit, not in this script.\n` +
      `        Run: node scripts/set-version.ts ${version} && git commit`);
}
// The changelog section is refused here too. COUPLED: scripts/gate/checks/suites.ts requires
// that the version which shipped has a section of its own, and that can only go red after the
// tag exists; asked here, the answer is still free.
if (!new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(readFileSync(join(root, "CHANGELOG.md"), "utf8"))) {
  die(`CHANGELOG.md has no "## [${version}]" section.\n` +
      `        Promote [Unreleased] to it in the same commit as the bump — the gate requires\n` +
      `        it of every shipped version, and after the tag is the wrong place to find out.`);
}
try {
  execFileSync("node", [join(root, "scripts/gate.ts")], { cwd: root, stdio: "inherit" });
} catch { die("gate did not pass"); }

/* 1a · fit-for-purpose review */
// The gate proves a plugin declares a purpose. Whether its tool surface delivers that purpose
// is a judgement, so this step prints both sides and refuses to go on until somebody attests.
step("1a", "fit-for-purpose review");
fitForPurpose(args.includes(ATTEST));

// DELIBERATE: a release runs from master, although the version bump and the changelog are
// done on `release/<version>`. Work on the branch, release from what was merged. Releasing is
// deploying, so a release cut from a feature branch would put unmerged, unreviewed code in
// front of every user at once.
const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
if (branch !== "master" && !dryRun) {
  die(`on branch "${branch}" — releases come from master.\n` +
      `        Releasing here would deploy unmerged code to everyone. Merge first, then release.`);
}

const dirty = run("git", ["status", "--porcelain"], { cwd: root });
if (dirty && !dryRun) die(`working tree is dirty — release from a committed tree:\n${dirty}`);

// The local branch must also match the remote: a release deploys what the host pulls from
// origin, so anything committed locally and not pushed would be tagged as released and
// never actually shipped.
if (!dryRun) {
  run("git", ["fetch", "-q", "origin"], { cwd: root });
  const ahead = run("git", ["rev-list", "--count", "origin/master..HEAD"], { cwd: root });
  const behind = run("git", ["rev-list", "--count", "HEAD..origin/master"], { cwd: root });
  if (behind !== "0") {
    die(`local master is ${behind} commit(s) behind origin — pull before releasing`);
  }
  if (ahead !== "0") log(`  ${ahead} commit(s) to push`);
}

// DELIBERATE: a v<version> tag already at this commit is accepted — the same code released
// again. A tag at a different commit is refused: one number would name two pieces of code.
// COUPLED: `tagOnce` in step 7 applies the same rule; change both.
const tagAt = (() => {
  try { return run("git", ["rev-parse", `v${version}^{commit}`], { cwd: root }); } catch { return null; }
})();
if (tagAt && !dryRun) {
  const head = run("git", ["rev-parse", "HEAD"], { cwd: root });
  if (tagAt !== head) {
    die(`tag v${version} already exists and points at ${tagAt.slice(0, 7)}, not this tree's ` +
        `${head.slice(0, 7)} — bump to a new version rather than letting one number name two ` +
        `different pieces of code.`);
  }
  log(`  v${version} is already tagged at this commit — releasing the same code again`);
}

// The verification credential is checked before the deploy, not by it. A missing or malformed
// token discovered in step 5 presents as every MCP door returning 401, which is
// indistinguishable from the release having taken the platform down. The whitespace test is
// the one that matters: a value carrying its own trailing `# comment` in .env is still a
// non-empty string, so a presence check passes it.
if (!dryRun && envToken() && !/^zzp_\S+$/.test(envToken())) {
  const t = envToken();
  die(`the release token is not shaped like one: ${t.length} characters` +
      `${/\s/.test(t) ? ", and it contains whitespace — a trailing `# comment` in .env is " +
        "part of the value unless you strip it" : ""}.\n` +
      `        Fix ZZ_TOKEN in ${root}/.env.`);
}
if (!dryRun && !envToken()) {
  die(`no token to verify the deployment with.\n` +
      `        Set ZZ_TOKEN in ${root}/.env (or inline).\n` +
      `        Checked before deploying on purpose: discovered afterwards, a missing token ` +
      `looks exactly like a dead deployment.`);
}

// The probe token is asked, never required. Absent, the live chain still runs with ZZ_TOKEN and
// its superadmin probes come back `unknown: no probe token` in step 5 — which leaves the release
// live and UNTAGGED — so it is said here, before anything is built, where it can still be set.
if (!dryRun && !probeToken()) {
  warn("  no ZZ_PROBE_TOKEN: the live chain check's superadmin probes (bug_list, bug_resolve,\n" +
       "  knowledge_reindex) will report unknown, and step 5 will leave this release UNTAGGED.\n" +
       `  Set ZZ_PROBE_TOKEN in ${root}/.env to a superadmin's PAT to verify them.`);
}

// The team register-plugins writes as every catalog plugin's owner, resolved before anything is
// built: discovered after the deploy, its absence fails step 5 and rolls a working release back.
const ownerTeam = catalogOwnerTeam();
if (!ownerTeam) {
  die(`no ZZ_CATALOG_OWNER_TEAM — not in the environment, ${root}/.env or ${HOST}:${REMOTE}/deploy/.env.\n` +
      "        register-plugins writes it as every catalog plugin's owner and release_owners, and " +
      "refuses to run without it.");
}

// The doctor's pre-deploy probes: disagreements already true of the live data against this
// checkout, which step 5 would otherwise roll back on after a deploy (0.76.0). A probe that could
// not read the host stops here too — step 5 would then leave the release live and untagged.
if (!dryRun) {
  step("1b", "pre-deploy probes");
  const pre = verifyPredeploy();
  if (pre.wrong.length || pre.unknown.length) {
    die("the pre-deploy probes disagree with, or could not read, the live data — nothing was " +
        "built or deployed:\n" + [...pre.wrong, ...pre.unknown].map((x) => `        - ${x}`).join("\n"));
  }
}

const commit = run("git", ["rev-parse", "--short", "HEAD"], { cwd: root });
log(`  releasing zz-stack ${version} to ${HOST} from ${commit}`);

const dash = resolveDashboard();
if (dash.blocked) {
  if (dash.since) {
    log(`\n  the console has changed and is not in this release:`);
    for (const c of dash.since.slice(0, 8)) log(`    ${c}`);
  }
  die(`zz-stack-dashboard ${dash.why}.\n` +
      `        It ships to the same host, in front of the same people. Leaving it behind is a\n` +
      `        choice, not a default.\n` +
      `        Add --dashboard=<version>. The console cannot be left behind when it has moved:\n` +
      `        it and the platform are one deployment in front of the same people.`);
}
const dashVersion = dash.release ? (dash.version ?? null) : null;
log(`  console:   ${dashVersion ? `releasing ${dashVersion} (${dash.why})` : `skipped — ${dash.why}`}`);

// The console has its own suite and it is not this one: zz-stack's gate cannot see a second
// repository. Each exit code is read separately — a suite whose exit code goes through a pipe
// reports the pipe's.
//
// pnpm, because the console declares `packageManager: pnpm` and carries a pnpm lockfile.
// zz-stack is an npm workspace.
if (dashVersion) {
  for (const script of ["typecheck", "lint", "test", "gate"]) {
    try {
      run("pnpm", ["run", script], { cwd: DASH_SRC });
      log(`  console ${script}: passed`);
    } catch {
      die(`the console's \`npm run ${script}\` failed. Its suite is the only thing standing\n` +
          `        between a console change and every person who opens the platform — fix it\n` +
          `        rather than releasing past it.`);
    }
  }
}

/* 2 · build the images and prove they answer */
const bundle = buildAndSmoke({ dash, dashVersion });

if (dryRun) {
  // The VERSION file is put back by the exit handler registered where it was written, so a
  // rehearsal that dies after that point still cleans up. Running it twice is idempotent.
  log(`\n\x1b[32m  DRY RUN OK\x1b[0m — gate green, every image builds, the platform's start, catalog present.`);
  log(`  Nothing was pushed, deployed, tagged or committed.`);
  process.exit(0);
}
/* 3 · push */
step(3, "push images");
// Only what this release built. An already-published component was never rebuilt, so pushing
// would only move a tag somebody has already pulled. Step 4's pull list names all of them.
for (const ref of [`${IMAGE}:${version}`,
                   ...(dashVersion && !dash.alreadyPublished ? [`${DASH_IMAGE}:${dashVersion}`] : [])]) {
  try { run("docker", ["push", ref], { stdio: ["ignore", "pipe", "pipe"] }); }
  catch (err) {
    // `?? String(err)`, not `?? e.message` — stringifying the whole error keeps the
    // constructor name in this fallback line.
    die(`push ${ref} failed — is "docker login ghcr.io" done?\n${(asExecError(err).stderr ?? String(err)).slice(-300)}`);
  }
  log(`  pushed ${ref}`);
}

/* 4 · deploy, recording what it was on */
step(4, "deploy");
const previous = ssh(`cd ${REMOTE}/deploy && grep -oP '(?<=^ZZ_VERSION=).*' .env || echo ''`);
log(`  host is currently on ${previous || "(unset)"}`);
run("git", ["push", "origin", "HEAD"], { cwd: root });

// Pull only this release's own images. `docker compose pull` would fetch every image in the
// file, so a tag loosened there could start riding along with a release that never mentions it.
//
// DELIBERATE: the pull runs before .env is written. A pull that fails once .env already says
// ZZ_VERSION=<new> makes the retry read the new version as the outgoing one and record a
// ZZ_PREVIOUS_VERSION equal to the release, turning --rollback into a no-op that reports
// success.
const refs = [`${IMAGE}:${version}`,
              ...(dashVersion ? [`${DASH_IMAGE}:${dashVersion}`] : [])];
/* This release's deploy/ files reach the host as the bundle, and only the bundle. It carries
 * exactly the files a host needs at this version and is the only thing that works on a host
 * that has never seen this repository. `mkdir -p` makes this the provisioning step too: a
 * directory that does not exist yet is the normal case.
 *
 * Unpacking it over deploy/ leaves `.env` alone — `.env` is the host's own and the bundle
 * carries `.env.example`. */
ssh(`mkdir -p ${REMOTE}/deploy`);
run("scp", ["-o", "ConnectTimeout=30", join(root, bundle), `${HOST}:/tmp/${basename(bundle)}`]);
ssh(`tar xzf /tmp/${basename(bundle)} -C ${REMOTE}/deploy && rm -f /tmp/${basename(bundle)}`);
log(`  ${HOST}:${REMOTE}/deploy unpacked from ${basename(bundle)}`);
ssh(refs.map((r) => `{ docker pull -q ${r} >/tmp/zz-pull.log 2>&1 || ` +
                    `{ echo "PULL ${r} FAILED — is 'docker login ghcr.io' done on this host?"; ` +
                    `tail -5 /tmp/zz-pull.log; exit 1; }; }`).join(" && "));
log(`  pulled ${refs.join(", ")}`);

ssh(
  `cd ${REMOTE}/deploy && ` +
  // Record the outgoing version before switching, so --rollback works even if this
  // process dies. A rollback target held only in this script's memory is no target.
  `grep -q '^ZZ_PREVIOUS_VERSION=' .env && sed -i 's/^ZZ_PREVIOUS_VERSION=.*/ZZ_PREVIOUS_VERSION=${previous}/' .env || echo 'ZZ_PREVIOUS_VERSION=${previous}' >> .env; ` +
  `grep -q '^ZZ_VERSION=' .env && sed -i 's/^ZZ_VERSION=.*/ZZ_VERSION=${version}/' .env || echo 'ZZ_VERSION=${version}' >> .env; ` +
  // Nothing to restart behind this: the doors are stateless (packages/mcp-http) and there is
  // no front end on this host, so a client reconnects by making its next request.
  `docker compose up -d --remove-orphans >/tmp/zz-up.log 2>&1 || { echo "UP FAILED"; tail -8 /tmp/zz-up.log; exit 1; }; ` +
  `tail -4 /tmp/zz-up.log`,
);
log(`  deployed ${version}`);

if (dashVersion) {
  // The console's deployment is one file and one image — no checkout on the host. Copying the
  // committed compose file makes the version literal on the host the reviewed one.
  //
  // DELIBERATE: this runs after the platform is up. The console is a client of the gateway, so
  // bringing it up first would point a new console at an old API for the length of a pull.
  const prevImage = consoleImage();
  const prevDash = prevImage.includes(":") ? prevImage.split(":").pop() : "";
  log(`  console host is currently on ${prevImage || "(nothing running)"}`);
  ssh(`mkdir -p ${DASH_REMOTE}`);
  run("scp", ["-o", "ConnectTimeout=30", join(DASH_SRC, "docker-compose.yml"),
              `${HOST}:${DASH_REMOTE}/docker-compose.yml`]);
  ssh(`cd ${DASH_REMOTE} && ` +
      `{ docker pull -q ${DASH_IMAGE}:${dashVersion} >/tmp/zz-dash-pull.log 2>&1 || ` +
      `{ echo "PULL ${DASH_IMAGE}:${dashVersion} FAILED — is 'docker login ghcr.io' done on this host?"; ` +
      `tail -5 /tmp/zz-dash-pull.log; exit 1; }; } && ` +
      `touch .env && ` +
      // Recorded before the switch: a rollback target held only in this process's memory is
      // no target once this process dies.
      `{ grep -q '^ZZ_DASHBOARD_PREVIOUS_VERSION=' .env && sed -i 's/^ZZ_DASHBOARD_PREVIOUS_VERSION=.*/ZZ_DASHBOARD_PREVIOUS_VERSION=${prevDash}/' .env || echo 'ZZ_DASHBOARD_PREVIOUS_VERSION=${prevDash}' >> .env; } && ` +
      `{ grep -q '^ZZ_DASHBOARD_VERSION=' .env && sed -i 's/^ZZ_DASHBOARD_VERSION=.*/ZZ_DASHBOARD_VERSION=${dashVersion}/' .env || echo 'ZZ_DASHBOARD_VERSION=${dashVersion}' >> .env; } && ` +
      `{ docker compose up -d --remove-orphans >/tmp/zz-dash-up.log 2>&1 || ` +
      `{ echo "CONSOLE UP FAILED"; tail -8 /tmp/zz-dash-up.log; exit 1; }; }; tail -3 /tmp/zz-dash-up.log`);
  log(`  console deployed ${dashVersion}`);
} else {
  // The console did not move in this release, so ZZ_DASHBOARD_PREVIOUS_VERSION is cleared: a
  // value left by an earlier release reads as one recorded now, and rollback would put the
  // console back to a version this release never touched. Cleared, rollback takes its
  // "nothing recorded — left alone" branch.
  //
  // DELIBERATE: ZZ_DASHBOARD_VERSION is not cleared. It says what should be running, which is
  // still true, and it is what verification checks against.
  ssh(`test -f ${DASH_REMOTE}/.env && sed -i '/^ZZ_DASHBOARD_PREVIOUS_VERSION=/d' ${DASH_REMOTE}/.env || true`);
}

// The host's schedule is part of the release: a scheduled command whose file this version
// deletes stops working the moment it lands. The installer replaces only its own tagged lines
// and asserts the count it wrote, so running it every release is safe.
//
// DELIBERATE: a failure here is loud, not fatal. A fresh host whose cron says `no crontab for
// root` would otherwise abort the run after the deploy had succeeded and before verification
// ran, leaving the release live, unverified and untagged.
try {
  ssh(`cd ${REMOTE} && ./deploy/install-backup-cron.sh`);
  log("  scheduled jobs reinstalled from this version");
} catch (err) {
  const e = asExecError(err);
  warn("  scheduled-job install FAILED — the stack is deployed and correct, but the nightly\n" +
       "  backup and the turn collector may still be on the previous version's commands.\n" +
       `  Run it by hand and read why:\n    ssh ${HOST} 'cd ${REMOTE} && ./deploy/install-backup-cron.sh'\n` +
       `  ${(e.stderr ?? e.message).trim().split("\n")[0]}`);
}

const registryFailures = writeRegistries(ownerTeam);

/* 5 · verify the live deployment */
step(5, "verify");
execSync("sleep 12");
const verdict = verifyLive();
// A registry the release could not write is a failed verification (registries.ts).
const problems = [...verdict.wrong, ...registryFailures];

// The tool chain, not only the door and the surface — see chainCheck()'s own docstring.
const chained = chainCheck();
if (chained?.verdict === "wrong") problems.push(chained.detail);
if (chained?.verdict === "unknown") verdict.unknown.push(chained.detail);

/* 5a · deployed, and nothing could look at it */
// A probe that could not run is neither a reason to roll back nor a reason to tag. The new
// version stays live, it is not tagged, and the operator is told which probes could not look.
if (!problems.length && verdict.unknown.length) {
  log(`\n\x1b[33m  ${verdict.unknown.length} probe(s) could not run:\x1b[0m`);
  verdict.unknown.forEach((u) => log(`    - ${u}`));
  die(`${version} is LIVE on ${HOST} and could not be verified. It is not rolled back — ` +
      `nothing here says it is broken — and it is NOT TAGGED, because nothing here says it ` +
      `works either.\n        Run: node scripts/release.ts --verify-only  (once the probes ` +
      `can reach what they ask about)\n        Or:  node scripts/release.ts --rollback`);
}

/* 6 · roll back if verification failed */
if (problems.length) {
  log(`\n\x1b[31m  ${problems.length} verification failure(s)\x1b[0m`);
  // DELIBERATE: rollback() is guarded. It throws when the remote `docker compose up` cannot
  // start the old version, and an unguarded throw would replace the list of verification
  // failures and the statement of what is running with a stack trace.
  let rolledBack = true;
  if (previous) {
    try {
      rollback(previous);
      execSync("sleep 10");
      const back = run("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "20", `${publicUrl()}/health`]);
      log(`  post-rollback /health: http ${back}`);
    } catch (err) {
      rolledBack = false;
      const e = asExecError(err);
      log(`\n\x1b[31m  ROLLBACK FAILED — ${version} IS STILL LIVE ON ${HOST}\x1b[0m`);
      log(`  ${(e.stderr ?? e.message).trim().slice(-400)}`);
      log(`  Fix the host by hand: cd ${REMOTE}/deploy, set ZZ_VERSION=${previous} in .env,`);
      // --remove-orphans, like every other deploy here: the hand instruction has to be the
      // command the script would have run.
      log("  then `docker compose up -d --remove-orphans`. The failures are listed below.");
    }
  } else {
    rolledBack = false;
    log(`  \x1b[33mNo previous version recorded — cannot roll back automatically.\x1b[0m`);
  }
  // `rolledBack`, not `previous`: a recorded previous version is a different claim from the
  // rollback having worked.
  die(`release ${version} was deployed, failed verification, and ${rolledBack ? `was rolled back to ${previous}` : "is STILL LIVE"}:\n` +
      problems.map((p) => `        - ${p}`).join("\n"));
}

/* 7 · tag, last */
step(7, "tag");

/* DELIBERATE: a tag already at this commit is left alone — the tag claims "this commit is
 * released", and a second run makes the same claim about the same commit. A tag at a different
 * commit is refused rather than moved: one number would name two pieces of code, and a tag
 * people have already pulled is not ours to redefine.
 * COUPLED: the preflight tag guard in step 1 applies the same rule. */
const tagOnce = (repo: string, name: string, message: string, label: string): void => {
  const at = (() => { try { return run("git", ["rev-parse", `${name}^{commit}`], { cwd: repo }); } catch { return null; } })();
  const head = run("git", ["rev-parse", "HEAD"], { cwd: repo });
  if (at === head) { log(`  ${label} ${name} already at this commit — left as it is`); return; }
  if (at) {
    die(`${label} ${name} already exists and points at ${at.slice(0, 7)}, not this release's ` +
        `${head.slice(0, 7)}. The same version number would name two different pieces of code.\n` +
        `        THE DEPLOYMENT IS LIVE AND VERIFIED — this is a tagging problem, not a bad ` +
        `deployment. Do not roll back on account of it.`);
  }
  run("git", ["tag", "-a", name, "-m", message], { cwd: repo });
  run("git", ["push", "origin", name], { cwd: repo });
  log(`  tagged ${label} ${name}`);
};

// Every commit reaches origin before any tag is cut. tagOnce refuses by dying, and it dies on
// the first repo, so a push sitting beside its own repo's tag would leave the console's commits
// on this laptop while its image was already deployed and verified.
//
// Only the tag has to be last: the commit is already deployed by this point.
if (dashVersion) run("git", ["push", "origin", "HEAD"], { cwd: DASH_SRC });

// Same rule for both: the tag is what the next release measures "has it changed?" against, so
// it is written only once this one is known to have worked.
tagOnce(root, `v${version}`, `zz-stack ${version}\n\ndeployed and verified on ${HOST} from ${commit}`, "zz-stack");
if (dashVersion) {
  tagOnce(DASH_SRC, `v${dashVersion}`, `zz-stack-dashboard ${dashVersion}\n\ndeployed and verified on ${HOST}`, "zz-stack-dashboard");
}

log(`\n\x1b[32m  RELEASED ${version} to ${HOST}\x1b[0m  (from ${commit}, previous ${previous || "none"})`);
log(`  Roll back with: node scripts/release.ts --rollback`);
