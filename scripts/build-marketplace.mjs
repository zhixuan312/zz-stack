#!/usr/bin/env node
/**
 * build-marketplace — render the public Claude Code shelf into this repository.
 *
 * Why this exists: the shelf used to reach people as a tarball from the gateway
 * (`GET /pkg/claude-code.tgz`), which meant nobody could install anything before they had a
 * platform token, and the first thing a new person needed the platform for was the tools
 * that talk to the platform. A marketplace committed here is fetched by `claude plugin
 * marketplace add zhixuan312/zz-stack` with no credential at all. Nothing is given away by
 * that: every tool behind these plugins is a door at the gateway, and a door still asks for
 * the token. The shelf was never the boundary — it only looked like one.
 *
 * It does NOT re-implement the packaging. `buildClientPackage` is the one function that
 * knows what a plugin directory contains, and it is pure — files in, files out — so this
 * calls it with flows read from the catalog instead of from a database, and writes the
 * result to disk instead of tarring it. A second renderer here is precisely the drift the
 * gateway's own comments keep warning about.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// SET BEFORE THE IMPORTS BELOW, not after. `@zz/catalog` reads ZZ_CATALOG_DIR into a
// module-level `const` at load time and client-package.js does the same with ZZ_SKILLS_DIR,
// so an assignment after the import keeps the container's paths — /catalog and /skills,
// neither of which exists on a laptop. That failure is silent in the direction that matters:
// `platformOwnSkills()` returns [] for a missing directory rather than throwing, so the
// baseline plugin would ship with no skills and the script would still exit 0. Hence the
// dynamic imports, and the assertion at the bottom.
process.env.ZZ_CATALOG_DIR ??= join(root, "catalog");
process.env.ZZ_SKILLS_DIR ??= join(root, "skills");
process.env.ZZ_EVALS_DIR ??= join(root, "evals");

const load = (p) => import(pathToFileURL(join(root, p)).href);
const { catalogManifest, installableFlows } = await load("packages/catalog/dist/index.js");
const { buildClientPackage } = await load("services/gateway/dist/client-package.js");
const { whenToUse } = await load("services/gateway/dist/package/skills.js");

/** The address every `.mcp.json` on this shelf points at.
 *
 * Hardcoded, and deliberately NOT read from GATEWAY_PUBLIC_URL. That variable is the
 * running gateway's answer to "where am I reachable", and this script runs on a laptop
 * where it is either unset or — worse — set to something local, which would commit a shelf
 * pointing at a machine nobody else can reach. There is one deployment; when it moves, this
 * line and `deploy/.env` move together.
 */
const GATEWAY = "https://api.165-232-169-165.nip.io";

/* ── the flows, from the catalog rather than from a database ──────── */

// Mirrors `shape()` in services/gateway/src/admin/flows.ts field for field. That function
// shapes a `flow_install` row; there is no database here, so everything comes from the
// manifest — which is what the row's own `manifest` column stores anyway.
const flows = installableFlows()
  .map((entry) => entry.split("/")[1] ?? entry)
  .map((flow) => {
    const m = catalogManifest(flow);
    if (!m) throw new Error(`catalog lists '${flow}' but has no manifest for it`);
    const entry = m.entry || flow;
    return {
      flow,
      version: m.version ?? "",
      entry,
      agentName: null,
      whenToUse: whenToUse(flow, entry),
      blocks: m.tools ?? [],
      servers: m.servers ?? [],
    };
  })
  .sort((a, b) => a.flow.localeCompare(b.flow));

// `target` reaches exactly one string: the baseline plugin's description. On the gateway it
// is the person's email, which is right for a package built for them and wrong for a shelf
// anyone can read — a marketplace card is not the place to publish an address.
const pkg = buildClientPackage({ target: "your team", base: GATEWAY, flows });

/* ── writing it out ───────────────────────────────────────────────── */

const SHELF = ".claude-plugin/marketplace.json";
const market = join(root, "marketplace");
const manifestDir = join(root, ".claude-plugin");

// REBUILT, never written over the top of. A plugin the catalog has retired has to leave the
// shelf, and merging leaves it there for ever: `zz-admin` was folded into `zz-access` at
// 0.24, and every tree that was only ever added to still offers it — pointing at a door
// that stopped answering.
rmSync(market, { recursive: true, force: true });
rmSync(manifestDir, { recursive: true, force: true });

for (const f of pkg.files) {
  if (f.path === SHELF) continue; // rewritten below — its sources have to move with it
  const dest = join(market, f.path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, f.content, { mode: f.mode ?? 0o644 });
}

// `marketplace add <repo>` reads .claude-plugin/marketplace.json at the REPOSITORY ROOT and
// resolves each `source` from there. The package writes `./zz` because it unpacks into its
// own directory; here the plugins sit one level down, so the sources say so. Keeping the
// built tree in `marketplace/` rather than scattering five plugin directories across the
// root is the whole reason this rewrite exists.
const shelf = JSON.parse(pkg.files.find((f) => f.path === SHELF).content);
shelf.plugins = shelf.plugins.map((p) => ({ ...p, source: `./marketplace/${p.name}` }));
mkdirSync(manifestDir, { recursive: true });
writeFileSync(join(manifestDir, "marketplace.json"), JSON.stringify(shelf, null, 2) + "\n");

// The one failure this script cannot see any other way. Everything above succeeds with an
// empty skills tree, so without this a wrong ZZ_SKILLS_DIR commits a shelf whose REQUIRED
// plugin carries no method — and the first person to notice is whoever installs it.
const backbone = join(market, "zz/skills/zz-backbone/SKILL.md");
if (!existsSync(backbone)) {
  throw new Error(
    `built shelf has no zz-backbone skill — ZZ_SKILLS_DIR is '${process.env.ZZ_SKILLS_DIR}', ` +
    "which is not this repository's skills/ directory.");
}

console.log(`marketplace: ${shelf.plugins.length} plugins, ${pkg.files.length} files`);
for (const p of shelf.plugins) console.log(`  ${p.name.padEnd(14)} ${p.source}`);
