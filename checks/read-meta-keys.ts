#!/usr/bin/env node
/**
 * checks/read-meta-keys.ts — the read envelope declares the marker, the observed instant and the hit
 * flag beside the six fields it carried; the cache reports its own hit through a companion; and the
 * `cached()` every existing route awaits still resolves to the bare value.
 *
 *   node checks/read-meta-keys.ts   # needs `npm run build`
 *
 * The type is erased at runtime, so the declared fields are read from the source the build copies.
 * The cache behaviours are exercised for real, with the listener up so a second read is a hit.
 *
 * Exit 0 every case held; exit 1 one failed; exit 2 the tree is not built.
 */
import { existsSync, readFileSync } from "node:fs";

const NAME = "read-meta-keys";
const CACHE = new URL("../services/gateway/dist/console/answer-cache.js", import.meta.url);
const LIVE = new URL("../services/gateway/dist/console/live-revision.js", import.meta.url);
const FIGURES = new URL("../services/gateway/src/console/figures.ts", import.meta.url);

if (!existsSync(CACHE) || !existsSync(LIVE) || !existsSync(FIGURES)) {
  console.error(`${NAME}: the tree is not built — run npm run build`);
  process.exit(2);
}

const fail: string[] = [];
const ok = (line: string) => console.log(`✓ ${line}`);

type CacheModule = {
  cached: <T>(key: string, read: () => Promise<T>) => Promise<T>;
  cachedWithHit?: <T>(key: string, read: () => Promise<T>) => Promise<{ value: T; hit: boolean }>;
};
type LiveModule = { listening: () => void };

const cache = (await import(CACHE.href)) as CacheModule;
const live = (await import(LIVE.href)) as LiveModule;

// 1. Every field the envelope must carry is declared, the six it had and the five it gains.
// The type ends at a `};` at the start of a line — not at the `};` closing an inline object such as
// `period: { from: string; to: string };`, which is what a plain indexOf would cut at.
const src = readFileSync(FIGURES, "utf8");
const from = src.indexOf("export type ReadMeta");
const body = from < 0 ? "" : src.slice(from, src.indexOf("\n};", from));
for (const field of ["asOf", "timezone", "period", "scope", "population", "coverageFrom",
  "observedAt", "revision", "builtAt", "sourceRevision", "cacheHit"]) {
  if (!new RegExp("\\b" + field + "\\??\\s*:").test(body)) fail.push(`ReadMeta does not declare ${field}`);
}
if (!fail.length) ok("ReadMeta declares the six fields it carried and the five it gains");

// 2. cached() resolves to exactly what it resolved to before: the bare value, unwrapped.
live.listening();
const plainValue = await cache.cached("read-meta-keys|plain", async () => 1);
if (plainValue !== 1) fail.push(`cached() resolved to ${JSON.stringify(plainValue)}, not the bare value it returned before`);
else ok("cached() still resolves to the bare value, so the six routes that await it need no edit");

// 3. The companion says whether it hit, and flips: one computation, then a hit.
if (typeof cache.cachedWithHit !== "function") {
  fail.push("answer-cache.js does not export cachedWithHit()");
} else {
  let computed = 0;
  const read = async () => ({ n: ++computed });
  const first = await cache.cachedWithHit("read-meta-keys|hit", read);
  const second = await cache.cachedWithHit("read-meta-keys|hit", read);
  if (first?.hit !== false || second?.hit !== true || computed !== 1) {
    fail.push(`cachedWithHit reported hit=${first?.hit} then ${second?.hit} over ${computed} computation(s), not false then true over 1`);
  } else if (second.value?.n !== first.value?.n) {
    fail.push(`cachedWithHit served ${JSON.stringify(second.value)} where it had computed ${JSON.stringify(first.value)}`);
  } else {
    ok("cachedWithHit reports its own hit: false on the computation, true on the answer it kept");
  }
}

if (fail.length) {
  for (const line of fail) console.error(`✗ ${line}`);
  process.exit(1);
}
console.log(`${NAME}: the envelope declares the marker, the observed instant and the hit; the cache reports the hit itself; and cached() is unchanged (passed)`);
