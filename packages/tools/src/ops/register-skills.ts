/**
 * register-skills — put what we OFFER into the platform's own tables, from the catalog.
 *
 *   zz-tool register-skills
 *   zz-tool register-skills --psql '<command>' --dry-run
 *
 * WHY THE CATALOG IS NOT ENOUGH ON ITS OWN. The skills ship as files, and the files are the
 * source of truth for what a skill SAYS. But every question worth asking about them is a join:
 * which version produced this document, which rubric judged that version, what did it score, what
 * recurred across unrelated teams. A file cannot be joined against five thousand events.
 *
 * So the catalog stays authoritative and this mirrors its identity -- name, kind, version, content
 * hash -- into zz.skill and zz.skill_version. Nothing about the skill's TEXT is copied: the hash
 * is enough to prove which bytes a score belongs to, and the bytes themselves live where they are
 * edited.
 *
 * A SKILL'S KIND IS NOT COSMETIC. It decides what an improvement even means:
 *   flow_step    ours, sits in a flow. We edit the text directly and cut a version.
 *   plugin_skill standalone capability: a skill that is not a step of any flow's method.
 *                Ours live on the PLATFORM block: we are an MCP surface like any other,
 *                and a skill of ours is that surface's skill.
 *   plugin_skill written about a plugin's own tools. Which PLUGIN ships it is
 *                only surface is the assistant skill beside it -- and its ASSETS, which are how
 *                a guarantee gets made that prose can only request.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { manifestAt } from "@zz/catalog";
import { documentBody } from "@zz/contracts";

import { optional, parseArgs } from "../lib/cli.js";
import { DEFAULT_PSQL, psqlRows, psqlText } from "../lib/psql.js";

const SKILL_KINDS = ["flow_step", "plugin_skill"] as const;
type SkillKind = (typeof SKILL_KINDS)[number];

/** What a skill version can carry besides its own words.
 *  script     — makes a guarantee the prose can only request.
 *  reference  — a block's real quirks, quoted from refusals we actually met.
 *  tool_index — the answer to a block advertising a couple of hundred tools and hundreds of KB of schema in every prompt. */
const ASSET_KINDS = ["script", "reference", "tool_index"] as const;
type AssetKind = (typeof ASSET_KINDS)[number];

const lit = (s: string): string => `'${String(s ?? "").replace(/'/g, "''")}'`;

interface Found { name: string; kind: SkillKind; flow: string | null;
                  version: string; hash: string; bodyHash: string; dir: string }

/** sha256 of the skill BELOW its frontmatter.
 *
 *  `content_hash` covers the whole file, so it moves every time `version:` is bumped — the
 *  one edit guaranteed to accompany a version and to say nothing about the skill. Anything
 *  asking "did this actually change" got "yes" every time, which is no answer.
 *
 *  Through `documentBody`, not a regex of its own. Where a frontmatter block starts and ends
 *  is spelled once in @zz/contracts — two copies of that pattern have already disagreed about
 *  the fence, and a body hash computed from a different idea of "body" than the search index
 *  uses would be a hash of something nothing else in the platform means. */
function bodyHashOf(text: string): string {
  return createHash("sha256").update(documentBody(text)).digest("hex");
}

function field(text: string, key: string): string {
  return new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
}

/** Every flow the catalog carries, as `<skills dir>` plus the name its own manifest gives it.
 *
 *  `catalog/<team>/<flow>/flow.json` is what makes a directory a flow here — the gate reads it
 *  to check a flow declares what closes it, and the installer reads it to install one. A flow
 *  with no `skills/` beside it is skipped rather than reported — a manifest whose tools are
 *  the platform's own and whose instructions ship elsewhere is not a defect. */
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
      // manifestAt, not JSON.parse and a cast. A cast reads `gate: "false"` as a gate,
      // because a non-empty string is truthy — so the one reader that validates is the
      // only one allowed to decide what a manifest says. This tool only wants the name,
      // which makes the shortcut tempting and exactly as wrong as anywhere else.
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

/** Every SKILL.md in the tree, and what kind each one is — decided by WHERE it lives, which is
 *  the one signal that cannot be mistyped. A skill under a flow's directory is a step of that
 *  flow's method; anything else is standalone capability. Which PLUGIN ships it is
 *  `zz.plugin_version_skill`, written per release by register-plugins. */
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
        // NO THIRD KIND. A skill belongs to a flow or to a block, and ours belong to
        // the PLATFORM block — which is what migration 024 recorded when it emptied
        // A skill under a flow's directory is a step of that flow's method; anything else is
        // standalone capability. Which PLUGIN ships it is zz.plugin_version_skill, written per
        // release by register-plugins — a second copy here could only disagree with it.
        kind: flow ? "flow_step" : "plugin_skill",
        flow,
        version: field(text, "version") || "unknown",
        // The hash of the FILE, so a score can prove which bytes it belongs to. Not of the
        // parsed fields: a change to the prose is exactly the change worth detecting.
        hash: String(statSync(p).size) + "-" + text.length.toString(16),
        bodyHash: bodyHashOf(text),
        dir,
      });
    }
  };
  // EVERY flow in the catalog, DISCOVERED — not a list. This was
  //   for (const flowDir of ["catalog/<owner>/<flow>/skills"])
  // a loop over a one-element array literal, which is the shape of a list somebody meant to
  // grow and never did, and it cost what that shape always costs. casebox-assist, sdlc-flow,
  // zz-access, zz-flow-builder and zz-knowledge were installable, reachable over MCP, and
  // ABSENT FROM zz.skill — so no rubric, eval or score could attach to any of their skills,
  // while the console listed them straight from the catalog directory and looked complete.
  // A flow that cannot be scored is a flow nobody can tell is working.
  //
  // A flow is a directory with a flow.json — the same definition the gate and the installer
  // use — and its name comes from the manifest, not the directory, so the one place that
  // decides what a flow is called stays the one place.
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
    console.log("\n  No SKILL.md anywhere under the catalog, skills/ or blocks/. Nothing to register.\n");
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
    // `released_at` NAMED, not left to its default. The column decides which version
    // wrote a document older than the run link — the console reads it as a window —
    // so the moment it records has to be the moment this version became the one being
    // served, which is the first time this row is written and never again. The
    // conflict branch deliberately does not touch it: re-registering an unchanged
    // version is not a re-release, and moving the date would silently re-attribute
    // every document written before it.
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

  // WHAT THE CATALOG NO LONGER CARRIES — RETIRED, not stale, and the word matters.
  //
  // This registrar only inserts and updates, so a skill that was renamed or absorbed into
  // another stays in zz.skill. That reads like a leak, and the first version of this said so
  // and told the operator to remove one "when you are sure it is gone for good".
  //
  // THE DATABASE REFUSED, and it was right. casebox-stg-usage's version is referenced by zz.run,
  // and `doc.produced_by_run_id -> run.skill_version_id` is the chain that answers WHICH
  // VERSION WROTE THIS DOCUMENT. Deleting the row would orphan the provenance of every
  // document that skill produced — the console would fall back to the released_at "era"
  // window, and documents written by a skill that no longer exists would be attributed to
  // whichever skill happened to be current instead. Silently wrong attribution, forever.
  //
  // So a retired skill STAYS. It is not clutter; it is the only remaining record of who
  // wrote what. This reports them so nobody mistakes one for a registration that failed,
  // and deliberately does not offer to remove them.
  const names = found.map((f) => lit(f.name)).join(", ");
  // RECORDED, so no other reader has to diff the catalog to know. loop-eval's first run
  // reported five casebox skills NOT CONSULTED when casebox publishes four — the fifth was a ghost the
  // query had no way to see. One writer sets the fact; everything else reads it.
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
      // RUNS, because that is what a retired row is FOR. Reporting evals alone read as
      // "nothing is holding this" for a row whose deletion the database then refused, and
      // whose deletion would have been wrong even if it had succeeded.
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
