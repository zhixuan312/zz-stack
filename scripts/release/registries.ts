/**
 * What a release writes into the registries after the stack is up — and the restart that lets the
 * platform record its own surface.
 *
 * Everything here runs after the deploy, against a database that is already serving, and none of it
 * can fail the release: a stale registry costs the ability to measure this release, and rolling a
 * good deployment back over that is the worse trade. Every step is loud and none is fatal.
 */
import { HOST, REMOTE, log, run, ssh } from "../deployment.ts";

const regPsql = `ssh ${HOST} docker compose -f ${REMOTE}/deploy/docker-compose.yml exec -T postgres psql -U zz -d zz`;

export function writeRegistries(): void {
// The registry learns what this release ships.
  //
  // zz.skill_version is what every question about a skill joins against: which version wrote this
  // document, which rubric judged it, what it scored. register-skills mirrors the catalog into it,
  // and a registry left at whatever the last person to remember put there credits every document to
  // the wrong version and makes a change unmeasurable.
  //
  // It runs here because a release is when the catalog changes, and from here because `zz-tool
  // register-skills` cannot: zz-tool executes inside the image, the tool's default psql is
  // `docker compose exec`, and there is no docker inside that container.
  //
  // Idempotent: it upserts on (skill, version), so a skill whose bytes did not move adds no row.
  try {
    const out = run("node", ["packages/tools/dist/ops/register-skills.js",
                             "--root", ".", "--psql", regPsql]);
    const registered = /(\d+) skill\(s\) registered/.exec(out)?.[1] ?? "?";
    log(`  registry updated from the catalog — ${registered} skill(s) registered`);
  } catch (e) {
    // Loud, not fatal. The platform serves correctly with a stale registry; what breaks is the
    // ability to tell one version's work from another's.
    log(`  WARNING: register-skills failed, so the registry still describes the PREVIOUS ` +
        `catalog. Evaluation and attribution will credit work to the wrong version until it ` +
        `is run: ${String(e).slice(0, 200)}`);
  }
  
  // And the plugin registry, immediately after, because its membership rows resolve against the
  // skill versions the step above just wrote. Run it first and every member is unresolved.
  //
  // zz.plugin_version is what an evaluation's subject is: without these rows plugin_locate reads an
  // empty table and the flow fails at its first stage, complaining about a plugin that plainly
  // exists.
  try {
    const out = run("node", ["packages/tools/dist/ops/register-plugins.js",
                             "--root", ".", "--psql", regPsql]);
    // Unresolved is not a statistic. Zero is the only correct value: a member is a skill version
    // this lock names, and every one was written by register-skills two steps earlier. Any other
    // number means the lock is describing a catalog that is not the one being released, so it is
    // reported as a defect rather than appended to a success line in the grammar of a count.
    const unresolved = Number(/members UNRESOLVED (\d+)/.exec(out)?.[1] ?? 0);
    if (unresolved) {
      log(`  \x1b[33mWARNING: ${unresolved} plugin member(s) UNRESOLVED — plugins.lock.json is ` +
          `describing a different catalog than the one being released, so zz.plugin_version now ` +
          `holds the PREVIOUS release's versions. Run \`node scripts/plugin-versions.ts ` +
          `--write\`, commit it, then re-run register-plugins. Nothing about the deployment is ` +
          `wrong; what is wrong is which version its work will be attributed to.\x1b[0m`);
    } else {
      log("  plugin registry updated from plugins.lock.json");
      // And only now can zz-core record its own surface. recordOwnSurface attaches the tools it
      // registered to the zz.plugin_version row for the version it is running, and refuses to invent
      // that row. The deploy above restarts zz-core before this step creates the row, so at boot the
      // version it is running is not in the registry yet, it skips, and it never runs again —
      // plugin_version rows with no plugin_tool row against them, silently.
      //
      // One restart of one service, after the row exists. The doors are stateless, so this costs a
      // few seconds of that service and nothing else.
      try {
        ssh(`cd ${REMOTE}/deploy && docker compose restart zz-core`);
        log("  zz-core restarted so it records this version's tool surface");
      } catch {
        log("  WARNING: zz-core could not be restarted, so zz.plugin_tool has no row for this " +
            "version — a surface diff will report this release as having no tools rather than as " +
            "unchanged. Restart it by hand; nothing else about the deployment is affected.");
      }
    }
  } catch (e) {
    // Loud, not fatal, for the same reason as the step above: a stale plugin registry costs the
    // ability to evaluate this release.
    log(`  WARNING: register-plugins failed, so no plugin VERSION row exists for this release. ` +
        `zz-plugin-eval will not find a subject until it is run: ${String(e).slice(0, 200)}`);
  }
}
