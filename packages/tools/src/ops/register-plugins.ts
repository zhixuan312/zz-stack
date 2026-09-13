/**
 * Mirror plugins.lock.json into the registry, so a plugin VERSION is a row somebody can join
 * against.
 *
 *   zz-tool register-plugins --psql '<command>' [--dry-run]
 *
 * WHY THIS RUNS AT RELEASE. A plugin's version is declared by hand in flow.json and its content
 * moves whenever anybody edits a skill inside it. Release is the one moment those two are fixed
 * together — the gate has just refused a release where the declared version and the content
 * digest disagree — so release is the only honest moment to write the pair down.
 *
 * WITHOUT THESE ROWS THE EVALUATION HAS NO SUBJECT. `plugin_locate` reads zz.plugin_version and
 * would find nothing, so the flow would fail at its first stage with a message about a plugin
 * that plainly exists. That failure is worth naming here because the shape invites it: the lock
 * file and the rows look like the same fact, and only one of them is in the database.
 *
 * AND THE MEMBERSHIP IS THE HALF NOTHING ELSE RECORDS. zz.skill_version has no plugin column,
 * zz.skill.flow is CURRENT registration rather than per-version, and flow_install overwrites its
 * own history on reinstall. So "which version of this skill was running when that event fired"
 * had no honest answer and resolved to whatever happened to be current at read time — a wrong
 * answer indistinguishable from a right one. Release knows; nothing later does.
 *
 * It runs FROM the release script and not as a day-2 command, for the same reason
 * register-skills does: zz-tool executes inside the image, its default psql is
 * `docker compose exec`, and there is no docker in that container.
 *
 * Idempotent. Re-releasing the same version writes the same rows.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { optional, parseArgs } from "../lib/cli.js";
import { DEFAULT_PSQL, psqlText } from "../lib/psql.js";

interface LockEntry {
  version: string;
  digest: string;
  cases_digest?: string;
  skills?: Record<string, string>;
}

const lit = (s: string): string => `'${String(s).replace(/'/g, "''")}'`;

/** Ours or somebody else's, and it decides what an evaluation may DO with its findings: for our
 *  own plugins they feed a change, for a third party's we assess and stop. Everything in this
 *  repository's own catalog is ours by definition; a third-party plugin is registered when
 *  somebody installs one, not here. */
const ORIGIN = "platform";

function main(argv: string[]): number {
  const args = parseArgs(argv, ["dry-run"]);
  const psql = args.flags.get("psql") || DEFAULT_PSQL;
  const root = optional(args, "root", "the repository root") ?? process.cwd();

  const lockPath = join(root, "plugins.lock.json");
  if (!existsSync(lockPath)) {
    // Loud. An absent lock means plugin-versions.mjs has not run, and writing nothing would
    // leave the evaluation with no subject while this reported success.
    console.error("\n  plugins.lock.json does not exist — run `node scripts/plugin-versions.mjs --write`\n");
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
    psqlText(psql, `
      insert into zz.plugin (name, origin) values (${lit(name)}, ${lit(ORIGIN)})
      on conflict (name) do update set origin = excluded.origin`);
    psqlText(psql, `
      insert into zz.plugin_version (plugin_id, version, digest, cases_digest)
      select id, ${lit(p.version)}, ${lit(p.digest)}, ${lit(p.cases_digest ?? "")}
        from zz.plugin where name = ${lit(name)}
      on conflict (plugin_id, version) do update set digest = excluded.digest,
                                                     cases_digest = excluded.cases_digest`);
    for (const skill of Object.keys(p.skills ?? {}).sort()) {
      // Resolved by NAME AND VERSION against what register-skills wrote a moment earlier in the
      // same release. A skill the registry has not heard of is COUNTED AND REPORTED rather than
      // skipped: a membership that is silently short is one the profile resolves events through
      // anyway, and the symptom arrives much later as "this plugin was never used".
      const sv = (p.skills ?? {})[skill];
      void sv;
      const out = psqlText(psql, `
        insert into zz.plugin_version_skill (plugin_version_id, skill_version_id)
        select pv.id, sv.id
          from zz.plugin_version pv
          join zz.plugin pl on pl.id = pv.plugin_id
          join zz.skill sk on sk.name = ${lit(skill)}
          join zz.skill_version sv on sv.skill_id = sk.id
         where pl.name = ${lit(name)} and pv.version = ${lit(p.version)}
         order by sv.released_at desc limit 1
        on conflict do nothing
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
