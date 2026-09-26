/**
 * register-skills — mirror the catalog's skill identity into the platform's own tables.
 *
 *   zz-tool register-skills
 *   zz-tool register-skills --psql '<command>' --dry-run
 *
 * The files stay the source of truth for what a skill says; this copies name, kind, version and
 * content hash into zz.skill and zz.skill_version so a skill can be joined against events. No
 * skill text is copied — the hash proves which bytes a score belongs to.
 *
 * A skill's kind decides what an improvement means:
 *   flow_step    ours, a step of a flow's method; we edit the text and cut a version.
 *   plugin_skill standalone capability, not a step of any flow's method. Which plugin ships it
 *                is zz.plugin_version_skill, written per release by register-plugins.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { manifestAt } from "@zz/catalog";
import { documentBody } from "@zz/contracts";

import { optional, parseArgs } from "../lib/cli.js";
import { DEFAULT_PSQL, psqlRows, psqlText } from "../lib/psql.js";

const SKILL_KINDS = ["flow_step", "plugin_skill"] as const;
type SkillKind = (typeof SKILL_KINDS)[number];

/** What a skill version can carry besides its own words.
 *  script     — makes a guarantee the prose can only request.
 *  reference  — a server's real quirks, quoted from refusals we actually met.
 *  tool_index — a compact index for a server that advertises hundreds of tools and hundreds of KB of schema. */
const ASSET_KINDS = ["script", "reference", "tool_index"] as const;
type AssetKind = (typeof ASSET_KINDS)[number];

const lit = (s: string): string => `'${String(s ?? "").replace(/'/g, "''")}'`;

interface Found { name: string; kind: SkillKind; flow: string | null;
                  version: string; hash: string; bodyHash: string; dir: string }

/** sha256 of the skill below its frontmatter.
 *
 *  `content_hash` covers the whole file, so it moves every time `version:` is bumped — the one
 *  edit guaranteed to accompany a version and to say nothing about the skill.
 *
 *  COUPLED: through `documentBody`, not a regex of its own. Where a frontmatter block starts and
 *  ends is spelled once in @zz/contracts, and the search index uses the same idea of "body". */
function bodyHashOf(text: string): string {
  return createHash("sha256").update(documentBody(text)).digest("hex");
}

function field(text: string, key: string): string {
  return new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
}

/** Every flow the catalog carries, as `<skills dir>` plus the name its own manifest gives it.
 *  `catalog/<team>/<flow>/flow.json` is what makes a directory a flow here. A flow with no
 *  `skills/` beside it is skipped rather than reported — a manifest whose tools are the
 *  platform's own and whose instructions ship elsewhere is not a defect. */
function flowSkillDirs(root: string): { dir: string; flow: string }[] {
  const out: { dir: string; flow: string }[] = [];
  const catalog = join(root, "catalog");
  if (!existsSync(catalog)) return out;
  for (const team of readdirSync(catalog, { withFileTypes: true })) {
    if (!team.isDirectory()) continue;
    for (const flow of readdirSync(join(catalog, team.name), { withFileTypes: true })) {
      if (!flow.isDirectory()) continue;
      const home = join(catalog, team.name, flow.name);
      const skills = join(home, "skills");
      if (!existsSync(join(home, "flow.json")) || !existsSync(skills)) continue;
      // manifestAt, not JSON.parse and a cast: a cast reads `gate: "false"` as a gate, because a
      // non-empty string is truthy. The one reader that validates decides what a manifest says,
      // even where only the name is wanted.
      const got = manifestAt(join(home, "flow.json"));
      if (!got.manifest) {
        // Skipped, but never silently: a manifest that will not parse means every skill in
        // that flow goes unregistered, and the only other symptom is an empty score page.
        console.error(`catalog: ${team.name}/${flow.name}/flow.json ${got.why}, skipping`);
        continue;
      }
      // `name` is optional in the schema, so the directory stands in — the two agree in
      // every flow shipped so far, and a manifest that omits it still has skills to register.
      out.push({ dir: skills, flow: got.manifest.name ?? flow.name });
    }
  }
  return out;
}

/** Every SKILL.md in the tree, and what kind each one is — decided by where it lives. A skill
 *  under a flow's directory is a step of that flow's method; anything else is standalone
 *  capability. Which plugin ships it is `zz.plugin_version_skill`. */
function findSkills(root: string): Found[] {
  const out: Found[] = [];
  const walk = (dir: string, flow: string | null): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p, flow); continue; }
      if (e.name !== "SKILL.md") continue;
      const text = readFileSync(p, "utf8");
      const name = field(text, "name") || dir.split("/").pop() || "";
      if (!name) continue;
      out.push({
        name,
        // No third kind. A skill under a flow's directory is a step of that flow's method;
        // anything else is standalone capability.
        kind: flow ? "flow_step" : "plugin_skill",
        flow,
        version: field(text, "version") || "unknown",
        // sha256 of the file, so a score can prove which bytes it belongs to — the same kind of
        // digest plugin_locate gives a server or a flow beside it. Not of the parsed fields: a
        // change to the prose is exactly the change worth detecting.
        hash: createHash("sha256").update(text).digest("hex"),
        bodyHash: bodyHashOf(text),
        dir,
      });
    }
  };
  // Every flow in the catalog, discovered rather than listed: a flow is a directory with a
  // flow.json, the same definition the gate and the installer use, and its name comes from the
  // manifest rather than the directory. A flow absent from zz.skill can carry no rubric, eval or
  // score, while the console lists it straight from the catalog and looks complete.
  for (const flowDir of flowSkillDirs(root)) walk(flowDir.dir, flowDir.flow);
  walk(join(root, "skills"), null);
  return out;
}

/** What sits beside a skill that is not its words. */
function assetsFor(dir: string): { kind: AssetKind; path: string }[] {
  const out: { kind: AssetKind; path: string }[] = [];
  for (const sub of ["assets", "scripts", "reference"]) {
    const d = join(dir, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      const kind: AssetKind = /tool[-_]?index/i.test(f) ? "tool_index"
        : /\.(mjs|js|ts|sh|py)$/.test(f) ? "script" : "reference";
      out.push({ kind, path: join(sub, f) });
    }
  }
  return out;
}

function main(argv: string[]): number {
  const args = parseArgs(argv, ["dry-run"]);
  const psql = args.flags.get("psql") || DEFAULT_PSQL;
  const root = optional(args, "root", "the repository root") ?? process.cwd();

  const found = findSkills(root);
  if (!found.length) {
    console.log("\n  No SKILL.md anywhere under the catalog or skills/. Nothing to register.\n");
    return 0;
  }

  let assets = 0;
  for (const s of found) {
    if (args.flags.has("dry-run")) continue;
    psqlText(psql, `
      insert into zz.skill (name, kind, flow)
      values (${lit(s.name)}, ${lit(s.kind)}, ${s.flow ? lit(s.flow) : "null"})
      on conflict (name) do update set kind = excluded.kind, flow = excluded.flow,
                                       retired = false`);
    // `released_at` named, not left to its default. The column decides which version wrote a
    // document older than the run link — the console reads it as a window — so it records the
    // first time this row is written and never again. The conflict branch does not touch it:
    // re-registering an unchanged version is not a re-release.
    psqlText(psql, `
      insert into zz.skill_version (skill_id, version, content_hash, body_hash, released_at)
      select id, ${lit(s.version)}, ${lit(s.hash)}, ${lit(s.bodyHash)}, now()
        from zz.skill where name = ${lit(s.name)}
      on conflict (skill_id, version) do update set content_hash = excluded.content_hash,
                                                    body_hash = excluded.body_hash`);
    for (const a of assetsFor(s.dir)) {
      psqlText(psql, `
        insert into zz.skill_asset (skill_version_id, kind, path)
        select sv.id, ${lit(a.kind)}, ${lit(a.path)}
          from zz.skill_version sv join zz.skill sk on sk.id = sv.skill_id
         where sk.name = ${lit(s.name)} and sv.version = ${lit(s.version)}
        on conflict (skill_version_id, path) do update set kind = excluded.kind`);
      assets++;
    }
  }

  const by = (k: SkillKind): number => found.filter((f) => f.kind === k).length;
  console.log(`\n  ${found.length} skill(s) registered${args.flags.has("dry-run") ? " (dry run)" : ""}`);
  console.log(`    flow_step   ${by("flow_step")}`);

  console.log(`    plugin_skill ${by("plugin_skill")}`);
  console.log(`    assets      ${assets}\n`);
  for (const s of found.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))) {
    console.log(`    ${s.kind.padEnd(12)} ${s.name.padEnd(20)} ${s.version}${s.flow ? `  (${s.flow})` : ""}`);
  }
  console.log("");

  // What the catalog does not carry — retired, not deleted.
  //
  // This registrar only inserts and updates, so a skill that was renamed or absorbed stays in
  // zz.skill. It has to: a version is referenced by zz.run, and
  // `doc.produced_by_run_id -> run.skill_version_id` is the chain that answers which version
  // wrote a document. Deleting the row would attribute those documents to whichever skill
  // happened to be current. They are reported so nobody mistakes one for a failed registration,
  // and never offered for removal.
  const names = found.map((f) => lit(f.name)).join(", ");
  // Recorded, so no other reader has to diff the catalog to know. One writer sets the fact;
  // everything else reads it.
  if (!args.flags.has("dry-run")) {
    psqlText(psql, `update zz.skill set retired = true where name not in (${names}) and not retired`);
  }
  const stale = psqlRows<{ name: string; kind: string; owner: string | null;
                           evals: number; runs: number }>(
    psql,
    `select s.name, s.kind, coalesce(s.flow, s.kind) as owner,
            (select count(*) from zz.eval e
               join zz.skill_version sv on sv.id = e.skill_version_id
              where sv.skill_id = s.id) as evals,
            (select count(*) from zz.run r
               join zz.skill_version sv on sv.id = r.skill_version_id
              where sv.skill_id = s.id) as runs
       from zz.skill s
      where s.name not in (${names})`,
  );
  if (stale.length) {
    console.log(`  ${stale.length} retired — in the registry, no longer in the catalog:\n`);
    for (const s of stale) {
      // Runs, because that is what a retired row is for. Reporting evals alone reads as
      // "nothing is holding this" for a row whose deletion the database would refuse.
      const held = [
        Number(s.runs) > 0 ? `${s.runs} run(s) attribute documents to it` : "",
        Number(s.evals) > 0 ? `${s.evals} eval(s)` : "",
      ].filter(Boolean).join(", ");
      console.log(`    ${s.kind.padEnd(12)} ${s.name.padEnd(20)} ${(s.owner ?? "").padEnd(10)}${held && `  — ${held}`}`);
    }
    console.log("\n  Kept on purpose: they carry the provenance of documents already written.\n");
  }
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  console.error(String((err as Error)?.message ?? err));
  process.exit(2);
}
