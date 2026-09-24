/**
 * Mirror plugins.lock.json into the registry, so a plugin version is a row somebody can join
 * against.
 *
 *   ZZ_CATALOG_OWNER_TEAM=<team> zz-tool register-plugins --psql '<command>' [--dry-run]
 *
 * ZZ_CATALOG_OWNER_TEAM names the one team every catalog plugin's ownership (FR-2, FR-47)
 * resolves to — required, and refused unset rather than defaulted, because a silent guess here
 * would hand release authority to a team nobody chose.
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
 * Idempotent. Re-releasing the same version writes the same rows.
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
  for (const name of names) {
    const p = lock[name];
    if (args.flags.has("dry-run")) continue;
    // owner_team/evolvable/release_owners (077, FR-2, FR-47): every catalog plugin is the same
    // team's to release, evolvable by construction, and its own release_owners list is just that
    // one team — a plugin registered any other way (plugin_register, for a third party) never
    // reaches this insert, so writing them here unconditionally is exactly the catalog-registration
    // path staying the only writer of this row shape, the way it already is the only writer of
    // origin = 'platform'.
    psqlText(psql, `
      insert into zz.plugin (name, origin, owner_team, evolvable, release_owners)
      values (${lit(name)}, ${lit(ORIGIN)}, ${lit(ownerTeam)}, true, ${lit(JSON.stringify([ownerTeam]))}::jsonb)
      on conflict (name) do update set origin = excluded.origin, owner_team = excluded.owner_team,
                                       evolvable = excluded.evolvable, release_owners = excluded.release_owners`);
    psqlText(psql, `
      insert into zz.plugin_version (plugin_id, version, digest)
      select id, ${lit(p.version)}, ${lit(p.digest)}
        from zz.plugin where name = ${lit(name)}
      on conflict (plugin_id, version) do update set digest = excluded.digest`);
    for (const skill of Object.keys(p.skills ?? {}).sort()) {
      // Resolved by name against what register-skills wrote a moment earlier in the same release.
      // A skill the registry has not heard of is counted and reported rather than skipped: a
      // membership that is silently short is one the profile resolves events through anyway, and
      // the symptom arrives much later as "this plugin was never used".
      //
      // `on conflict do update ... returning`, never `do nothing`. A membership that is already
      // recorded is the normal case — most releases move one plugin's version and leave the rest —
      // and `do nothing` returns no row for it, which is indistinguishable from the row this counter
      // exists to catch: a skill the registry has never heard of. A warning that fires on the
      // healthy path is one people learn to skip.
      //
      // The update is a no-op write of the key onto itself. It exists only so the row comes back, so
      // "already there" reads as recorded rather than as missing.
      const out = psqlText(psql, `
        insert into zz.plugin_version_skill (plugin_version_id, skill_version_id)
        select pv.id, sv.id
          from zz.plugin_version pv
          join zz.plugin pl on pl.id = pv.plugin_id
          join zz.skill sk on sk.name = ${lit(skill)}
          join zz.skill_version sv on sv.skill_id = sk.id
         where pl.name = ${lit(name)} and pv.version = ${lit(p.version)}
         order by sv.released_at desc limit 1
        on conflict (plugin_version_id, skill_version_id)
          do update set plugin_version_id = excluded.plugin_version_id
        returning 1`);
      if (/^\s*$/.test(out) || !/1/.test(out)) missing++; else members++;
    }
  }

  console.log(`\n  ${names.length} plugin version(s) registered${args.flags.has("dry-run") ? " (dry run)" : ""}`);
  console.log(`    members recorded  ${members}`);
  if (missing) {
    console.log(`    members UNRESOLVED ${missing} — a skill in the lock that the registry has ` +
                "no version row for. Run register-skills first; until then the profile cannot " +
                "resolve an event to a version of that skill.");
  }
  console.log();
  return 0;
}

process.exit(main(process.argv.slice(2)));
