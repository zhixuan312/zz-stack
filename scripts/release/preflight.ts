
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DASH_IMAGE, DASH_SRC, HOST, REMOTE, catalogOwnerTeam, envToken, initFrame, log, probeToken, publicUrl, root, run, ssh } from "../deployment.ts";
import { exportMode } from "./config.ts";
import { consoleImage, resolveDashboard } from "./dashboard.ts";
import { verifyPredeploy } from "./verify.ts";

export function preflight(): void {
  function safe<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { return fallback; } }
  const git = (a: string[], cwd: string = root): string => safe(() => run("git", a, { cwd }), "");
  const out: string[] = [];
  const say = (s: string): void => { if (!exportMode) log(s); };
  const row = (ok: boolean | null, label: string, detail: string | null = null): void =>
    say(`  ${ok === null ? "·" : ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${detail ? ` — ${detail}` : ""}`);

  // Which deployment, first and always. Half the rows below are read off a host over ssh, so a
  // preflight that does not say which host it asked is a page of facts about somewhere.
  say(`\n\x1b[1m── preflight · what is a fact about this release\x1b[0m` +
      `  \x1b[1m${HOST}\x1b[0m`);

  /* Versions on disk */
  const pkg = safe(() => JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "?");
  const composeTxt = safe(() => readFileSync(join(root, "deploy/docker-compose.yml"), "utf8"), "");
  const composeVer = (/ZZ_VERSION:-([0-9][^}]*)\}/.exec(composeTxt) || [])[1] || "?";
  say("\n  versions on disk");
  row(pkg === composeVer, `manifests ${pkg}, compose literal ${composeVer}`,
      pkg === composeVer ? null : "they must move together — run set-version.ts");
  const dashPkg = safe(() => JSON.parse(readFileSync(join(DASH_SRC, "package.json"), "utf8")).version, "?");
  const dashComposeTxt = safe(() => readFileSync(join(DASH_SRC, "docker-compose.yml"), "utf8"), "");
  const dashComposeVer = (/ZZ_DASHBOARD_VERSION:-([0-9][^}]*)\}/.exec(dashComposeTxt) || [])[1] || "?";
  row(dashPkg === dashComposeVer, `console package.json ${dashPkg}, its compose literal ${dashComposeVer}`,
      dashPkg === dashComposeVer ? null
        : "they must move together — the release bumps both, so a disagreement here is a hand edit");

  /* The tree, checked now rather than by the gate after the changelog */
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean);
  safe(() => run("git", ["fetch", "origin", "--quiet"], { cwd: root }), "");
  const behind = git(["rev-list", "--count", "HEAD..origin/master"]) || "0";
  const ahead = git(["rev-list", "--count", "origin/master..HEAD"]) || "0";
  say("\n  tree");
  row(null, `on ${branch}`, branch === "master" ? "release runs from master" : "bump and commit here, then merge to master");
  row(dirty.length === 0, dirty.length ? `${dirty.length} uncommitted change(s)` : "clean",
      dirty.length ? dirty.slice(0, 4).map((x) => x.trim()).join("; ") + (dirty.length > 4 ? " …" : "") : null);
  row(behind === "0", `master vs origin: ${ahead} ahead, ${behind} behind`,
      behind === "0" ? null : "the HOST pulls from origin — push before releasing");

  /* What moved */
  const tag = git(["describe", "--tags", "--abbrev=0"]);
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const commits = tag ? git(["rev-list", range]).split("\n").filter(Boolean) : [];
  say("\n  what moved");
  row(null, `zz-stack: ${commits.length} commit(s) since ${tag || "(no tag)"}`);
  const d = resolveDashboard();
  row(d.blocked ? false : null, `console: ${d.why}`,
      null);
  // How this host takes its deploy/ files. UAT is not a checkout, so `git reset --hard
  // origin/master` is not universal. Nothing here decides anything — it reports which of the two
  // paths this host is on.
  const checkout = safe(() => ssh(`test -d ${REMOTE}/.git && echo yes || echo no`).trim(), "");
  row(checkout ? null : false,
      checkout === "yes" ? `${HOST}:${REMOTE} is a checkout — deploy/ comes from origin/master`
        : checkout === "no" ? `${HOST}:${REMOTE} is not a checkout — deploy/ comes from the release bundle`
        : `could not ask ${HOST} how it takes deploy/`,
      checkout ? null : "the deploy step needs to reach it");

  const liveDash = safe(() => consoleImage(), "");
  const published = liveDash.startsWith(`${DASH_IMAGE}:`);
  row(published, `console live on ${HOST}: ${liveDash || "(nothing running)"}`,
      published ? null
        : d.release ? "not a published image — this release replaces it and records no rollback target"
                    : "not a published image, and this release does not replace it");

  /* What the range declares as breaking — a floor, never a ceiling. A closed enum, a write path
   * that begins enforcing its guards and a changed default model each break something without
   * saying so. This says where to start reading. */
  const breaking = [];
  for (const c of commits) {
    const body = git(["log", "-1", "--format=%b", c]);
    const line = body.split("\n").find((l) => /^\*{0,2}breaking/i.test(l.trim()));
    if (line) breaking.push(`${git(["log", "-1", "--format=%h %s", c])}\n        ${line.trim()}`);
  }
  say("\n  declared breaking (a FLOOR — read the diff for the rest)");
  if (breaking.length) breaking.forEach((x) => say(`    ${x}`));
  else say("    none declared — which is not the same as none present");

  /* Can this machine actually finish? */
  say("\n  this machine");
  const dockerUp = safe(() => { run("docker", ["info"]); return true; }, false);
  row(dockerUp, "docker running", dockerUp ? null : "start Docker — the build needs it");
  const ghcr = safe(() => readFileSync(join(process.env.HOME ?? "", ".docker/config.json"), "utf8"), "").includes("ghcr.io");
  row(ghcr, "ghcr.io login present", ghcr ? null : "docker login ghcr.io (a token with write:packages)");

  /* The address, read from the deployment rather than asked of a person. No default: a fork must
   * not inherit an address it would then hand its own bearer token to.
   *
   * COUPLED: through `publicUrl`, the same resolver the rest of the release uses. A second copy
   * of the environment variable and the ssh grep could report an address the release would not
   * then use. */
  const address = safe(() => publicUrl({ quiet: true }), "");
  const fromHost = !!address && !(process.env.ZZ_PUBLIC_URL || "").trim();
  row(!!address, `ZZ_PUBLIC_URL ${address || "(unresolved)"}`,
      address ? (fromHost ? `read from ${HOST}:${REMOTE}/deploy/.env` : "from the environment")
              : `could not reach ${HOST} — set it by hand`);
  if (address) out.push(`export ZZ_PUBLIC_URL=${address}`);

  /* The team register-plugins writes as every catalog plugin's owner. COUPLED: through
   * `catalogOwnerTeam`, the resolver release.ts refuses on before it builds anything. */
  const owner = safe(() => catalogOwnerTeam({ quiet: true }), "");
  row(!!owner, `ZZ_CATALOG_OWNER_TEAM ${owner || "(unresolved)"}`,
      owner ? null : `not in the environment, ${root}/.env or ${HOST}:${REMOTE}/deploy/.env — the release refuses without it`);

  /* The token is the one input the release never validated before spending a whole
   * gate-build-push-deploy cycle on it.
   *
   * COUPLED: through `envToken`, which is what the release itself reads. Reading
   * `process.env.ZZ_TOKEN` with a file fallback answers a different question, and reports "no
   * token found" for a ZZ_TOKEN in this repository's own .env that the release uses happily. */
  const src = process.env.ZZ_TOKEN ? "$ZZ_TOKEN" : `${root}/.env`;
  const tok = envToken();
  if (!tok) {
    row(false, `token (${src})`, "no token found — the live checks cannot run");
  } else if (!address) {
    row(null, `token (${src})`, "present, but unverified without an address");
  } else {
    const code = safe(() => run("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "25",
      "-H", `Authorization: Bearer ${tok}`, "-H", "content-type: application/json",
      "-H", "accept: application/json, text/event-stream",
      "-d", initFrame("preflight"),
      `${address}/core/mcp`]), "000");
    row(code === "200", `token (${src}) authenticates against ${address}`,
        code === "200" ? null
          : `http ${code} — this token is not valid for this deployment. Mint one on the ` +
            `host with issue-first-pat.sh and set it as ZZ_TOKEN in ${root}/.env.`);
  }

  /* The live chain walks with a superadmin's token, because part of it is offered to no other
   * role. Asked by listing /core/mcp's tools: a superadmin is offered knowledge_reindex, and a
   * token that is not would skip those probes and leave the release UNVERIFIED after the deploy.
   * COUPLED: chain-verdict.ts chainToken and chainOutcome report the same absences as unknown. */
  const probe = probeToken();
  const probeSrc = process.env.ZZ_PROBE_TOKEN ? "$ZZ_PROBE_TOKEN" : `${root}/.env`;
  if (!probe) {
    row(false, `probe token (${probeSrc})`, "no ZZ_PROBE_TOKEN — the live chain check's superadmin " +
        "probes will report unknown and the release will go live UNTAGGED; set it to a superadmin's PAT");
  } else if (!address) {
    row(null, `probe token (${probeSrc})`, "present, but unverified without an address");
  } else {
    const listed = safe(() => run("curl", ["-s", "-m", "25",
      "-H", `Authorization: Bearer ${probe}`, "-H", "content-type: application/json",
      "-H", "accept: application/json, text/event-stream",
      "-d", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), `${address}/core/mcp`]), "");
    const sup = listed.includes('"knowledge_reindex"');
    row(sup, `probe token (${probeSrc}) is a superadmin's on ${address}`,
        sup ? null : "it is not offered knowledge_reindex — invalid here, or not a superadmin's. " +
                     "The chain check would skip its superadmin probes.");
  }

  /* What step 5 would roll back on that is already true today: the doctor's pre-deploy probes,
   * this checkout against the live data. The release refuses on these before it deploys. */
  say("\n  pre-deploy probes (this checkout against live data)");
  const pre = safe(() => verifyPredeploy({ quiet: true }), { wrong: [], unknown: ["the probes themselves threw"] });
  for (const w of pre.wrong) row(false, w);
  for (const u of pre.unknown) row(false, `could not run: ${u}`);
  if (!pre.wrong.length && !pre.unknown.length) row(true, "every pre-deploy probe agrees");

  if (exportMode) { out.forEach((l) => console.log(l)); return; }
  say("\n  Nothing above was changed, pushed or deployed. The version is still yours to decide.\n");
}
