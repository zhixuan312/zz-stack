/**
 * Mirror plugins.lock.json into the registry, so a plugin version is a row somebody can join
 * against.
 *
 *   ZZ_CATALOG_OWNER_TEAM=<team> zz-tool register-plugins --psql '<command>' [--dry-run]
 *
 * ZZ_CATALOG_OWNER_TEAM names the one team every catalog plugin's ownership (FR-2, FR-47)
 * resolves to — required, and refused unset rather than defaulted, because a silent guess here
 * would hand release authority to a team nobody chose. The slug is resolved through zz.team into
 * `zz.plugin.owner_team_id`, and written as the plugin's `zz.plugin_release_owner` row; a slug no
 * team carries is refused by name before anything is written, because `owner_team_id` is a
 * foreign key and a plugin nobody owns cannot be released at all.
 *
 * A plugin's version is the platform's release version and its content moves whenever anybody edits
 * a skill inside it. Release is the one moment those two are fixed together — the gate has just
 * refused a release where the declared version and the content digest disagree — so release is the
 * only honest moment to write the pair down.
 *
 * Without these rows the evaluation has no subject: `plugin_locate` reads zz.plugin_version and
 * finds nothing, so the flow fails at its first stage with a message about a plugin that plainly
 * exists.
 *
 * The membership is the half nothing else records. zz.skill_version has no plugin column, and
 * zz.skill.flow is current registration rather than per-version, so "which version of this skill was
 * running when that event fired" otherwise resolves to whatever happened to be current at read time
 * — a wrong answer indistinguishable from a right one.
 *
 * It runs from the release script and not as a day-2 command, for the same reason register-skills
 * does: zz-tool executes inside the image, its default psql is `docker compose exec`, and there is
 * no docker in that container.
 *
 * Idempotent. Re-releasing the same version writes the same rows, and a binding already recorded
 * for the version this registration resolves is left alone. A binding that would move to another
 * version of the same skill is refused by name instead: one plugin version binds one version of a
 * skill, which is what the relation's key says and what makes a released version a stable thing to
 * evaluate.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { envRequired, optional, parseArgs } from "../lib/cli.js";
import { DEFAULT_PSQL, psqlText } from "../lib/psql.js";

interface LockEntry {
  version: string;
  digest: string;
  skills?: Record<string, string>;
}

const lit = (s: string): string => `'${String(s).replace(/'/g, "''")}'`;

/** Ours or somebody else's, and it decides what an evaluation may do with its findings: for our own
 *  plugins they feed a change, for a third party's we assess and stop. Everything in this
 *  repository's own catalog is ours by definition; a third-party plugin is registered when somebody
 *  installs one, not here. */
const ORIGIN = "platform";

/** Every statement below, with psql's `ON_ERROR_STOP`. Without it psql prints a refused statement
 *  to stderr and still exits 0, so a registration whose every write was refused reports itself
 *  finished with a count of zero — which is how 0.76.2 shipped a release with no release owners.
 *  A registration either writes the rows or says why it could not. */
const STOP_ON_ERROR = { ON_ERROR_STOP: "1" };

function main(argv: string[]): number {
  const args = parseArgs(argv, ["dry-run"]);
  const psql = args.flags.get("psql") || DEFAULT_PSQL;
  const root = optional(args, "root", "the repository root") ?? process.cwd();
  // Every catalog plugin's release-authority ownership (FR-2, FR-47): one team, named once,
  // that owns everything this repository's own catalog ships. Required rather than defaulted —
  // a silent guess here would hand release authority to a team nobody chose. Read before the
  // lock file so a missing variable fails fast, dry run included: dry run proves the release is
  // ready to run, and a run that will refuse for want of this variable is not ready.
  const ownerTeam = envRequired("ZZ_CATALOG_OWNER_TEAM",
    "the team that owns every catalog plugin — register-plugins refuses to run without it");

  const lockPath = join(root, "plugins.lock.json");
  if (!existsSync(lockPath)) {
    // Loud. An absent lock means plugin-versions.ts has not run, and writing nothing would leave
    // the evaluation with no subject while this reported success.
    console.error("\n  plugins.lock.json does not exist — run `node scripts/plugin-versions.ts --write`\n");
    return 1;
  }
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, LockEntry>;
  const names = Object.keys(lock).sort();
  if (!names.length) {
    console.error("\n  plugins.lock.json records no plugin at all — the lock was written from an empty enumeration\n");
    return 1;
  }

  let members = 0, missing = 0;
  const refusals: string[] = [];

  // The owner team, resolved once through `zz.team` and before any write. `owner_team_id` is a
  // foreign key, so a slug that names no team cannot be written at all, and a registration that
  // guessed would be handing release authority to a team nobody chose. Refused here, by name,
  // rather than at the first plugin's insert.
  if (args.flags.has("dry-run")) {
    console.log(`\n  ${names.length} plugin version(s) registered (dry run)`);
    console.log("    members recorded  0\n");
    return 0;
  }
  const teamId = psqlText(psql, `select id from zz.team where slug = ${lit(ownerTeam)}`, STOP_ON_ERROR);
  if (!teamId) {
    console.error(`\n  no team has the slug ${ownerTeam} — ZZ_CATALOG_OWNER_TEAM names the team every ` +
                  "catalog plugin's release authority resolves to, and zz.plugin.owner_team_id is a " +
                  "foreign key, so none of these plugins can be registered under it.\n");
    return 1;
  }

  for (const name of names) {
    const p = lock[name];
    // owner_team_id/plugin_release_owner (002, FR-2, FR-47): every catalog plugin is the same
    // team's to release, and that team is a relation — one `zz.plugin_release_owner` row per owner
    // team — rather than a text column and a jsonb list. A plugin registered any other way
    // (plugin_register, for a third party) never reaches these statements, so the
    // catalog-registration path stays the only writer of this row shape, the way it already is the
    // only writer of origin = 'platform'.
    //
    // The owner rows are replaced, not merely added to: the jsonb list these replaced was
    // overwritten whole on every registration, so a team this release no longer names stops being
    // an owner here too.
    psqlText(psql, `
      insert into zz.plugin (name, origin, owner_team_id)
      values (${lit(name)}, ${lit(ORIGIN)}, ${lit(teamId)}::uuid)
      on conflict (name) do update set origin = excluded.origin,
                                      owner_team_id = excluded.owner_team_id`, STOP_ON_ERROR);
    psqlText(psql, `
      insert into zz.plugin_release_owner (plugin_id, team_id)
      select id, ${lit(teamId)}::uuid from zz.plugin where name = ${lit(name)}
      on conflict (plugin_id, team_id) do nothing`, STOP_ON_ERROR);
    psqlText(psql, `
      delete from zz.plugin_release_owner
       where plugin_id = (select id from zz.plugin where name = ${lit(name)})
         and team_id <> ${lit(teamId)}::uuid`, STOP_ON_ERROR);
    // Written once, never rewritten. `plugin_version` is immutable history: a release that moves
    // a version's content is a new version, not an edit of an existing one, and the gate has
    // already refused a release whose declared version and content digest disagree — so on a
    // re-registration there is nothing here to correct, and `do nothing` is the honest no-op.
    psqlText(psql, `
      insert into zz.plugin_version (plugin_id, version, digest)
      select id, ${lit(p.version)}, ${lit(p.digest)}
        from zz.plugin where name = ${lit(name)}
      on conflict (plugin_id, version) do nothing`, STOP_ON_ERROR);
    for (const skill of Object.keys(p.skills ?? {}).sort()) {
      // Resolved by name against what register-skills wrote a moment earlier in the same release.
      // A skill the registry has not heard of is counted and reported rather than skipped: a
      // membership that is silently short is one the profile resolves events through anyway, and
      // the symptom arrives much later as "this plugin was never used".
      //
      // One version per skill per plugin version, and `(plugin_version_id, skill_id)` is the key
      // that says so. The `do update ... where` is what makes an already-recorded binding come
      // back as a row — `do nothing` returns none, which is indistinguishable from a skill the
      // registry has never heard of, and a warning that fires on the healthy path is one people
      // learn to skip — while a binding that would move to another version is left exactly as it
      // was. Moving it is not a re-registration; it is a different release of the same plugin
      // version, and the follow-up below names it.
      const out = psqlText(psql, `
        insert into zz.plugin_version_skill (plugin_version_id, skill_id, skill_version_id)
        select pv.id, sv.skill_id, sv.id
          from zz.plugin_version pv
          join zz.plugin pl on pl.id = pv.plugin_id
          join zz.skill sk on sk.name = ${lit(skill)}
          join zz.skill_version sv on sv.skill_id = sk.id
         where pl.name = ${lit(name)} and pv.version = ${lit(p.version)}
         order by sv.released_at desc limit 1
        on conflict (plugin_version_id, skill_id) do update
           set skill_version_id = zz.plugin_version_skill.skill_version_id
         where zz.plugin_version_skill.skill_version_id = excluded.skill_version_id
        returning 1`, STOP_ON_ERROR);
      if (/1/.test(out)) { members++; continue; }
      // Nothing was written. Either the registry has no version row for this skill, or this
      // plugin version already binds it and the version this registration resolves is not the one
      // bound. The second is refused by name: one plugin version binds one version of a skill, and
      // the primary key is what makes that true whatever this path does.
      const moved = psqlText(psql, `
        select bound.version || ' is bound, and ' || newest.version || ' is what this registration resolves'
          from zz.plugin_version pv
          join zz.plugin pl on pl.id = pv.plugin_id
          join zz.plugin_version_skill pvs on pvs.plugin_version_id = pv.id
          join zz.skill sk on sk.id = pvs.skill_id and sk.name = ${lit(skill)}
          join zz.skill_version bound on bound.id = pvs.skill_version_id
          join lateral (select sv.id, sv.version from zz.skill_version sv
                         where sv.skill_id = sk.id
                         order by sv.released_at desc limit 1) newest on true
         where pl.name = ${lit(name)} and pv.version = ${lit(p.version)}
           and newest.id <> bound.id`, STOP_ON_ERROR);
      if (moved) {
        refusals.push(`${name} ${p.version}: skill ${skill} — ${moved}. One plugin version binds ` +
                      "one version of a skill; cut a new plugin version instead.");
      } else missing++;
    }
  }

  console.log(`\n  ${names.length} plugin version(s) registered`);
  console.log(`    members recorded  ${members}`);
  if (missing) {
    console.log(`    members UNRESOLVED ${missing} — a skill in the lock that the registry has ` +
                "no version row for. Run register-skills first; until then the profile cannot " +
                "resolve an event to a version of that skill.");
  }
  console.log();
  if (refusals.length) {
    console.error(`  ${refusals.length} binding(s) refused:\n`);
    for (const r of refusals) console.error(`    ${r}`);
    console.error("");
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
