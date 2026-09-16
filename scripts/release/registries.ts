/**
 * What a release writes into the registries after the stack is up — and the restart that lets
 * the platform record its own surface.
 *
 * ITS OWN MODULE because it is its own subject: everything here runs AFTER the deploy, against
 * a database that is already serving, and none of it can fail the release. A stale registry
 * costs the ability to MEASURE this release; rolling a good deployment back over that would be
 * the worse trade. So every step here is loud and none of them is fatal.
 */
import { HOST, REMOTE, log, run, ssh } from "../deployment.ts";

const regPsql = `ssh ${HOST} docker compose -f ${REMOTE}/deploy/docker-compose.yml exec -T postgres psql -U zz -d zz`;

export function writeRegistries(): void {
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
      // AND ONLY NOW CAN zz-core RECORD ITS OWN SURFACE, which is why this restart is here and
      // not a tidy-up. recordOwnSurface attaches the tools it registered to the zz.plugin_version
      // row for the version it is running, and refuses to invent that row — a version nobody
      // released has no surface to record. But the deploy above restarts zz-core BEFORE this step
      // creates the row, so at boot the version it is running is not in the registry yet, it
      // skips, and it never runs again. 0.44.0 shipped that way: four plugin_version rows and not
      // one plugin_tool row against them, silently, because the skip was the designed behaviour
      // in a situation the ordering guarantees.
      //
      // One restart of one service, after the row exists. The doors are stateless, so this costs
      // a few seconds of that service and nothing else.
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
    // ability to evaluate this release, which is a reporting failure. Rolling a good deployment
    // back over it would be the worse trade.
    log(`  WARNING: register-plugins failed, so no plugin VERSION row exists for this release. ` +
        `zz-plugin-eval will not find a subject until it is run: ${String(e).slice(0, 200)}`);
  }
}
