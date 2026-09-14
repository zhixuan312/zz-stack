#!/usr/bin/env node
/**
 * release.ts — cut a release of the whole platform and deploy it, with a way back.
 *
 * TWO COMPONENTS, one release: zz-stack (this repo) and zz-stack-dashboard (the console).
 * They are two repositories with two version numbers, and this script is the only thing
 * that ships either of them.
 *
 *   node scripts/release.ts 0.2.0             # the whole thing
 *   node scripts/release.ts 0.2.0 --dry-run   # gate + build + verify locally, touch nothing remote
 *   node scripts/release.ts --preflight       # read-only: every fact about this release, changing nothing
 *   node scripts/release.ts --preflight --export   # the same, as shell `export` lines to eval
 *   node scripts/release.ts --verify-only     # probe the LIVE deployment, deploy nothing
 *   node scripts/release.ts --rollback        # back to the previously released tag
 *
 * ONE DEPLOYMENT, and `--env` is gone with the second one. There were two hosts, a `--env`
 * to choose between them, a default chosen so that forgetting was safe, and a whole tail
 * about releasing to one and then the other. None of that describes anything now: there is
 * one host, every step reads it, and a flag whose only value is the default is a flag that
 * teaches nobody anything.
 *
 * With a version: --dashboard=<v> releases the console alongside. Given none, its repo is asked
 * whether it moved: unchanged, it is skipped and told so; changed, the release STOPS until a
 * version is decided for it. There is no way to leave a moved console behind — the two are one
 * deployment in front of the same people, and the flag that used to allow it was only ever used
 * to get past a message.
 *
 * ── WHY THE ORDER IS WHAT IT IS ──────────────────────────────────────────────
 *
 * zz-stack deploys to a running server. A bad version is live for every user the moment
 * `docker compose up -d` returns — the client package is generated on demand, so the
 * next `/pkg/*.tgz` request already carries it. There is no window in which a mistake
 * sits somewhere harmless waiting to be noticed.
 *
 * So this does not end at "deployed". It ends at "deployed AND verified", and the step
 * between those two can put the deployment back where it was. Rolling back is re-pointing
 * a tag at an image that already exists — seconds, no rebuild — which is the one thing
 * that makes deploy-then-check a safe order rather than a reckless one.
 *
 *   1. gate            everything provable without touching the server
 *   2. build + smoke   build both images locally, start every service from them
 *   3. push            images to the registry, tagged with their versions
 *   4. deploy          remote pulls the tags and restarts — recording what it was on
 *   5. verify          against the LIVE deployment, not the build
 *   6. rollback        automatically, if 5 fails, then report failure
 *   7. tag             git tag last, only after 5 passes
 *
 * The git tag is created LAST because it is the PROOF of a finished release, not the
 * trigger for one. "Tagged but not deployed" cannot happen, and — since step 6 can move
 * the deployment backwards — a tag written any earlier would be a claim about what is
 * running that stopped being true.
 *
 * ── TWO VERSIONS, NOT ONE ────────────────────────────────────────────────────
 *
 * zz-stack and the console version independently. zz-stack is the platform; the console is
 * a browser client of its API, which ships to the same host in front of the same people and
 * still changes for its own reasons. (zz-blocks was a third, standing in for other teams'
 * services. It lives in its own repository now and this script no longer ships it.)
 *
 * ZZ_VERSION and ZZ_DASHBOARD_VERSION are separate keys, and either can be released
 * without the other.
 *
 * ── AND TWO COMPOSE FILES, ON PURPOSE ────────────────────────────────────────
 *
 * The console has its own compose file at its own path on the host (ZZ_DASHBOARD_PATH),
 * because folding it into zz-stack's would put a second repository's build inside this
 * repo's release. What that separation never meant was that it is exempt from being
 * released. It ships as an image like the platform itself, and the only thing on the host
 * is its compose file — and as of 2026-09-11 that is the ONLY thing on the host, because the
 * full source tree rsynced there in the old days was still sitting at 0.3.1 while 0.3.5 ran
 * from the registry.
 *
 * `deploy-sync.sh` in that repository is GONE with it. It rsynced the checkout and ran
 * `docker compose up --build` on the host, and its own comment argued that was fine for
 * "everyday iteration" — but everyday iteration against the one host people use is how
 * production stopped running published images without anybody deciding to, which is the
 * sentence that repository's own compose file opens with. There is one way the console
 * reaches the host now, and this is it.
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { buildAndSmoke } from "./release/build.ts";
import { ATTEST, fitForPurpose } from "./release/fit-for-purpose.ts";
import { DASH_IMAGE, DASH_REMOTE, DASH_SRC, HOST, IMAGE, REMOTE, asExecError, die, envToken, log, publicUrl, root, run, ssh, step, warn } from "./deployment.ts";
import { args, dryRun, preflightMode, rollbackMode, version } from "./release/config.ts";
import { consoleImage, resolveDashboard } from "./release/dashboard.ts";
import { preflight } from "./release/preflight.ts";
import { rollback } from "./release/rollback.ts";
import { verifyLive } from "./release/verify.ts";

/**
 * chain-check.ts, run against the LIVE deployment, right here rather than from
 * scripts/gate.ts.
 *
 * verifyLive()'s `doors` and `contract` layers prove a tool answers and the surface matches
 * source; neither proves a tool actually COMPLETES what it claims to. chain-check.ts writes a
 * document, approves it, closes the initiative and supersedes a knowledge node for real,
 * against this deployment — in seconds, with no model in the loop — so a tool that mounts but
 * is broken end to end fails a release here instead of surfacing as a support ticket next
 * week. It needs a running deployment and a real token, which is exactly why it is not in the
 * gate: the gate is offline and proves things about the source.
 *
 * Same three-verdict rule the doctor's own probes hold to (scripts/doctor/run.ts): a missing
 * credential is `unknown` — this checker could not look, which is not a claim about the
 * deployment — and only a run that actually happened and disagreed is `wrong`, the one a
 * release may roll back on.
 */
function chainCheck() {
  const gw = publicUrl();
  const pat = envToken();
  if (!gw || !pat) {
    return { verdict: "unknown", detail: "chain-check: no ZZ_PUBLIC_URL/ZZ_TOKEN to walk the chain with" };
  }
  try {
    run("node", [join(root, "packages/tools/dist/testing/chain-check.js")],
        { env: { ...process.env, ZZ_GATEWAY: gw, ZZ_PAT: pat } });
    return null;
  } catch (err) {
    // What chain-check itself printed, not the exception execFileSync wraps a nonzero exit
    // in — its own FAILED lines already name the tool and the rule, which is worth more than
    // this script restating "it exited 1".
    const e = asExecError(err);
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    const failing = out.split("\n").filter((l) => l.includes("FAILED:")).map((l) => l.trim());
    return { verdict: "wrong",
      detail: failing.length ? `chain-check: ${failing.join(" | ")}` : `chain-check exited nonzero: ${out.slice(-300)}` };
  }
}

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
  // "I COULD NOT LOOK" IS NOT "IT IS HEALTHY", and printing green after sixteen yellow lines is
  // the worst answer this command has: somebody asked whether their deployment is working and
  // was told yes for a question nobody managed to ask.
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

/* ── 1 · gate ─────────────────────────────────────────────────────────────── */
step(1, "gate");
const manifestVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (manifestVersion !== version) {
  die(`package.json is ${manifestVersion}, not ${version}.\n` +
      `        The bump is judgement work and belongs in a reviewed commit, not in this script.\n` +
      `        Run: node scripts/set-version.ts ${version} && git commit`);
}
// AND ITS CHANGELOG SECTION, refused here for the same reason and at the same moment.
//
// The gate below requires that the version which SHIPPED has a section of its own — so it can
// only go red AFTER the tag exists, which is exactly where 0.26.0 found it: released, tagged,
// and the gate red on the next run over a changelog still saying `[Unreleased]`. A check that
// can only fire after the mistake is a check that reports it, not one that prevents it. This
// is the same rule asked one step earlier, where the answer is still free.
if (!new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(readFileSync(join(root, "CHANGELOG.md"), "utf8"))) {
  die(`CHANGELOG.md has no "## [${version}]" section.\n` +
      `        Promote [Unreleased] to it in the same commit as the bump — the gate requires\n` +
      `        it of every shipped version, and after the tag is the wrong place to find out.`);
}
try {
  execFileSync("node", [join(root, "scripts/gate.ts")], { cwd: root, stdio: "inherit" });
} catch { die("gate did not pass"); }

/* ── 1a · fit-for-purpose review ──────────────────────────────────────────── */
// The gate proves a plugin DECLARES a purpose. Whether its tool surface DELIVERS that purpose
// is a judgement, so this step prints both sides and refuses to go on until somebody says they
// read them. See scripts/release/fit-for-purpose.ts for why it stops rather than warns.
step("1a", "fit-for-purpose review");
fitForPurpose(args.includes(ATTEST));

// RELEASE FROM master, NOT FROM A RELEASE BRANCH.
//
// There IS a release branch, and it is not this guard's business. The version bump, the
// changelog and the rest of a release's judgement work are done on `release/<version>` and
// merged to master; this script then proves that what it is about to ship is what was
// actually merged. Two rules, not one, and they do not conflict: work on the branch,
// release from master.
//
// This comment used to say the opposite — "there is deliberately no release branch" — while
// the /release command drew the branch in a diagram three lines wide. Two documents, each
// authoritative-sounding, saying opposite things about the same procedure. The 0.1.0 release
// followed the script's version and never opened a branch. (That command now lives one level
// up, in the parent checkout, because it releases all three repositories and not just this one.)
//
// The guard matters more here than in a package registry. Releasing IS deploying: a
// release cut from a feature branch puts unmerged, unreviewed code in front of every user
// at once, with no step in between where anyone would notice.
const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
if (branch !== "master" && !dryRun) {
  die(`on branch "${branch}" — releases come from master.\n` +
      `        Releasing here would deploy unmerged code to everyone. Merge first, then release.`);
}

const dirty = run("git", ["status", "--porcelain"], { cwd: root });
if (dirty && !dryRun) die(`working tree is dirty — release from a committed tree:\n${dirty}`);

// The local branch must also match the remote: a release deploys what the HOST pulls from
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

// ONE VERSION REACHES TWO DEPLOYMENTS, and this guard has to know that.
//
// It used to refuse any existing tag, which is the exact opposite of what step 7's tagOnce
// was written to allow: the documented sequence is `0.21.2` to UAT and then `0.21.2
// --env=prod`, and the UAT run cuts the tag. So the second command — the one that ships to
// every real user — died in preflight, before it had done anything, on a tag its own release
// had just written. The fix went into step 7 and never came back here, so the script
// contradicted its own docstring and the way out looked like "bump the version", which would
// have put a number on production that names no UAT release.
//
// Same rule as tagOnce, for the same reason: a tag at THIS commit is the expected case; a tag
// at a different commit means one number would name two pieces of code, and that is refused.
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

// THE VERIFICATION CREDENTIAL IS CHECKED BEFORE THE DEPLOY, NOT BY IT.
//
// Without this the missing token is discovered in step 5, which is after production is
// already live — and it does not present as "I could not check". It presents as every MCP
// door returning 401, which is indistinguishable from the release having taken the platform
// down, and the script's own advice at that point is to roll back. That is how a good
// release nearly got reverted on the strength of a credential this laptop was missing.
// A TOKEN THAT IS NOT SHAPED LIKE A TOKEN FAILS AS AN OUTAGE, so it is refused as a typo.
//
// The whitespace test is the one that matters and it is the one that was missing: a value
// carrying its own trailing comment is still a non-empty string, so a presence check passes
// it, and the first thing that notices is three MCP doors answering 401 after production is
// already live. Checked here it is one sentence naming the variable.
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

// THE CONSOLE HAS ITS OWN SUITE AND IT IS NOT THIS ONE. zz-stack's gate cannot see a second
// repository, so a console released on a green zz-stack gate would be released on no evidence
// at all. Run its own before building it, and read each exit code separately — separately,
// because a suite whose exit code is read through a pipe reports the pipe's.
//
// pnpm, because that is what the console is: it declares `packageManager: pnpm` and carries a
// pnpm lockfile. zz-stack is an npm workspace and stays one — two repositories, two package
// managers, and using this repo's out of habit would run the other one's scripts against a
// tree npm never installed.
if (dashVersion) {
  // GATE INCLUDED, AND IT WAS NOT. The console has a gate of its own — its header says why:
  // seven bugs in one afternoon, every one found by the stakeholder, every one a screen
  // asserting something the data does not say, and a type checker cannot see any of them. It
  // was neither an npm script nor a release step, so nothing ran it, and it sat RED: a
  // settings table rendered its headers over nothing for a person who is on no team.
  //
  // Three checks that pass and a fourth nobody runs is the same arrangement this repository
  // found twice more this week, in check:redaction and check:scope.
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

/* ── 2 · build the images and prove they answer ───────────────────────────── */
const bundle = buildAndSmoke({ dash, dashVersion });

if (dryRun) {
  // The VERSION file is put back by the exit handler registered where it was written, so a
  // rehearsal that dies anywhere after that point cleans up too. Running it twice is the
  // same as running it once.
  log(`\n\x1b[32m  DRY RUN OK\x1b[0m — gate green, every image builds, the platform's start, catalog present.`);
  log(`  Nothing was pushed, deployed, tagged or committed.`);
  process.exit(0);
}
/* ── 3 · push ─────────────────────────────────────────────────────────────── */
step(3, "push images");
// Only what this release BUILT. An already-published component was never rebuilt, so there
// is nothing here to push and pushing would only move a tag somebody has already pulled.
// The host's pull list in step 4 is the other one, and it names all of them.
for (const ref of [`${IMAGE}:${version}`,
                   ...(dashVersion && !dash.alreadyPublished ? [`${DASH_IMAGE}:${dashVersion}`] : [])]) {
  try { run("docker", ["push", ref], { stdio: ["ignore", "pipe", "pipe"] }); }
  catch (err) {
    // `?? String(err)`, not `?? e.message` — the original read `err.stderr ?? err`, and
    // stringifying the whole error (rather than just its .message) is what kept the
    // constructor name in this one fallback line.
    die(`push ${ref} failed — is "docker login ghcr.io" done?\n${(asExecError(err).stderr ?? String(err)).slice(-300)}`);
  }
  log(`  pushed ${ref}`);
}

/* ── 4 · deploy, recording what it was on ─────────────────────────────────── */
step(4, "deploy");
const previous = ssh(`cd ${REMOTE}/deploy && grep -oP '(?<=^ZZ_VERSION=).*' .env || echo ''`);
log(`  host is currently on ${previous || "(unset)"}`);
run("git", ["push", "origin", "HEAD"], { cwd: root });

// PULL FIRST, and pull only OUR images. Two separate reasons, one change.
//
// `docker compose pull` fetches every image in the file, and the front end used to be
// ghcr.io/open-webui/open-webui:main — a rolling tag. So every platform release also
// upgraded it to whatever main happened to be that day, and `up -d` then recreated it. That
// is an unversioned change to the interface people actually work in, riding along with a
// release that never mentions it, and nothing in verification or the changelog would have
// attributed the breakage.
//
// Every image in the compose file is pinned today — postgres included — so no rolling tag is
// currently reachable this way. The rule stays because
// pinning is a property of that file and this is a property of the release: naming what it
// pulls means a tag loosened there cannot start riding along here unannounced.
//
// And it runs BEFORE .env is written. The 0.1.0 release failed here on an arm64 image, by
// which point .env already said ZZ_VERSION=0.1.0 while the containers still ran 0.2.0 — so
// the retry read "0.1.0" as the outgoing version and recorded a ZZ_PREVIOUS_VERSION equal
// to the release. --rollback became a no-op that would have reported success. The file now
// describes the deployment only once the images it names are actually on the host.
const refs = [`${IMAGE}:${version}`,
              ...(dashVersion ? [`${DASH_IMAGE}:${dashVersion}`] : [])];
/* HOW THIS RELEASE'S deploy/ FILES REACH THE HOST — the bundle, and only the bundle.
 *
 * There were two ways and the host decided which: a checkout got `git reset --hard
 * origin/master`, a plain directory got the bundle. That branch existed because a host could
 * become a checkout — `deploy/sync.sh` rsynced this working tree onto one and built the
 * images there. That script is gone (2026-09-11), so nothing makes a host a checkout any
 * more, and a branch nothing can take is a branch nobody maintains.
 *
 * The bundle is not the fallback. It is the artifact this script already builds for the
 * install path that has "no repository, no toolchain, no build", it carries exactly the files
 * a host needs AT THIS VERSION, and it is the only thing that works on a host that has never
 * seen this repository — which is every new host, by design. `mkdir -p` makes this the whole
 * provisioning step too: a directory that does not exist yet is the normal case, not an
 * error.
 *
 * Unpacking it over deploy/ leaves `.env` alone, because `.env` is the host's own and the
 * bundle carries `.env.example`. A host that happens to have a `.git` is unaffected: it gets
 * the same bundle as everyone else, which is the point of there being one path. */
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
  // Record the outgoing version BEFORE switching, so --rollback works even if this
  // process dies. A rollback target held only in this script's memory is no target.
  `grep -q '^ZZ_PREVIOUS_VERSION=' .env && sed -i 's/^ZZ_PREVIOUS_VERSION=.*/ZZ_PREVIOUS_VERSION=${previous}/' .env || echo 'ZZ_PREVIOUS_VERSION=${previous}' >> .env; ` +
  `grep -q '^ZZ_VERSION=' .env && sed -i 's/^ZZ_VERSION=.*/ZZ_VERSION=${version}/' .env || echo 'ZZ_VERSION=${version}' >> .env; ` +
  // NOTHING TO RESTART BEHIND THIS, and that is worth a sentence because it used to be the
  // most expensive line in the file. A front end held long-lived MCP connections to zz-core
  // and cred-proxy, `up -d` left it alone because neither its image nor its config had
  // moved, and it spent the rest of its life on transports pointing at containers that had
  // been replaced underneath it — twice, both times behind a completely green release. The
  // doors are stateless now (packages/mcp-http) and there is no front end on this host, so
  // a client reconnects by making its next request and nothing here has to remember to
  // bounce anything.
  `docker compose up -d --remove-orphans >/tmp/zz-up.log 2>&1 || { echo "UP FAILED"; tail -8 /tmp/zz-up.log; exit 1; }; ` +
  `tail -4 /tmp/zz-up.log`,
);
log(`  deployed ${version}`);

if (dashVersion) {
  // The console's entire deployment is ONE FILE and ONE IMAGE. There is no checkout on the
  // host and there should not be: the compose file is the only thing the container reads, so
  // a clone there would exist to be `git reset --hard`-ed by a step that resets nothing.
  // Copying the committed file is also what makes the version literal on the host the one
  // that was reviewed, rather than whatever a person last edited in place.
  //
  // This runs AFTER the platform is up. The console is a client of the gateway, so bringing
  // it up first would point a new console at an old API for the length of a pull.
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
      // Recorded BEFORE the switch, for the same reason the platform's is: a rollback target
      // held only in this process's memory is no target once this process dies.
      `{ grep -q '^ZZ_DASHBOARD_PREVIOUS_VERSION=' .env && sed -i 's/^ZZ_DASHBOARD_PREVIOUS_VERSION=.*/ZZ_DASHBOARD_PREVIOUS_VERSION=${prevDash}/' .env || echo 'ZZ_DASHBOARD_PREVIOUS_VERSION=${prevDash}' >> .env; } && ` +
      `{ grep -q '^ZZ_DASHBOARD_VERSION=' .env && sed -i 's/^ZZ_DASHBOARD_VERSION=.*/ZZ_DASHBOARD_VERSION=${dashVersion}/' .env || echo 'ZZ_DASHBOARD_VERSION=${dashVersion}' >> .env; } && ` +
      `{ docker compose up -d --remove-orphans >/tmp/zz-dash-up.log 2>&1 || ` +
      `{ echo "CONSOLE UP FAILED"; tail -8 /tmp/zz-dash-up.log; exit 1; }; }; tail -3 /tmp/zz-dash-up.log`);
  log(`  console deployed ${dashVersion}`);
} else {
  // THE CONSOLE DID NOT MOVE IN THIS RELEASE, so there is nothing to roll it back TO — and a
  // previous version left behind by the last release that DID move it reads exactly like one
  // recorded now. Left in place, a platform-only release that fails verification rolls the
  // console back to a version this release never touched, and the next --verify-only passes
  // because the host now DECLARES what it was rolled back to. Clear it instead: rollback then
  // takes its "nothing recorded — left alone" branch, which is the true answer.
  //
  // ZZ_DASHBOARD_VERSION is deliberately NOT cleared. It says what should be running, which is
  // still true, and it is what verification checks against.
  ssh(`test -f ${DASH_REMOTE}/.env && sed -i '/^ZZ_DASHBOARD_PREVIOUS_VERSION=/d' ${DASH_REMOTE}/.env || true`);
}

// THE HOST'S SCHEDULE IS PART OF THE RELEASE, and nothing was updating it.
//
// A release replaces the checkout with `git reset --hard`, so a scheduled command whose file
// this version deletes stops working the moment it lands. That is not hypothetical: the
// TypeScript port removed deploy/collect-turns.py, production's crontab still ran
// `python3 collect-turns.py` hourly, and install-backup-cron.sh had been updated to write
// `zz-tool collect-turns` — with nothing to run it. The turn collector would have begun
// failing into a log at the moment of deploy, silently, which is exactly how the nightly
// backup came to be broken for four nights.
//
// The installer is idempotent by construction — it replaces only its own tagged lines — and
// it asserts the count it wrote, so running it every release is safe.
//
// NOT FATAL, and this is why. It was an unguarded `ssh(...)`, so a host whose cron said `no
// crontab for root` — a fresh host, the ordinary first install — threw a raw Node stack
// trace HERE: after the deploy had succeeded, before verification had run and before
// anything was tagged. That leaves the release live, unverified and unnamed, which is a
// strictly worse place to stand than a missing cron line. Same reasoning the whole file
// uses: the stack is up and correct at this point, and a scheduled job that did not
// reinstall is a bad night for one job, while an aborted release is a bad day for
// everything. It is loud instead, and it names the command to run by hand.
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

// THE REGISTRY LEARNS WHAT THIS RELEASE SHIPS, and until now nothing told it.
//
// zz.skill_version is what every question about a skill joins against: which version wrote
// this document, which rubric judged it, what it scored. register-skills mirrors the catalog
// into it — and it was a day-2 command nobody ran, so the registry sat at whatever the last
// person to remember had put there. On this deployment that was 2026-08-22: ops-spec had been
// edited and released and the registry still said 1.0, so all 61 spec.md documents were
// credited to the version before the change and the change could not be measured at all.
// That is the improvement loop's own instrument reading the wrong dial.
//
// It runs HERE because a release is exactly when the catalog changes, and it runs FROM HERE
// because `zz-tool register-skills` cannot: zz-tool executes inside the image, the tool's
// default psql is `docker compose exec`, and there is no docker inside that container. The
// command has therefore never once succeeded where it was documented to be run.
//
// Idempotent: it upserts on (skill, version) and reports what it changed. A skill whose
// bytes did not move produces no row.
const regPsql = `ssh ${HOST} docker compose -f ${REMOTE}/deploy/docker-compose.yml exec -T postgres psql -U zz -d zz`;
try {
  const out = run("node", ["packages/tools/dist/ops/register-skills.js",
                           "--root", ".", "--psql", regPsql]);
  const moved = (out.match(/^\s+(flow_step|block_usage)\s/gm) ?? []).length;
  log(`  registry updated from the catalog — ${moved} skill row(s) touched`);
} catch (e) {
  // Loud, not fatal. The platform serves correctly with a stale registry; what breaks is the
  // ability to tell one version's work from another's, which is a reporting failure and not
  // an outage — and rolling a good deployment back over it would be the worse trade.
  log(`  WARNING: register-skills failed, so the registry still describes the PREVIOUS ` +
      `catalog. Evaluation and attribution will credit work to the wrong version until it ` +
      `is run: ${String(e).slice(0, 200)}`);
}

// And the PLUGIN registry, immediately after, because its membership rows resolve against the
// skill versions the step above just wrote. Run it first and every member is unresolved.
//
// zz.plugin_version is what an evaluation's subject IS. Without these rows plugin_locate reads
// an empty table and the flow fails at its first stage, complaining about a plugin that plainly
// exists — which is a confusing enough failure to be worth one line of ordering.
try {
  const out = run("node", ["packages/tools/dist/ops/register-plugins.js",
                           "--root", ".", "--psql", regPsql]);
  // UNRESOLVED IS NOT A STATISTIC, AND PRINTING IT AS ONE IS HOW 0.33.0 SHIPPED A REGISTRY
  // DESCRIBING 0.32.3. This read `— 27 member(s) unresolved` appended to a success line, in the
  // grammar of a count, so it looked like a property of the data rather than a defect. Zero is
  // the only correct value: a member is a skill version this lock names, and every one of them
  // was written by register-skills two steps earlier. Any other number means the lock is
  // describing a catalog that is not the one being released.
  const unresolved = Number(/members UNRESOLVED (\d+)/.exec(out)?.[1] ?? 0);
  if (unresolved) {
    log(`  \x1b[33mWARNING: ${unresolved} plugin member(s) UNRESOLVED — plugins.lock.json is ` +
        `describing a different catalog than the one being released, so zz.plugin_version now ` +
        `holds the PREVIOUS release's versions. Run \`node scripts/plugin-versions.ts ` +
        `--write\`, commit it, then re-run register-plugins. Nothing about the deployment is ` +
        `wrong; what is wrong is which version its work will be attributed to.\x1b[0m`);
  } else {
    log("  plugin registry updated from plugins.lock.json");
  }
} catch (e) {
  // Loud, not fatal, for the same reason as the step above: a stale plugin registry costs the
  // ability to evaluate this release, which is a reporting failure. Rolling a good deployment
  // back over it would be the worse trade.
  log(`  WARNING: register-plugins failed, so no plugin VERSION row exists for this release. ` +
      `zz-plugin-eval will not find a subject until it is run: ${String(e).slice(0, 200)}`);
}

/* ── 5 · verify the LIVE deployment ───────────────────────────────────────── */
step(5, "verify");
execSync("sleep 12");
const verdict = verifyLive();
const problems = verdict.wrong;

// The tool CHAIN, not only the door and the surface — see chainCheck()'s own docstring.
const chained = chainCheck();
if (chained?.verdict === "wrong") problems.push(chained.detail);
if (chained?.verdict === "unknown") verdict.unknown.push(chained.detail);

/* ── 5a · deployed, and nothing could look at it ───────────────────────────
 * THE THIRD OUTCOME, and the release could not produce it until 0.26.1 needed it.
 *
 * Rolling back on a probe that could not run undoes a release for a reason that was never
 * about the release — that is what put a healthy 0.26.1 back to 0.26.0. But the fix for that
 * cannot be to carry on to the tag, because a tag is this repository's claim that a version
 * was verified, and nothing verified this one. So: neither. The new version stays live, it is
 * NOT tagged, and the operator is told exactly which probes could not look and what to run
 * when they can. */
if (!problems.length && verdict.unknown.length) {
  log(`\n\x1b[33m  ${verdict.unknown.length} probe(s) could not run:\x1b[0m`);
  verdict.unknown.forEach((u) => log(`    - ${u}`));
  die(`${version} is LIVE on ${HOST} and could not be verified. It is not rolled back — ` +
      `nothing here says it is broken — and it is NOT TAGGED, because nothing here says it ` +
      `works either.\n        Run: node scripts/release.ts --verify-only  (once the probes ` +
      `can reach what they ask about)\n        Or:  node scripts/release.ts --rollback`);
}

/* ── 6 · roll back if verification failed ─────────────────────────────────── */
if (problems.length) {
  log(`\n\x1b[31m  ${problems.length} verification failure(s)\x1b[0m`);
  // A failed rollback must not eat the failure it was rolling back FROM.
  //
  // rollback() throws when the remote `docker compose up` cannot start the old version —
  // a pruned image is the obvious way — and both calls to it were unguarded. So the worst
  // case this script has, a bad version live AND the rollback failing, produced a raw
  // stack trace: no list of what failed verification, no statement of what is running, at
  // the one moment an operator needs both. The rollback is what makes deploy-then-verify
  // safe rather than reckless, and its own failure was the least legible outcome here.
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
      // same command the script would have run, or it leaves behind whatever the failed
      // version defined and this one does not.
      log("  then `docker compose up -d --remove-orphans`. The failures are listed below.");
    }
  } else {
    rolledBack = false;
    log(`  \x1b[33mNo previous version recorded — cannot roll back automatically.\x1b[0m`);
  }
  // `rolledBack`, not `previous`. This said "was rolled back to X" whenever a previous
  // version was RECORDED, which is a different claim from the rollback having worked.
  die(`release ${version} was deployed, failed verification, and ${rolledBack ? `was rolled back to ${previous}` : "is STILL LIVE"}:\n` +
      problems.map((p) => `        - ${p}`).join("\n"));
}

/* ── 7 · tag, last ────────────────────────────────────────────────────────── */
step(7, "tag");

/* ONE VERSION REACHES TWO DEPLOYMENTS, so the tag has to survive being asked for twice.
 *
 * The intended path is now UAT first and production after: `--env=uat 0.19.0`, then
 * `--env=prod 0.19.0`. The first cuts v0.19.0. The second would have died on "tag already
 * exists" — AFTER production was deployed and verified, so the release would have reported
 * failure for a deployment that worked, and the operator's next move would have been to
 * decide what to do about a live production nobody had told them was fine.
 *
 * What the tag claims is "this commit is released", and the second run makes that claim
 * about the same commit. So an existing tag at THIS commit is the expected case and is left
 * alone. An existing tag at a DIFFERENT commit is the dangerous one — the same number
 * naming two pieces of code — and that is refused rather than moved, because a tag people
 * have already pulled is not ours to redefine. */
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

// EVERY COMMIT REACHES ORIGIN BEFORE ANY TAG IS CUT.
//
// These pushes used to sit beside their own repo's tag, which reads fine until tagOnce
// REFUSES. It refuses by dying, and it dies on the first repo — so a refusal in zz-stack
// left the console's commits on this laptop only, while its image was
// already deployed and verified. "What is production running?" would then have had no
// answer in git for two of three repositories.
//
// The tag is what has to be last, because it is the proof the release finished. Pushing the
// commit is not: the commit is already deployed by this point, and a commit on origin that
// nothing has tagged yet is exactly what a half-finished release should look like.
if (dashVersion) run("git", ["push", "origin", "HEAD"], { cwd: DASH_SRC });

// Same rule for all three: the tag is what the NEXT release measures "has it changed?"
// against, so it is written only once this one is known to have worked.
tagOnce(root, `v${version}`, `zz-stack ${version}\n\ndeployed and verified on ${HOST} from ${commit}`, "zz-stack");
if (dashVersion) {
  tagOnce(DASH_SRC, `v${dashVersion}`, `zz-stack-dashboard ${dashVersion}\n\ndeployed and verified on ${HOST}`, "zz-stack-dashboard");
}

log(`\n\x1b[32m  RELEASED ${version} to ${HOST}\x1b[0m  (from ${commit}, previous ${previous || "none"})`);
log(`  Roll back with: node scripts/release.ts --rollback`);
