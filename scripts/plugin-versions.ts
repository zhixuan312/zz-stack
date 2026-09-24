#!/usr/bin/env node
/**
 * The version each plugin declares, beside the hash of what it actually ships.
 *
 *   node scripts/plugin-versions.ts            # print the table
 *   node scripts/plugin-versions.ts --write    # record the current state as the baseline
 *
 * A plugin is what a person installs — `claude plugin install sdlc@zz-stack` — and its version is
 * the platform's release version, so nothing else would stop a plugin's content moving under a
 * number between releases.
 *
 * The hash is not an alternative to the version. A declared version is what a person cites and is
 * the only orderable, arguable form; it is also a claim. The hash is what makes the claim true:
 * this file records both, the gate compares them, and a plugin whose content changed without its
 * version changing is refused.
 *
 * DELIBERATE: not the shelf digest. `claude plugin list` shows a version like 0.31.0+1e7d702a and
 * every plugin on the shelf carries the same suffix, because that digest is computed over the
 * whole shelf and includes each server's URL. It answers "what did this person receive"; it
 * cannot answer "what is sdlc".
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = join(root, "plugins.lock.json");

// COUPLED: set before the dynamic import below, not after. `@zz/catalog` reads ZZ_CATALOG_DIR
// into a module-level `const` at load time and plugin-lock.js does the same with ZZ_SKILLS_DIR, so a
// value assigned afterwards is a value nothing reads. build-marketplace.ts carries the same two
// lines.
//
// The defaults are the absolute paths the image has. On a laptop none exists, and a silently empty
// catalog would produce a lock file recording nothing that the gate would then agree with.
process.env.ZZ_CATALOG_DIR ??= join(root, "catalog");
process.env.ZZ_SKILLS_DIR ??= join(root, "skills");

// From the compiled gateway, because the enumeration is the packager's own — a second
// implementation of "what does this plugin ship" would drift from the one that ships it, and the
// digest would be a hash of something nobody installs.
const { pluginLock } = (await import(
  new URL("../services/gateway/dist/package/plugin-lock.js", import.meta.url).href
)) as typeof import("../services/gateway/dist/package/plugin-lock.js");

const entries = pluginLock(root);

// A loud empty. If a directory override is wrong the enumeration finds nothing, --write records
// an empty object, and the gate then compares nothing to nothing and passes.
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
    // Every state that is not `unchanged` says what to do, in the imperative. `0.1.0 -> 0.2.0` is
    // the grammar of a changelog: it reads as "this release moves the version", not as "this file
    // is behind and you must rewrite it".
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
