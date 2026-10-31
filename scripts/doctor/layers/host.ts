/**
 * Layer 3 — is the host running the images and the files this checkout declares?
 *
 * The layer that most often explains everything below it. If the host is a release behind,
 * every door and every contract probe will disagree with the source, correctly, and none of
 * those disagreements is a defect. The runner tags them `downstream of host` for exactly this.
 *
 * Everything here is read off the host itself. Nothing is assumed from a container name: the
 * compose project name comes from the directory, so the same stack is `zz-*` on one host and
 * `deploy-*` on another, and a literal right for one is silently wrong for the other.
 */
import { DASH_IMAGE, DASH_REMOTE, HOST, IMAGE, REMOTE, ssh } from "../../deployment.ts";
import { checkoutVersion, layer, probe } from "../run.ts";

layer("host", `is ${HOST} running what this checkout declares`, ["deploy"]);

probe("the host declares this version", () => {
  const live = ssh(`grep -oP '(?<=^ZZ_VERSION=).*' ${REMOTE}/deploy/.env 2>/dev/null || echo ''`).trim();
  if (!live) return `${REMOTE}/deploy/.env carries no ZZ_VERSION — nothing on the host names a version`;
  return live === checkoutVersion() ? null
    : `the host is on ${live}, this checkout is ${checkoutVersion()} — every layer below compares the host against ${checkoutVersion()}`;
});

probe("every declared service is up", () => {
  // From the deploy directory, so compose resolves its own project rather than this script
  // guessing the prefix. The declared list is compose's own, and `ps -a` lists stopped containers
  // too: a service with no container, or one that exited, is down whatever the others say.
  const declared = ssh(`cd ${REMOTE}/deploy && docker compose config --services`)
    .split("\n").map((l) => l.trim()).filter(Boolean);
  if (!declared.length) throw new Error(`compose at ${HOST}:${REMOTE}/deploy declares no service`);
  const state = new Map(ssh(`cd ${REMOTE}/deploy && docker compose ps -a --format '{{.Service}} {{.State}}'`)
    .split("\n").map((l) => l.trim().split(/\s+/)).filter(([s]) => s).map(([s, st]) => [s, st]));
  const down = declared.filter((s) => state.get(s) !== "running")
    .map((s) => (state.has(s) ? `${s} is ${state.get(s)}` : `${s} has no container`));
  return down.length ? down.join(", ") : null;
});

probe("the running containers carry the declared image tag", () => {
  const out = ssh(`cd ${REMOTE}/deploy && docker compose ps -q 2>/dev/null | ` +
                  `xargs -r docker inspect --format '{{.Name}} {{.Config.Image}}' || true`);
  const rows = out.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!rows.length) return "no containers to inspect";
  const ours = rows.filter((r) => r.includes(IMAGE));
  if (!ours.length) {
    return `nothing on the host is running ${IMAGE} — the platform containers are somebody else's image`;
  }
  const wrong = ours.filter((r) => !r.endsWith(`:${checkoutVersion()}`));
  return wrong.length ? `${wrong.join("; ")} — this checkout is ${checkoutVersion()}` : null;
});

probe("the console runs the image the host declares", () => {
  const want = ssh(`grep -oP '(?<=^ZZ_DASHBOARD_VERSION=).*' ${DASH_REMOTE}/.env 2>/dev/null || echo ''`).trim();
  if (!want) return null;   // not released yet; layer `doors` still asks whether it serves
  const img = ssh(`cd ${DASH_REMOTE} 2>/dev/null && docker compose ps -q console 2>/dev/null | head -1 | ` +
                  `xargs -r docker inspect --format '{{.Config.Image}}' || true`).trim();
  if (!img) return `the host declares ${want} and no console container is running`;
  return img === `${DASH_IMAGE}:${want}` ? null : `running ${img}, the host declares ${DASH_IMAGE}:${want}`;
});

// The crontab is host state a release changes by deleting files out from under it: a removed
// script leaves cron running it hourly, into a log, with nothing saying so.
probe("every scheduled job names a file that exists", () => {
  const lines = ssh("crontab -l 2>/dev/null | grep '# zz-cron' || true")
    .split("\n").map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return "no zz-cron jobs on the host — the backup is not scheduled";
  const missing = [];
  for (const line of lines) {
    const cmd = line.replace(/^(\S+\s+){5}/, "").replace(/\s*>>[\s\S]*$/, "");
    // A `cd <dir> &&` prefix is what a relative script name is relative to, and the name itself
    // can sit after an interpreter rather than right after the `&&`, as in
    // `cd <dir> && python3 job.py`.
    const cwd = /(?:^|&&\s*)cd\s+(\S+)/.exec(cmd)?.[1] ?? `${REMOTE}/deploy`;
    for (const m of cmd.matchAll(/[\w./-]*(?:\.(?:py|sh|mjs)|zz-tool)\b/g)) {
      const abs = m[0].startsWith("/") ? m[0] : `${cwd}/${m[0]}`;
      if (ssh(`test -e ${abs} && echo yes || echo no`).trim() !== "yes") missing.push(m[0]);
    }
  }
  return missing.length
    ? `the crontab runs ${missing.join(", ")}, which this version does not ship — re-run deploy/install-backup-cron.sh`
    : null;
});
