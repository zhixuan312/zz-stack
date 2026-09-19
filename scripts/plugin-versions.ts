#!/usr/bin/env node
/**
 * The version each PLUGIN declares, beside the hash of what it actually ships.
 *
 *   node scripts/plugin-versions.ts            # print the table
 *   node scripts/plugin-versions.ts --write    # record the current state as the baseline
 *
 * WHY THIS EXISTS, one level up from skill-versions.ts. A plugin is what a person installs —
 * `claude plugin install sdlc@zz-stack` — and its version is declared in flow.json by hand.
 * Nothing checked it: `set-version.ts` bumps every manifest in the workspace and never touches
 * `catalog/`, so a plugin's content could move under a frozen number forever.
 *
 * The argument is skill-versions.ts's own, and it is worth repeating rather than referring to:
 * the hash is not an alternative to the version. A declared version is what a person CITES —
 * "sdlc 0.2 fixed it" — and it is the only form that is orderable and arguable. It is also a
 * CLAIM. The hash is what makes the claim true: this file records both, the gate compares them,
 * and a plugin whose content changed without its version changing is refused.
 *
 * NOT THE SHELF DIGEST. `claude plugin list` shows a version like 0.31.0+1e7d702a, and every
 * plugin on the shelf carries the SAME suffix, because that digest is computed over the whole
 * shelf and includes each server's URL. It answers "what did this person receive" and is the
 * runtime's cache key. It cannot answer "what is sdlc", which is what an evaluation needs.
 *
 * ONE NUMBER PER PLUGIN. There were two: `cases_digest` covered the eval suite alone, so a
 * score could name the suite it was taken against. That suite is gone — it never measured what
 * it appeared to — and with it the second digest.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = join(root, "plugins.lock.json");

// SET BEFORE THE DYNAMIC IMPORT BELOW, not after. `@zz/catalog` reads ZZ_CATALOG_DIR into a
// module-level `const` at load time and plugin-lock.js does the same with ZZ_SKILLS_DIR and
// ZZ_EVALS_DIR, so a value assigned afterwards is a value nothing reads. build-marketplace.ts
// carries the same three lines and the same warning; this is that convention, not a new one.
//
// The defaults are the absolute paths the IMAGE has. On a laptop none of them exists, and a
// silently empty catalog would produce a lock file recording nothing, which the gate would then
// happily agree with.
process.env.ZZ_CATALOG_DIR ??= join(root, "catalog");
process.env.ZZ_SKILLS_DIR ??= join(root, "skills");
process.env.ZZ_EVALS_DIR ??= join(root, "evals");

// From the compiled gateway, because the enumeration IS the packager's own — a second
// implementation of "what does this plugin ship" would drift from the one that ships it, and
// the digest would then be a hash of something nobody installs.
const { pluginLock } = (await import(
  new URL("../services/gateway/dist/package/plugin-lock.js", import.meta.url).href
)) as typeof import("../services/gateway/dist/package/plugin-lock.js");

const entries = pluginLock(root);

// A LOUD EMPTY, because the quiet one is worse than useless. If a directory override is wrong
// the enumeration finds nothing, --write records an empty object, and the gate then compares
// nothing to nothing and passes — a green tick over a lock file that vouches for no plugin at
// all. build-marketplace.ts guards the same failure the same way, for the same reason.
if (!entries.length) {
  console.error(
    `no plugins found. ZZ_CATALOG_DIR is '${process.env.ZZ_CATALOG_DIR}' and ZZ_SKILLS_DIR is ` +
    `'${process.env.ZZ_SKILLS_DIR}' — one of them is pointing somewhere with no plugins in it.`);
  process.exit(1);
}

if (process.argv.includes("--write")) {
  const lock = Object.fromEntries(entries.map((p) => [p.name, {
    version: p.version,
    digest: p.digest,
    skills: Object.fromEntries(p.skills.map((s) => [s.name, s.sha])),
  }]));
  writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`  recorded ${entries.length} plugin(s) in plugins.lock.json`);
} else {
  /** The shape the `--write` branch above records for one plugin. */
  interface LockedPlugin {
    version: string;
    digest: string;
    skills: Record<string, string>;
  }
  const prev: Record<string, LockedPlugin> = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, "utf8")) : {};
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  console.log(`\n  ${pad("plugin", 16)}${pad("declared", 11)}${pad("digest", 10)}${pad("cases", 8)}${pad("skills", 8)}state`);
  for (const p of entries) {
    const was = prev[p.name];
    // EVERY STATE THAT IS NOT `unchanged` SAYS WHAT TO DO, IN THE IMPERATIVE. The last branch
    // used to print `0.1.0 -> 0.2.0`, which is the grammar of a changelog: it reads as "this
    // release moves the version", not as "this file is behind and you must rewrite it". It was
    // read that way, eight times in one day, by somebody who then shipped 0.33.0 with a lock
    // describing 0.32.3 — and the gate could not catch it either, so the misreading was never
    // contradicted. A tool that reports drift in the grammar of a narration will be read as a
    // narration. The fix is one line of wording and it belongs here rather than in the reader.
    const state = !was ? "new — run --write"
      : was.digest === p.digest ? "unchanged"
      : was.version === p.version
        ? "CHANGED WITHOUT A VERSION BUMP — bump flow.json, or re-run --write if the change is intended"
        : `STALE: the lock says ${was.version}, the catalog says ${p.version} — RUN --write, ` +
          "the release registers plugin versions FROM this file";
    console.log(`  ${pad(p.name, 16)}${pad(p.version, 11)}${pad(p.digest, 10)}` +
                `${pad(p.skills.length, 8)}${state}`);
  }
  console.log();
}
