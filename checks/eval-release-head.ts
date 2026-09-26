#!/usr/bin/env node
// Which version of a plugin is released now — currentVersionOf (release-head.ts), the one reader
// plugin_locate's head and release_apply's baseline both call. A catalog plugin is at the version
// the running deployment declares, never the semver max of every row ever registered: production
// holds zz-access 2.0.0–2.3.0 from an earlier independent numbering beside 0.44.0 onwards. A
// declared version with no row is refused by name. Any other plugin keeps newest-by-semver with
// retracted versions left out. Knowledge's subject stamp reads the same version, and zz-core's
// runtime identity reports the real platform version.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// COUPLED: set before the dynamic imports — @zz/catalog reads ZZ_CATALOG_DIR into a module-level
// const at load time, the same two lines scripts/plugin-versions.ts carries.
process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");

const load = async (rel: string) => import(pathToFileURL(join(process.cwd(), "services/zz-core/dist", rel)).href);
const { currentVersionOf, currentVersion } = await load("release-head.js");
const { PLATFORM_VERSION } = await load("platform-version.js");

// The declared version is the image's own: a module placed where serviceVersion cannot find the
// manifest answers "0.0.0", and every catalog head would then be refused as unregistered.
const declared = JSON.parse(readFileSync("services/zz-core/package.json", "utf8")).version as string;
assert.equal(PLATFORM_VERSION, declared, "PLATFORM_VERSION is not zz-core's own package.json version");

// The pure rule.
assert.equal(currentVersion(["0.44.0", "2.3.0", "0.76.3"], [], "0.76.3"), "0.76.3");
assert.equal(currentVersion(["0.44.0", "2.3.0"], [], "0.76.3"), null);
assert.equal(currentVersion(["0.76.3", "0.77.0"], ["0.76.3"], "0.76.3"), "0.76.3", "a catalog plugin ignores retraction");
assert.equal(currentVersion(["1.1.0", "1.2.0", "1.10.0"], ["1.10.0"], null), "1.2.0");
assert.equal(currentVersion([], [], null), null);

/** A client answering by query text, one query in flight at a time (runner may be a PoolClient). */
function stub(plugins: Record<string, { name: string; versions: string[]; retracted?: string[] }>) {
  let inFlight = 0;
  const seen: string[] = [];
  return {
    seen,
    async query(text: string, values: unknown[] = []) {
      inFlight += 1;
      assert.equal(inFlight, 1, `two queries in flight on one client:\n${text}`);
      try {
        await new Promise((r) => setImmediate(r));
        seen.push(text);
        const p = plugins[String(values[0])];
        if (/select name from zz\.plugin where id/.test(text)) return { rows: p ? [{ name: p.name }] : [] };
        if (/select id::text as id from zz\.plugin where name/.test(text)) {
          const id = Object.keys(plugins).find((k) => plugins[k].name === values[0]);
          return { rows: id ? [{ id }] : [] };
        }
        if (/from zz\.plugin_version pv/.test(text)) return { rows: (p?.versions ?? []).map((version) => ({ version })) };
        if (/status = 'rolled_back'/.test(text)) return { rows: (p?.retracted ?? []).map((declared_version) => ({ declared_version })) };
        throw new Error(`unexpected query:\n${text}`);
      } finally {
        inFlight -= 1;
      }
    },
  };
}

const ACCESS = "10000000-0000-4000-8000-000000000001", MISSING = "10000000-0000-4000-8000-000000000002";
const RETRACTED = "10000000-0000-4000-8000-000000000003", DEMO = "10000000-0000-4000-8000-000000000004";
const EMPTY = "10000000-0000-4000-8000-000000000005", NONE = "10000000-0000-4000-8000-000000000006";
const legacy = ["2.0.0", "2.1.0", "2.2.0", "2.3.0", "0.44.0", "0.52.10"];
const client = stub({
  [ACCESS]: { name: "zz-access", versions: [...legacy, declared] },
  [MISSING]: { name: "zz-access", versions: legacy },
  [RETRACTED]: { name: "sdlc", versions: ["0.44.0", declared], retracted: [declared] },
  [DEMO]: { name: "demo", versions: ["1.1.0", "1.2.0", "2.3.0", "1.10.0"], retracted: ["2.3.0"] },
  [EMPTY]: { name: "demo", versions: [] },
});

// Rows include 2.3.0 and the catalog declares this image's version: the head is the declared one.
assert.equal(await currentVersionOf(client, ACCESS), declared);
// The declared version has no row: refused by name, never answered with 2.3.0.
await assert.rejects(currentVersionOf(client, MISSING),
  new RegExp(`zz-access ${declared.replace(/\./g, "\\.")} is not registered — [\\s\\S]*register-plugins step did not run`));
// The running deployment is the fact for a catalog plugin, retracted or not — and it never asks.
client.seen.length = 0;
assert.equal(await currentVersionOf(client, RETRACTED), declared);
assert.ok(!client.seen.some((t) => /rolled_back/.test(t)), "a catalog plugin's head read the retracted versions");
// A plugin outside the catalog: newest by semver, retracted left out — unaffected.
assert.equal(await currentVersionOf(client, DEMO), "1.10.0");
assert.equal(await currentVersionOf(client, EMPTY), null);
assert.equal(await currentVersionOf(client, NONE), null, "an unknown plugin id has no head");

// A knowledge node tagged with a catalog plugin is verified against the declared version, never
// 2.3.0 — subjectVersionFor reads through the same reader. A declared version with no row is
// `unresolved`, the function's word for a lookup that could not answer.
const { subjectVersionFor } = await load("platform-db.js");
const knowledge = stub({ [ACCESS]: { name: "zz-access", versions: [...legacy, declared] } });
assert.equal(await subjectVersionFor(["plugin:zz-access"], knowledge), declared);
assert.equal(await subjectVersionFor(["flow:zz-access"], knowledge), declared);
assert.equal(await subjectVersionFor(["plugin:zz-access"], stub({ [MISSING]: { name: "zz-access", versions: legacy } })), "unresolved");
assert.equal(await subjectVersionFor(["plugin:demo"], stub({ [DEMO]: { name: "demo", versions: ["1.9.0", "1.10.0"] } })), "1.10.0");
assert.equal(await subjectVersionFor(["plugin:nobody"], knowledge), "unresolved");
assert.equal(await subjectVersionFor([], knowledge), null);

// plugin_profile's runtime identity names zz-core at PLATFORM_VERSION. serviceVersion(import.meta.url)
// only works from a module at the root of src/ — from dist/eval/ it answers "0.0.0".
const observe = readFileSync("services/zz-core/src/eval/observe.ts", "utf8");
assert.match(observe, /"zz-core": PLATFORM_VERSION/, "observe.ts does not report zz-core at PLATFORM_VERSION");
for (const dir of ["services/zz-core/src", "services/gateway/src"]) {
  for (const f of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!f.endsWith(".ts") || !f.includes("/")) continue;
    const code = readFileSync(join(dir, f), "utf8").split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    assert.doesNotMatch(code, /serviceVersion\(import\.meta\.url\)/,
      `${dir}/${f} calls serviceVersion(import.meta.url) below src/, where it answers "0.0.0"`);
  }
}

// Every "what is released now" reader goes through it, and none keeps a head of its own.
for (const f of ["services/zz-core/src/eval/subject.ts", "services/zz-core/src/eval/release-apply.ts",
                 "services/zz-core/src/platform-db.ts"]) {
  const src = readFileSync(f, "utf8");
  assert.match(src, /await currentVersionOf\(/, `${f} does not read its head through currentVersionOf`);
  assert.doesNotMatch(src, /newestVersion\(|retractedVersions\(/, `${f} computes a head of its own`);
}

console.log("ok eval-release-head");
process.exit(0);
