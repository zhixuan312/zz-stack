
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DASH_IMAGE, DASH_REMOTE, HOST, REMOTE, die, log, root, ssh, step } from "../deployment.mjs";
import { consoleImage } from "./dashboard.mjs";

/** DDL that cannot be undone by putting the old image back.
 *
 * A dropped column is gone; the previous release's code still SELECTs it, and every request
 * that resolves an identity then answers 500. That is not a theory — it happened on 0.34.0:
 * migration 053 dropped `pat.scope`, verification failed for an unrelated reason, this
 * function put 0.33.1 back, and PAT authentication returned "identity resolution failed" for
 * every caller on the platform while `/health` stayed green, because /health resolves nobody.
 *
 * The whole argument for deploying before verifying is that this step can undo it. For a
 * release carrying destructive DDL that argument is simply false, and the honest thing is to
 * say so and stop rather than to perform a rollback that makes the outage worse. */
const IRREVERSIBLE = /\b(drop\s+(column|table|type|schema)|alter\s+column\s+\S+\s+type)\b/i;

/** Migrations applied by THIS release — present now, absent from the tag being rolled back to.
 *
 * Asked of git rather than of the database: the question is what the target version's CODE
 * knows about, and the tag is what that code was. A migration this release added is one that
 * tag never carried. */
function migrationsSince(tag) {
  const dir = join(root, "services/gateway/migrations");
  const now = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  let thenList = [];
  try {
    thenList = execFileSync("git", ["ls-tree", "--name-only", `v${tag}:services/gateway/migrations`],
                            { cwd: root, encoding: "utf8" }).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    // No such tag, or no such path in it. Unknown is not "none": returning an empty list here
    // would report every destructive release as safe to roll back, which is the failure this
    // guard exists for. Treat every migration as new and let the caller decide.
    return now;
  }
  const had = new Set(thenList);
  return now.filter((f) => !had.has(f));
}

export function rollback(to) {
  // REFUSED BEFORE ANYTHING MOVES, when going back would break what is currently working.
  const added = migrationsSince(to);
  const destructive = added.filter((f) => {
    try { return IRREVERSIBLE.test(readFileSync(join(root, "services/gateway/migrations", f), "utf8")); }
    catch { return false; }
  });
  if (destructive.length) {
    die(`this release cannot be rolled back: ${destructive.join(", ")} ` +
        `${destructive.length === 1 ? "drops" : "drop"} something ${to}'s code still reads.\n` +
        `        Putting ${to} back would leave its code querying a column that no longer exists — the\n` +
        `        deployment would answer 500 to every caller while /health stayed green.\n\n` +
        `        The deployment is LEFT AS IT IS, running the new version, which is the state that\n` +
        `        currently works. Fix forward: the new code matches the new schema.\n` +
        `        To go back you must first write a migration that restores what these dropped, and\n` +
        `        decide what its values should be — which is a decision, not a rollback.`);
  }

  // WHICH DEPLOYMENT, said out loud. This is the mode most likely to be run in a hurry, and
  // it is the one where aiming at the wrong host moves a deployment nobody asked about.
  step("↩", `rolling ${HOST} back to ${to}`);
  // Set OR APPEND, and then read it back.
  //
  // This was a bare `sed -i 's/^ZZ_VERSION=.*/…/'`, which edits a line that has to already
  // be there. It is not: the compose file carries the version as a literal precisely so a
  // host needs no .env entry, and this host has none — `--verify-only` prints
  // "host ZZ_VERSION=(unset — compose literal applies)" every time it runs. So the sed
  // matched nothing, compose restarted on the SAME version, and this function reported
  // "redeployed at <to>". The rollback is what makes deploy-then-verify a safe order rather
  // than a reckless one, and it was the step that could quietly do nothing.
  ssh(`cd ${REMOTE}/deploy && ` +
      `(grep -q '^ZZ_VERSION=' .env && sed -i 's/^ZZ_VERSION=.*/ZZ_VERSION=${to}/' .env ` +
      `|| echo 'ZZ_VERSION=${to}' >> .env) && ` +
      // …and it could still, one line below its own explanation: `up -d | tail` reports
      // tail's status. The read-back underneath proves the .env line was written, which is
      // not the same claim as "the old version is running again" — if the outgoing image
      // had been pruned, compose would fail to start it and this would still say
      // "redeployed at <to>, confirmed on the host".
      `{ docker compose up -d --remove-orphans >/tmp/zz-rollback.log 2>&1 || ` +
      `{ echo "ROLLBACK UP FAILED"; tail -8 /tmp/zz-rollback.log; exit 1; }; }; tail -3 /tmp/zz-rollback.log`);
  const now = ssh(`cd ${REMOTE}/deploy && grep -oP '(?<=^ZZ_VERSION=).*' .env || echo ''`);
  if (now !== to) {
    die(`rollback did not take: the host reads ZZ_VERSION=${now || "(unset)"} after asking ` +
        `for ${to}. It is still running whatever it was running; fix the host's .env by hand.`);
  }
  log(`  redeployed at ${to}, confirmed on the host`);

  // AND THE CONSOLE, because half a rollback is the mismatch this whole order exists to
  // prevent: a new console talking to a gateway that just went backwards. Its previous
  // version is recorded on the host at deploy time for exactly this moment.
  //
  // `local` is the honest answer for a host that was last deployed by building from source,
  // and there is no image to go back to — say so rather than sed a tag that does not exist.
  const prevDash = ssh(`grep -oP '(?<=^ZZ_DASHBOARD_PREVIOUS_VERSION=).*' ${DASH_REMOTE}/.env 2>/dev/null || echo ''`).trim();
  if (!prevDash) {
    log(`  · console left alone — nothing recorded at ${DASH_REMOTE}/.env to go back to`);
  } else if (prevDash === "local") {
    log(`  ! console left alone — the version it replaced was built on the host ("local") and ` +
        `no image of it was ever published. It is still on the new version; roll it back by ` +
        `hand if the platform going backwards makes it wrong.`);
  } else {
    ssh(`cd ${DASH_REMOTE} && ` +
        `sed -i 's/^ZZ_DASHBOARD_VERSION=.*/ZZ_DASHBOARD_VERSION=${prevDash}/' .env && ` +
        `{ docker compose up -d --remove-orphans >/tmp/zz-dash-rollback.log 2>&1 || ` +
        `{ echo "CONSOLE ROLLBACK UP FAILED"; tail -8 /tmp/zz-dash-rollback.log; exit 1; }; }`);
    const nowDash = consoleImage();
    if (nowDash !== `${DASH_IMAGE}:${prevDash}`) {
      die(`the console did not roll back: it is running ${nowDash || "(nothing)"} after asking ` +
          `for ${DASH_IMAGE}:${prevDash}. The platform is back on ${to} and the console is not.`);
    }
    log(`  console redeployed at ${prevDash}`);
  }
}
