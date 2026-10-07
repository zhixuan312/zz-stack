
import { DASH_IMAGE, DASH_REMOTE, HOST, REMOTE, die, log, ssh, step } from "../deployment.ts";
import { consoleImage } from "./dashboard.ts";
import { refusalLines, rollbackGuard } from "./rollback-guard.ts";

export function rollback(to: string): void {
  // Nothing to go back to is not a failure, and it must be said before the guard below speaks.
  //
  // `previous` is read off the host's own .env, so a redeploy of the version already running asks
  // this function to roll back to the version it just deployed. That is a no-op, and without this
  // it arrives as a wall of red naming every migration that refuses a rollback.
  const current = ssh(`cd ${REMOTE}/deploy && grep -oP '(?<=^ZZ_VERSION=).*' .env || echo ''`).trim();
  if (!to || to === current) {
    log(`  · nothing to roll back to — the host was already on ${to || "(unset)"} before this ` +
        `release, so there is no earlier version recorded. The deployment is left as it is.`);
    return;
  }

  // Refused before anything moves, when going back would break what is currently working: a
  // migration since `to` that declares it, or destructive DDL — or no tag for `to`, when nothing
  // here can know what that version's code expects (rollback-guard.ts).
  const refusal = refusalLines(current || "the running version", to, rollbackGuard(to));
  if (refusal.length) die(refusal.join("\n        "));

  // Which deployment, said out loud. This is the mode most likely to be run in a hurry, and the one
  // where aiming at the wrong host moves a deployment nobody asked about.
  step("↩", `rolling ${HOST} back to ${to}`);
  // Set or append, and then read it back.
  //
  // A bare `sed -i 's/^ZZ_VERSION=.*/…/'` edits a line that has to already be there, and it is not:
  // the compose file carries the version as a literal precisely so a host needs no .env entry. The
  // sed then matches nothing, compose restarts on the same version, and the rollback reports
  // success having done nothing.
  ssh(`cd ${REMOTE}/deploy && ` +
      `(grep -q '^ZZ_VERSION=' .env && sed -i 's/^ZZ_VERSION=.*/ZZ_VERSION=${to}/' .env ` +
      `|| echo 'ZZ_VERSION=${to}' >> .env) && ` +
      // `up -d | tail` reports tail's status, so the failure is caught explicitly. The read-back
      // underneath proves the .env line was written, which is not the same claim as "the old
      // version is running again": if the outgoing image had been pruned, compose would fail to
      // start it.
      `{ docker compose up -d --remove-orphans >/tmp/zz-rollback.log 2>&1 || ` +
      `{ echo "ROLLBACK UP FAILED"; tail -8 /tmp/zz-rollback.log; exit 1; }; }; tail -3 /tmp/zz-rollback.log`);
  const now = ssh(`cd ${REMOTE}/deploy && grep -oP '(?<=^ZZ_VERSION=).*' .env || echo ''`);
  if (now !== to) {
    die(`rollback did not take: the host reads ZZ_VERSION=${now || "(unset)"} after asking ` +
        `for ${to}. It is still running whatever it was running; fix the host's .env by hand.`);
  }
  log(`  redeployed at ${to}, confirmed on the host`);

  // And the console, because half a rollback is a new console talking to a gateway that just went
  // backwards. Its previous version is recorded on the host at deploy time.
  //
  // `local` is the honest answer for a host last deployed by building from source, and there is no
  // image to go back to — say so rather than sed a tag that does not exist.
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
