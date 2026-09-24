#!/usr/bin/env node
/**
 * build-marketplace — render the public Claude Code shelf into this repository.
 *
 * The committed marketplace is fetched by `claude plugin marketplace add zhixuan312/zz-stack`
 * with no credential. The shelf is not a boundary: every tool behind these plugins is a door
 * at the gateway, and a door still asks for the token.
 *
 * COUPLED: this does not re-implement the packaging. `buildClientPackage` is pure — catalog
 * in, files out — and the gateway's client_setup calls the same function, so the committed
 * shelf and what a person is told to install are one thing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* Compile the shipped skill scripts, before anything else touches disk
 *
 * `catalog/zz/zz-access/skills/**​/*.ts` is the one source here that leaves the machine, and
 * it is installed by people with no `tsc` of their own. Compiled to a staging directory,
 * never in place: `walkTree` in `services/gateway/src/package/plugin-lock.ts` collects every
 * file under a skill directory with no extension filter, so a `.js` emitted beside its `.ts`
 * inside `catalog/` would ship both.
 *
 * Rebuilt fresh on every invocation and first, so a compile failure aborts before anything
 * downstream reads a stale staging tree. Removing the directory also clears a previous run's
 * output, which `outDir` alone does not.
 */
const STAGING = join(root, ".marketplace-staging");
rmSync(STAGING, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.catalog.json"],
             { cwd: root, stdio: "inherit" });

// DELIBERATE: set before the dynamic imports below. `@zz/catalog` reads ZZ_CATALOG_DIR into a
// module-level `const` at load time, and client-package.js does the same with ZZ_SKILLS_DIR,
// so an assignment after the import keeps the container's paths. That failure is silent —
// `platformOwnSkills()` returns [] for a missing directory — hence the assertion at the
// bottom.
process.env.ZZ_CATALOG_DIR ??= join(root, "catalog");
process.env.ZZ_SKILLS_DIR ??= join(root, "skills");

const load = (p: string) => import(pathToFileURL(join(root, p)).href);
const { buildClientPackage } =
  (await load("services/gateway/dist/client-package.js")) as typeof import("../services/gateway/dist/client-package.js");

/** The address every `.mcp.json` on this shelf points at.
 *
 * DELIBERATE: hardcoded, not read from GATEWAY_PUBLIC_URL. That variable is a running
 * gateway's answer to "where am I reachable", and this script runs on a laptop where it is
 * unset or local, which would commit a shelf nobody else can reach.
 * COUPLED: when the deployment moves, this line and `deploy/.env` move together.
 */
const GATEWAY = "https://api.165-232-169-165.nip.io";

// `target` reaches exactly one string: the baseline plugin's description. On the gateway it
// is the person's email, which a shelf anyone can read must not publish.
const pkg = buildClientPackage({ target: "your team", base: GATEWAY });

/* Writing it out */

const SHELF = ".claude-plugin/marketplace.json";
const market = join(root, "marketplace");
const manifestDir = join(root, ".claude-plugin");

// Rebuilt, never written over the top of: a plugin the catalog has retired has to leave the
// shelf, and merging would leave it there pointing at a door that stopped answering.
rmSync(market, { recursive: true, force: true });
rmSync(manifestDir, { recursive: true, force: true });

// `buildClientPackage` reads catalog files verbatim, so `pkg.files` names these as `.ts` with
// their source as `.content`. Swapped here on the way to disk for what STAGING produced.
// COUPLED: `residentFiles` roots every skill file at `skills/…` and `tsconfig.catalog.json`'s
// `rootDir` is `catalog/zz/zz-access/skills`, so both give the same path below `skills/`.
const SHIPPED_SKILL_SCRIPT = /^(.+\/skills\/)(.+)\.ts$/;

for (const f of pkg.files) {
  if (f.path === SHELF) continue; // rewritten below — its sources have to move with it
  const compiled = SHIPPED_SKILL_SCRIPT.exec(f.path);
  const destPath = compiled ? `${compiled[1]}${compiled[2]}.js` : f.path;
  const content = compiled ? readFileSync(join(STAGING, `${compiled[2]}.js`), "utf8") : f.content;
  const dest = join(market, destPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content, { mode: f.mode ?? 0o644 });
}

// `marketplace add <repo>` reads .claude-plugin/marketplace.json at the repository root and
// resolves each `source` from there. The package writes `./zz` because it unpacks into its
// own directory; here the plugins sit under `marketplace/`, so the sources are rewritten.
/** The two fields this script rewrites — everything else in marketplace.json passes through
 *  untouched, so it is not worth naming. */
interface ShelfManifest {
  plugins: { name: string; source: string; [key: string]: unknown }[];
  [key: string]: unknown;
}
const shelfFile = pkg.files.find((f) => f.path === SHELF);
if (!shelfFile) throw new Error(`the package built no ${SHELF} — buildClientPackage should always emit it`);
const shelf: ShelfManifest = JSON.parse(shelfFile.content);
shelf.plugins = shelf.plugins.map((p) => ({ ...p, source: `./marketplace/${p.name}` }));
mkdirSync(manifestDir, { recursive: true });
writeFileSync(join(manifestDir, "marketplace.json"), JSON.stringify(shelf, null, 2) + "\n");

// Everything above succeeds with an empty skills tree, so without this a wrong ZZ_SKILLS_DIR
// commits a shelf whose required plugin carries no method.
const spine = join(market, "zz-core/skills/zz-platform/SKILL.md");
if (!existsSync(spine)) {
  throw new Error(
    `built shelf has no zz-platform skill — ZZ_SKILLS_DIR is '${process.env.ZZ_SKILLS_DIR}', ` +
    "which is not this repository's skills/ directory.");
}

console.log(`marketplace: ${shelf.plugins.length} plugins, ${pkg.files.length} files`);
for (const p of shelf.plugins) console.log(`  ${p.name.padEnd(14)} ${p.source}`);
